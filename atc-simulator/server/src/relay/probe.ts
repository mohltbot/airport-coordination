// Relay probe helpers for tests/integration/relay.test.ts (Task 1, Relay half).
// Never log secret values: every error string goes through redact().
import { AgentRelay } from "@agent-relay/sdk"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export { AgentRelay }

export const PROJECT_DIR = resolve(import.meta.dir, "../../..")
export const ENV_PATH = join(PROJECT_DIR, ".env")
export const TOKENS_PATH = join(PROJECT_DIR, ".data/relay-tokens.json")
// The SDK appends /v1 to every REST path and derives the WebSocket URL as <base>/v1/ws,
// so it takes the bare origin. Raw REST calls use the /v1 base.
export const SDK_BASE_URL = "https://cast.agentrelay.com"
export const REST_BASE = "https://cast.agentrelay.com/v1"

const secrets = new Set<string>()
export function trackSecret(value: string | undefined) {
    if (value && value.length >= 8) secrets.add(value)
}
export function knownSecrets(): string[] {
    return [...secrets]
}
export function redact(text: string): string {
    let out = text
    for (const s of secrets) out = out.split(s).join("<redacted>")
    return out.replace(/\b(rk|at|ot|ak)_(live|test)_[A-Za-z0-9_-]+/g, "<redacted>")
}
export function errorSummary(err: unknown): string {
    const e = err as any
    const parts = [e?.name, e?.status ?? e?.statusCode, e?.code, e?.message].filter(v => v !== undefined && v !== "")
    return redact(parts.join(" ").slice(0, 400))
}

export function readEnv(): Record<string, string> {
    if (!existsSync(ENV_PATH)) return {}
    const env: Record<string, string> = {}
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
        if (m) env[m[1]] = m[2]
    }
    return env
}

function isRetryable(status: number | undefined, body: string): boolean {
    return status === 503 || status === 502 || status === 429 || /database_overloaded|overloaded/i.test(body)
}

