// Hosted Agent Relay (Relaycast REST) adapter for RelayTransport.
//
// Adapter choice, measured 2026-10-31 on https://cast.agentrelay.com/v1:
// - POST /agents registers an identity and returns its token (about 3.3 s). Lookup lags, so
//   new identities wait 2.5 s before first use.
// - POST /dm takes 7 to 12 s per send and `dm.received` events carry no recipient or metadata.
// - POST /channels/{name}/messages takes 3.3 to 4.2 s; `message.created` events return the
//   sender's agent_name and our `data` as `metadata`, 3 to 7 s later.
// So each entity keeps its own identity and token (Relay authenticates the sender), and the
// recipient handle rides in `data.to`. Each identity posts to its own one-member channel
// `<handle>-out`: on a shared run channel every post fanned out to all 3+N members and hosted
// Relay answered 429 workspace_delivery_depth_exceeded / workspace_busy at 10 flights. Nobody
// reads member inboxes; delivery is the workspace event log below, filtered to this run. @agent-relay/sdk 15.0.0-next.10 wraps the same REST calls; this adapter calls REST
// directly so the measured endpoints, idempotency header and 503 handling are explicit.
//
// Delivery: the durable path is the workspace event log, read from a persisted cursor every
// 2 s (RELAY_RECONCILE_INTERVAL_MS). The cursor only advances past events whose handlers
// finished. Optional local echo routes a message as soon as Relay accepts it and assigns an
// id (halves hop latency); the log copy then arrives as a duplicate and is ignored.
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
    entityHandle,
    type EntityRegistration,
    type ProtocolEnvelope,
    type ReceivedEnvelope,
    type RelayTransport,
} from "@ghost-tower/domain/contracts"
import { RELAY_RECONCILE_INTERVAL_MS } from "@ghost-tower/domain/constants"
import {
    RelayTransportError,
    decodeRelayMessage,
    encodeEnvelope,
    memoryCursorStore,
    runChannelName,
    type CursorStore,
    type RawRelayMessage,
    type RejectedRelayMessage,
} from "./transport.ts"

export const DEFAULT_RELAY_BASE_URL = "https://cast.agentrelay.com/v1"
const SENDER_CHANNEL_SUFFIX = "-out"
/** One-member outgoing channel per identity (handles already start with the run channel name). */
export const senderChannel = (handle: string) => `${handle}${SENDER_CHANNEL_SUFFIX}`
const LOOKUP_LAG_MS = 2_500
const REQUEST_TIMEOUT_MS = 20_000

// ---------------------------------------------------------------- token store

export type TokenRecord = { handle: string; agentId: string; token: string; channels: string[]; registeredAtWallMs: number }

export interface TokenStore {
    get(handle: string): TokenRecord | null
    put(record: TokenRecord): void
}

/** Short, non-reversible tag binding saved tokens to one workspace key. */
export const workspaceFingerprint = (workspaceKey: string) => createHash("sha256").update(workspaceKey).digest("hex").slice(0, 16)

/** Accept either the bare origin (SDK style) or the REST base; return the REST base ending in /v1. */
export function normalizeRelayBase(url: string): string {
    const u = url.trim().replace(/\/+$/, "")
    return u.endsWith("/v1") ? u : `${u}/v1`
}

type TransportSection = { version: 1; baseUrl: string; workspaceFingerprint: string; identities: Record<string, TokenRecord> }

/**
 * Server-only JSON file, mode 0600, written atomically after every registration so a crash
 * cannot lose a token. This adapter's records live under the `transport` key; every other
 * top-level key (for example the SDK probe's `baseUrl`/`workspaceId`/`agents`) is preserved, so
 * one RELAY_TOKEN_STORE_PATH can serve both. Refuses tokens bound to another base URL or workspace.
 */
export function fileTokenStore(path: string, binding: { baseUrl: string; workspaceKey: string }): TokenStore {
    const baseUrl = normalizeRelayBase(binding.baseUrl)
    const fp = workspaceFingerprint(binding.workspaceKey)
    const readFile = (): Record<string, unknown> => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {})
    const existing = readFile().transport as TransportSection | undefined
    if (existing && (normalizeRelayBase(existing.baseUrl) !== baseUrl || existing.workspaceFingerprint !== fp))
        throw new Error(`token store ${path} holds identities for another Relay workspace or base URL; move it aside or set RELAY_TOKEN_STORE_PATH`)
    const section: TransportSection = existing ?? { version: 1, baseUrl, workspaceFingerprint: fp, identities: {} }
    const save = () => {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        const tmp = `${path}.${process.pid}.tmp`
        // Re-read so a concurrent writer's other keys survive.
        writeFileSync(tmp, JSON.stringify({ ...readFile(), transport: section }, null, 2), { mode: 0o600 })
        renameSync(tmp, path)
        chmodSync(path, 0o600)
    }
    return {
        get: handle => section.identities[handle] ?? null,
        put: record => {
            section.identities[record.handle] = record
            save()
        },
    }
}

export function memoryTokenStore(): TokenStore & { size(): number } {
    const m = new Map<string, TokenRecord>()
    return { get: h => m.get(h) ?? null, put: r => void m.set(r.handle, r), size: () => m.size }
}

// ---------------------------------------------------------------- REST

type Fetch = typeof fetch

export class RelaycastRest {
    constructor(
        readonly baseUrl: string,
        private readonly fetchImpl: Fetch = fetch,
    ) {
        this.baseUrl = normalizeRelayBase(baseUrl)
    }

    async call<T = any>(path: string, opts: { method?: string; token: string; body?: unknown; idempotencyKey?: string }): Promise<T> {
        let res: Response
        try {
            res = await this.fetchImpl(this.baseUrl + path, {
                method: opts.method ?? "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${opts.token}`,
                    ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
                },
                body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
        } catch (err) {
            throw new RelayTransportError(`${opts.method ?? "POST"} ${path}: ${(err as Error).message}`, "RELAY_UNREACHABLE", true)
        }
        const json: any = await res.json().catch(() => ({}))
        if (!res.ok) {
            const code = String(json?.error?.code ?? `HTTP_${res.status}`)
            // 404 right after registration is lookup lag; 429 and 5xx (503 database_overloaded) are transient.
            const retryable = res.status === 404 || res.status === 408 || res.status === 429 || res.status >= 500
            throw new RelayTransportError(`${opts.method ?? "POST"} ${path} -> ${res.status} ${code}`, code, retryable, res.status)
        }
        return (json?.data ?? json) as T
    }
}

async function withRetry<T>(fn: () => Promise<T>, delaysMs: number[]): Promise<T> {
    for (let i = 0; ; i++) {
        try {
            return await fn()
        } catch (err) {
            const retryable = err instanceof RelayTransportError && err.retryable
            if (!retryable || i >= delaysMs.length) throw err
            await Bun.sleep(delaysMs[i]!)
        }
    }
}

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
    let i = 0
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (i < items.length) await fn(items[i++]!)
        }),
    )
}

// ---------------------------------------------------------------- adapter

export type HostedRelayOptions = {
    baseUrl: string
    workspaceKey: string
    tokenStore: TokenStore
    /** Persisted workspace-event cursor; defaults to in-memory starting at 0. */
    cursor?: CursorStore
    pollIntervalMs?: number
    /** Concurrent channel posts across all identities (RELAY_MAX_CONCURRENT_SENDS, default 4). Setup (register, channel, join) runs 2 at a time with 2/4/8/16 s backoff: hosted Relay answered 429 workspace_busy at 6. */
    maxConcurrentSends?: number
    /** Route a message as soon as Relay accepts it. The log copy is deduplicated downstream. */
    localEcho?: boolean
    registerConcurrency?: number
    fetch?: Fetch
    onRejected?: (r: RejectedRelayMessage) => void
    onError?: (where: string, err: unknown) => void
}

export type HostedRelayStats = {
    registered: number
    reconnected: number
    sent: number
    delivered: number
    rejected: number
    polls: number
    lastPollOkAtWallMs: number | null
    lastError: string | null
}