export async function rest(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<any> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(REST_BASE + path, {
            method,
            headers: {
                "content-type": "application/json",
                ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        })
        const text = await res.text()
        if (res.ok) return JSON.parse(text)
        if (attempt < 5 && isRetryable(res.status, text)) {
            await Bun.sleep(500 * 2 ** attempt)
            continue
        }
        throw new Error(redact(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`))
    }
}

/** Retry an SDK call on 503/overloaded with backoff. Safe for sends that carry an idempotency key. */
export async function withRetry<T>(fn: () => Promise<T>, retries: { count: number } = { count: 0 }): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn()
        } catch (err) {
            const e = err as any
            const status = e?.status ?? e?.statusCode
            if (attempt < 5 && isRetryable(status, `${e?.code ?? ""} ${e?.message ?? ""}`)) {
                retries.count++
                await Bun.sleep(500 * 2 ** attempt)
                continue
            }
            throw new Error(errorSummary(err))
        }
    }
}

/** Create the dedicated ghost-tower workspace once and append its key to .env (mode 600). */
export async function ensureWorkspace(): Promise<{ key: string; workspaceId?: string; created: boolean }> {
    const env = readEnv()
    if (env.RELAY_WORKSPACE_KEY) {
        trackSecret(env.RELAY_WORKSPACE_KEY)
        return { key: env.RELAY_WORKSPACE_KEY, workspaceId: env.RELAY_WORKSPACE_ID, created: false }
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
    const json = await rest("POST", "/workspaces", { body: { name: `ghost-tower-${stamp}`, provenance: { source: "api" } } })
    const key: string = json.data.api_key
    const workspaceId: string | undefined = json.data.workspace_id
    if (!key) throw new Error(`no api_key on workspace response; fields: ${Object.keys(json.data).join(", ")}`)
    trackSecret(key)
    const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : ""
    const lines = [`RELAY_WORKSPACE_KEY=${key}`, ...(workspaceId ? [`RELAY_WORKSPACE_ID=${workspaceId}`] : [])]
    appendFileSync(ENV_PATH, (existing === "" || existing.endsWith("\n") ? "" : "\n") + lines.join("\n") + "\n")
    chmodSync(ENV_PATH, 0o600)
    return { key, workspaceId, created: true }
}

export type TokenStore = { baseUrl: string; workspaceId?: string; agents: Record<string, string> }

export function readTokens(): TokenStore | null {
    if (!existsSync(TOKENS_PATH)) return null
    const store = JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as TokenStore
    for (const t of Object.values(store.agents ?? {})) trackSecret(t)
    return store
}

export function writeTokens(store: TokenStore) {
    mkdirSync(dirname(TOKENS_PATH), { recursive: true, mode: 0o700 })
    writeFileSync(TOKENS_PATH, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
    chmodSync(TOKENS_PATH, 0o600)
}

export function relayFor(workspaceKey: string): AgentRelay {
    return new AgentRelay({
        workspaceKey,
        baseUrl: SDK_BASE_URL,
        onError: (err, ctx) => console.warn("[relay handler error]", ctx.source, ctx.selector ?? ctx.action, errorSummary(err)),
    })
}

/** Resolve once the relay's fan-in reports a live socket, or after `ms` (returns false). */
export function waitConnected(relay: AgentRelay, ms = 15_000): Promise<boolean> {
    return new Promise(done => {
        const timer = setTimeout(() => {
            off()
            done(false)
        }, ms)
        const off = relay.events.on("connected", () => {
            clearTimeout(timer)
            off()
            done(true)
        })
        relay.events.connect()
    })
}

export type EventPage = { events: any[]; latest_seq?: number; next_since?: number; keys: string[] }

/** GET /v1/workspace/events?since=<seq>&limit=<n> with the workspace key. */
export async function eventPage(workspaceKey: string, since: number, limit: number): Promise<EventPage> {
    const json = await rest("GET", `/workspace/events?since=${since}&limit=${limit}`, { token: workspaceKey })
    const data = json.data ?? {}
    return { events: data.events ?? [], latest_seq: data.latest_seq, next_since: data.next_since, keys: Object.keys(data) }
}

/**
 * Walk the durable event log from `since` in pages of `limit` until an event whose
 * JSON contains `marker` appears, or `timeoutMs` passes. Returns every match plus
 * the paging trace (seq monotonicity, cursors).
 */
export async function findInEventLog(
    workspaceKey: string,
    marker: string,
    opts: { since: number; limit: number; timeoutMs: number; minMatches?: number; settleMs?: number },
) {
    const started = performance.now()
    let cursor = opts.since
    let pages = 0
    let lastSeq = opts.since
    let monotonic = true
    const cursors: number[] = []
    const matches: any[] = []
    let foundAt: number | undefined
    let pageKeys: string[] = []
    while (performance.now() - started < opts.timeoutMs) {
        const page = await eventPage(workspaceKey, cursor, opts.limit)
        pages++
        pageKeys = page.keys
        for (const ev of page.events) {
            if (typeof ev.seq === "number") {
                if (ev.seq <= lastSeq) monotonic = false
                lastSeq = ev.seq
            }
            if (JSON.stringify(ev).includes(marker)) {
                matches.push(ev)
                foundAt ??= performance.now() - started
            }
        }
        const next = page.next_since ?? (page.events.length ? page.events[page.events.length - 1].seq : undefined) ?? cursor
        cursors.push(next)
        const caughtUp = page.events.length < opts.limit || (page.latest_seq !== undefined && next >= page.latest_seq)
        cursor = Math.max(cursor, next)
        if (matches.length >= (opts.minMatches ?? 1) && caughtUp) {
            if (!opts.settleMs || performance.now() - started - (foundAt ?? 0) >= opts.settleMs) break
        }
        if (caughtUp) await Bun.sleep(1000)
    }
    return { matches, foundAtMs: foundAt, pages, cursors, monotonic, finalCursor: cursor, pageKeys }
}