export class HostedRelayTransport implements RelayTransport {
    private readonly rest: RelaycastRest
    private readonly cursor: CursorStore
    private handlers = new Set<(m: ReceivedEnvelope) => Promise<void>>()
    private runId: string | null = null
    private channel: string | null = null
    private byHandle = new Map<string, EntityRegistration>()
    private pollTimer: ReturnType<typeof setTimeout> | null = null
    private polling: Promise<void> | null = null
    private pollGeneration = 0
    private stopped = true
    readonly stats: HostedRelayStats = { registered: 0, reconnected: 0, sent: 0, delivered: 0, rejected: 0, polls: 0, lastPollOkAtWallMs: null, lastError: null }

    constructor(private readonly opts: HostedRelayOptions) {
        this.rest = new RelaycastRest(opts.baseUrl, opts.fetch)
        this.cursor = opts.cursor ?? memoryCursorStore()
    }

    toJSON() {
        return { type: "HostedRelayTransport", baseUrl: this.opts.baseUrl, runId: this.runId, channel: this.channel }
    }

    /**
     * Reconnect saved identities, register only missing ones, join the run channel, then start
     * log reconciliation. Safe to call again after a restart: nothing already registered is re-registered.
     */
    async connect(runId: string, entities: EntityRegistration[]): Promise<void> {
        const generation = ++this.pollGeneration
        if (this.pollTimer) clearTimeout(this.pollTimer)
        this.pollTimer = null
        for (const e of entities)
            if (e.handle !== entityHandle(runId, e.entityId)) throw new Error(`handle ${e.handle} does not match ${e.entityId} for run ${runId}`)
        this.runId = runId
        this.channel = runChannelName(runId)
        this.byHandle = new Map(entities.map(e => [e.handle, e]))
        const key = this.opts.workspaceKey

        const fresh: string[] = []
        await pool(entities, this.opts.registerConcurrency ?? 2, async e => {
            if (this.opts.tokenStore.get(e.handle)) {
                this.stats.reconnected++
                return
            }
            const agent = await withRetry(() => this.register(e.handle), [2_000, 4_000, 8_000, 16_000])
            this.opts.tokenStore.put({ handle: e.handle, agentId: String(agent.id), token: agent.token, channels: [], registeredAtWallMs: Date.now() })
            this.stats.registered++
            fresh.push(e.handle)
        })
        if (fresh.length) await Bun.sleep(LOOKUP_LAG_MS)

        await pool(entities, this.opts.registerConcurrency ?? 2, async e => {
            const rec = this.opts.tokenStore.get(e.handle)!
            const channel = senderChannel(e.handle)
            if (rec.channels.includes(channel)) return
            const ok409 = (err: unknown) => {
                if (err instanceof RelayTransportError && err.status === 409) return null
                throw err
            }
            await withRetry(() => this.rest.call("/channels", { token: key, body: { name: channel, topic: `Ghost Tower ${e.entityId}` } }).catch(ok409), [2_000, 4_000, 8_000, 16_000])
            await withRetry(() => this.rest.call(`/channels/${encodeURIComponent(channel)}/join`, { token: rec.token }).catch(ok409), [2_000, 4_000, 8_000, 16_000])
            this.opts.tokenStore.put({ ...rec, channels: [...rec.channels, channel] })
        })

        if (generation !== this.pollGeneration) return
        this.stopped = false
        await this.reconcileNow()
        if (generation === this.pollGeneration) this.schedulePoll()
    }

    private async register(handle: string): Promise<{ id: string; token: string }> {
        try {
            const a: any = await this.rest.call("/agents", { token: this.opts.workspaceKey, body: { name: handle, type: "agent" } })
            const token = a.token ?? a.agent_token ?? a.api_key
            if (!token) throw new RelayTransportError("registration returned no token", "NO_TOKEN", false)
            return { id: String(a.id), token }
        } catch (err) {
            // A 503 can hide a registration that succeeded; the retry then hits name_conflict.
            // Recover with the workspace owner's token rotation (Relaycast takeover path).
            if (!(err instanceof RelayTransportError) || err.status !== 409) throw err
            const a: any = await this.rest.call(`/agents/${encodeURIComponent(handle)}/rotate-token`, { token: this.opts.workspaceKey })
            const token = a.token ?? a.agent_token ?? a.api_key
            if (!token) throw new RelayTransportError(`identity ${handle} exists and its token is not saved`, "NAME_CONFLICT", false, 409)
            return { id: String(a.id ?? a.agent_id ?? ""), token }
        }
    }

    async send(envelope: ProtocolEnvelope): Promise<{ transportMessageId: string }> {
        if (!this.runId || !this.channel) throw new RelayTransportError("transport not connected", "NOT_CONNECTED", true)
        if (envelope.runId !== this.runId) throw new RelayTransportError(`envelope for run ${envelope.runId}`, "WRONG_RUN", false)
        const { text, data } = encodeEnvelope(envelope)
        const senderHandle = entityHandle(envelope.runId, envelope.fromEntityId)
        const rec = this.byHandle.has(senderHandle) ? this.opts.tokenStore.get(senderHandle) : null
        if (!rec) throw new RelayTransportError(`no Relay identity for ${envelope.fromEntityId}`, "UNKNOWN_IDENTITY", false)
        if (!this.byHandle.has(data.to)) throw new RelayTransportError(`recipient ${envelope.toEntityId} is not in this run`, "UNKNOWN_RECIPIENT", false)

        // One bounded pool for every post (outbox sends and background DOMAIN_ACKs): unbounded
        // ACK bursts on top of six outbox sends drew 429 workspace_busy from hosted Relay.
        await this.acquireSendSlot()
        let msg: any
        try {
            msg = await this.rest.call(`/channels/${encodeURIComponent(senderChannel(senderHandle))}/messages`, {
                token: rec.token,
                body: { text, data },
                idempotencyKey: envelope.messageId,
            })
        } finally {
            this.releaseSendSlot()
        }
        const transportMessageId = String(msg?.id ?? msg?.message?.id ?? "")
        if (!transportMessageId) throw new RelayTransportError("Relay accepted the message without an id", "NO_MESSAGE_ID", true)
        this.stats.sent++

        if (this.opts.localEcho) {
            const raw: RawRelayMessage = {
                transportMessageId,
                senderHandle: String(msg?.agent_name ?? senderHandle),
                recipientHandle: data.to,
                text,
                channel: senderChannel(senderHandle),
                receivedAtWallMs: Date.now(),
                via: "echo",
            }
            // Fire and forget: the log copy is the durable path if this fails.
            void this.deliver(raw).catch(err => this.opts.onError?.("echo", err))
        }
        return { transportMessageId }
    }

    onMessage(handler: (message: ReceivedEnvelope) => Promise<void>): () => void {
        this.handlers.add(handler)
        return () => void this.handlers.delete(handler)
    }

    async disconnect(): Promise<void> {
        this.pollGeneration++
        this.stopped = true
        if (this.pollTimer) clearTimeout(this.pollTimer)
        this.pollTimer = null
        await this.polling?.catch(() => {})
    }

    private schedulePoll() {
        if (this.stopped) return
        const generation = this.pollGeneration
        this.pollTimer = setTimeout(async () => {
            await this.reconcileNow().catch(() => {})
            if (generation === this.pollGeneration) this.schedulePoll()
        }, this.opts.pollIntervalMs ?? RELAY_RECONCILE_INTERVAL_MS)
    }

    /** One reconciliation pass over the workspace event log, following pagination. */
    reconcileNow(): Promise<void> {
        if (this.polling) return this.polling
        this.polling = this.reconcile().finally(() => (this.polling = null))
        return this.polling
    }

    private async reconcile(): Promise<void> {
        const channel = this.channel
        if (!channel) return
        const limit = 100
        try {
            for (let page = 0; page < 50; page++) {
                const since = await this.cursor.load()
                const data: any = await this.rest.call(`/workspace/events?since=${since}&limit=${limit}`, { method: "GET", token: this.opts.workspaceKey })
                this.stats.polls++
                const events: any[] = data?.events ?? []
                let last = since
                for (const ev of events) {
                    const seq = Number(ev.seq)
                    if (ev.type === "message.created" && this.isRunChannel(ev.payload?.channel)) {
                        const m = ev.payload.message ?? {}
                        // A handler failure throws here and leaves the cursor before this event.
                        await this.deliver({
                            transportMessageId: String(m.id),
                            senderHandle: String(m.agent_name ?? ""),
                            recipientHandle: typeof m.metadata?.to === "string" ? m.metadata.to : null,
                            text: String(m.text ?? ""),
                            channel: String(ev.payload.channel),
                            receivedAtWallMs: Date.now(),
                            via: "poll",
                        })
                    }
                    if (Number.isFinite(seq) && seq > last) {
                        last = seq
                        await this.cursor.save(last)
                    }
                }
                if (!events.length) {
                    const head = Number(data?.next_since ?? data?.latest_seq ?? since)
                    if (Number.isFinite(head) && head > since) await this.cursor.save(head)
                }
                this.stats.lastPollOkAtWallMs = Date.now()
                if (events.length < limit) break
            }
        } catch (err) {
            this.stats.lastError = (err as Error).message
            this.opts.onError?.("reconcile", err)
        }
    }

    private sendsInFlight = 0
    private sendWaiters: Array<() => void> = []
    private async acquireSendSlot(): Promise<void> {
        const max = this.opts.maxConcurrentSends ?? 4
        if (this.sendsInFlight < max) {
            this.sendsInFlight++
            return
        }
        await new Promise<void>(resolve => this.sendWaiters.push(resolve))
    }
    private releaseSendSlot() {
        const next = this.sendWaiters.shift()
        if (next) next() // the slot passes straight to the next waiter
        else this.sendsInFlight--
    }

    /** The run's sender channels, plus the old shared run channel for messages already in flight. */
    private isRunChannel(name: unknown): boolean {
        if (typeof name !== "string" || !this.channel) return false
        if (name === this.channel) return true
        return name.endsWith(SENDER_CHANNEL_SUFFIX) && this.byHandle.has(name.slice(0, -SENDER_CHANNEL_SUFFIX.length))
    }

    private async deliver(raw: RawRelayMessage) {
        if (!this.runId) return
        const decoded = decodeRelayMessage(raw, this.runId)
        if (!decoded.ok) {
            this.stats.rejected++
            this.opts.onRejected?.({ raw, code: decoded.code, detail: decoded.detail, messageId: decoded.messageId })
            return
        }
        for (const h of this.handlers) await h(decoded.message)
        this.stats.delivered++
    }

    /** Redacted readiness for /api/health and the public snapshot. */
    health(nowMs = Date.now()): { status: "READY" | "DEGRADED" | "UNAVAILABLE"; detail: string | null } {
        if (this.stopped || !this.runId) return { status: "UNAVAILABLE", detail: "not connected" }
        const age = this.stats.lastPollOkAtWallMs === null ? Infinity : nowMs - this.stats.lastPollOkAtWallMs
        if (age > 15_000) return { status: "DEGRADED", detail: `event log not read for ${Number.isFinite(age) ? Math.round(age / 1000) + " s" : "ever"}` }
        return { status: "READY", detail: null }
    }
}

/** Build the adapter from environment names in .env.example. */
export function hostedRelayFromEnv(env: Record<string, string | undefined> = process.env, extra: Partial<HostedRelayOptions> = {}): HostedRelayTransport {
    const baseUrl = env.RELAY_BASE_URL || env.RELAY_BASE || DEFAULT_RELAY_BASE_URL
    const workspaceKey = env.RELAY_WORKSPACE_KEY
    if (!workspaceKey) throw new Error("RELAY_WORKSPACE_KEY is not set; run `bun scripts/bootstrap-relay.ts`")
    const storePath = env.RELAY_TOKEN_STORE_PATH || ".data/relay-tokens.json"
    return new HostedRelayTransport({
        baseUrl,
        workspaceKey,
        tokenStore: fileTokenStore(storePath, { baseUrl, workspaceKey }),
        localEcho: env.RELAY_LOCAL_ECHO !== "0",
        maxConcurrentSends: Number(env.RELAY_MAX_CONCURRENT_SENDS) > 0 ? Number(env.RELAY_MAX_CONCURRENT_SENDS) : 4,
        ...extra,
    })
}
