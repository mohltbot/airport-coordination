// Gateway command path (plan Task 7): roles, exact schemas, CSRF/origin, 202 = QUEUED, no direct apply,
// run lifecycle guards and SSE framing. Runs in-process against the labeled dev FixtureBackend.
// The Relay leg (ledger -> outbox -> Relay -> target -> COMMAND_RESULT) is covered once the worker is
// wired; it is listed below as a todo rather than claimed.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BootstrapSchema, CommandReceiptSchema, PublicSnapshotSchema } from "../../packages/domain/src/contracts.ts"
import { AuthStore, CommandRateLimiter } from "../../server/src/auth.ts"
import { loadConfig } from "../../server/src/config.ts"
import { FixtureBackend } from "../../server/src/fixture.ts"
import { ProjectionHub } from "../../server/src/projection.ts"
import { createApp } from "../../server/src/routes.ts"

const dataDir = mkdtempSync(join(tmpdir(), "gt-api-"))
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const ORIGIN = "http://localhost:5173"
const config = loadConfig({ APP_PORT: "3000", PUBLIC_APP_ORIGIN: "https://tunnel.example.com", APP_DATA_DIR: dataDir })

let app: ReturnType<typeof createApp>
let auth: AuthStore
let hub: ProjectionHub
let backend: FixtureBackend

beforeEach(() => {
    hub?.close()
    backend = new FixtureBackend()
    hub = new ProjectionHub(backend)
    auth = new AuthStore(config.authDir)
    app = createApp({ config, backend, hub, auth, limiter: new CommandRateLimiter() })
})

const uuid = () => crypto.randomUUID()

type Session = { cookie: string; csrf: string; runId: string }

async function call(path: string, init: RequestInit & { session?: Session; csrf?: string | null } = {}) {
    const headers = new Headers(init.headers)
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
    if (!headers.has("origin") && init.method && init.method !== "GET") headers.set("origin", ORIGIN)
    if (init.session) headers.set("cookie", init.session.cookie)
    const csrf = init.csrf === undefined ? init.session?.csrf : init.csrf
    if (csrf) headers.set("x-csrf-token", csrf)
    const res = await app.fetch(new Request(`http://localhost:3000${path}`, { ...init, headers }))
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, text }
}

async function join_(role: "OPERATOR" | "CONTROLLER", runId: string | null = null): Promise<Session> {
    const { capability } = auth.mintInvite(role, runId, 60_000)
    const res = await call("/api/join", { method: "POST", body: JSON.stringify({ token: capability }) })
    expect(res.status).toBe(200)
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!
    const boot = BootstrapSchema.parse(res.body)
    return { cookie, csrf: boot.session.csrfToken!, runId: boot.activeRun!.runId }
}

const weather = (runId: string, commandId = uuid(), incidentId = uuid()) => ({
    commandId,
    runId,
    type: "INCIDENT_CREATE",
    payload: { incidentId, target: "airport:ALP", kind: "WEATHER_CLOSED", parameters: {} },
})

describe("bootstrap and join", () => {
    test("viewer bootstrap is an empty-session read of the active run", async () => {
        const res = await call("/api/bootstrap")
        const boot = BootstrapSchema.parse(res.body)
        expect(boot.session.role).toBe("VIEWER")
        expect(boot.session.csrfToken).toBeNull()
        expect(boot.activeRun).not.toBeNull()
        PublicSnapshotSchema.parse(boot.snapshot)
    })

    test("join exchanges a capability once and sets an HttpOnly Lax cookie", async () => {
        const { capability } = auth.mintInvite("OPERATOR", null, 60_000)
        const first = await call("/api/join", { method: "POST", body: JSON.stringify({ token: capability }) })
        expect(first.status).toBe(200)
        const cookie = first.headers.get("set-cookie")!
        expect(cookie).toContain("HttpOnly")
        expect(cookie).toContain("SameSite=Lax")
        expect(cookie).not.toContain("Secure") // http://localhost:5173 origin
        expect(first.body.session.role).toBe("OPERATOR")
        const again = await call("/api/join", { method: "POST", body: JSON.stringify({ token: capability }) })
        expect(again.status).toBe(401)
        expect(again.body.error.code).toBe("INVITE_INVALID")
        expect(again.body.error.retryable).toBe(false)
    })

    test("join from an https origin gets a Secure cookie; a foreign origin is refused", async () => {
        const a = auth.mintInvite("OPERATOR", null, 60_000)
        const tunnel = await call("/api/join", { method: "POST", headers: { origin: "https://tunnel.example.com" }, body: JSON.stringify({ token: a.capability }) })
        expect(tunnel.headers.get("set-cookie")).toContain("Secure")
        const b = auth.mintInvite("OPERATOR", null, 60_000)
        const evil = await call("/api/join", { method: "POST", headers: { origin: "https://evil.example.com" }, body: JSON.stringify({ token: b.capability }) })
        expect(evil.status).toBe(403)
    })

    test("expired capability is rejected", async () => {
        const { capability } = auth.mintInvite("CONTROLLER", null, -1)
        const res = await call("/api/join", { method: "POST", body: JSON.stringify({ token: capability }) })
        expect(res.status).toBe(401)
    })
})

describe("incident commands", () => {
    test("unauthenticated, missing CSRF and stale CSRF are rejected", async () => {
        const runId = (await call("/api/bootstrap")).body.activeRun.runId
        expect((await call(`/api/runs/${runId}/commands`, { method: "POST", body: JSON.stringify(weather(runId)) })).status).toBe(401)
        const op = await join_("OPERATOR")
        expect((await call(`/api/runs/${runId}/commands`, { method: "POST", session: op, csrf: null, body: JSON.stringify(weather(runId)) })).status).toBe(403)
        expect((await call(`/api/runs/${runId}/commands`, { method: "POST", session: op, csrf: "x".repeat(32), body: JSON.stringify(weather(runId)) })).status).toBe(403)
    })

    test("202 returns only the commandId; the receipt is QUEUED and the target is unchanged", async () => {
        const op = await join_("OPERATOR")
        const before = (await call(`/api/runs/${op.runId}/snapshot`)).body
        const cmd = weather(op.runId)
        const res = await call(`/api/runs/${op.runId}/commands`, { method: "POST", session: op, body: JSON.stringify(cmd) })
        expect(res.status).toBe(202)
        expect(res.body).toEqual({ commandId: cmd.commandId })
        const receipt = CommandReceiptSchema.parse((await call(`/api/runs/${op.runId}/commands/${cmd.commandId}`)).body)
        expect(receipt.status).toBe("QUEUED")
        const after = (await call(`/api/runs/${op.runId}/snapshot`)).body
        // The gateway applied nothing: ALP status and the incident list are untouched.
        expect(after.airports).toEqual(before.airports)
        expect(after.incidents).toEqual(before.incidents)
        expect(after.commands.some((c: { commandId: string }) => c.commandId === cmd.commandId)).toBe(true)
    })

    test("retry with the same body is idempotent; changed content with the same commandId conflicts", async () => {
        const op = await join_("OPERATOR")
        const cmd = weather(op.runId)
        expect((await call(`/api/runs/${op.runId}/commands`, { method: "POST", session: op, body: JSON.stringify(cmd) })).status).toBe(202)
        expect((await call(`/api/runs/${op.runId}/commands`, { method: "POST", session: op, body: JSON.stringify(cmd) })).status).toBe(202)
        const changed = { ...cmd, payload: { ...cmd.payload, target: "airport:BRV" } }
        const res = await call(`/api/runs/${op.runId}/commands`, { method: "POST", session: op, body: JSON.stringify(changed) })
        expect(res.status).toBe(409)
        expect(res.body.error.code).toBe("COMMAND_ID_CONFLICT")
    })

    test("exact schemas: extra fields, wrong target kind and runway params are 400", async () => {
        const op = await join_("OPERATOR")
        const post = (body: unknown) => call(`/api/runs/${op.runId}/commands`, { method: "POST", session: op, body: JSON.stringify(body) })
        const extra = weather(op.runId) as any
        extra.payload.priority = "EMERGENCY"
        expect((await post(extra)).status).toBe(400)
        const smokeOnAirport = { ...weather(op.runId), payload: { incidentId: uuid(), target: "airport:ALP", kind: "SMOKE", parameters: {} } }
        expect((await post(smokeOnAirport)).status).toBe(400)
        const weatherWithRunway = { ...weather(op.runId), payload: { incidentId: uuid(), target: "airport:ALP", kind: "WEATHER_CLOSED", parameters: { runwayId: "R1" } } }
        expect((await post(weatherWithRunway)).status).toBe(400)
        const sender = { ...weather(op.runId), from: "controller" }
        expect((await post(sender)).status).toBe(400)
    })

    test("wrong run: body/URL mismatch is 409, unknown run is 404", async () => {
        const op = await join_("OPERATOR")
        const other = uuid()
        expect((await call(`/api/runs/${op.runId}/commands`, { method: "POST", session: op, body: JSON.stringify(weather(other)) })).status).toBe(409)
        expect((await call(`/api/runs/${other}/commands`, { method: "POST", session: op, body: JSON.stringify(weather(other)) })).status).toBe(404)
    })

    test("controller can submit incidents but cannot reset, configure or mint invites", async () => {
        const runId = (await call("/api/bootstrap")).body.activeRun.runId
        const ctl = await join_("CONTROLLER", runId)
        expect((await call(`/api/runs/${runId}/commands`, { method: "POST", session: ctl, body: JSON.stringify(weather(runId)) })).status).toBe(202)
        expect((await call(`/api/runs/${runId}/reset`, { method: "POST", session: ctl, body: JSON.stringify({ operationId: uuid() }) })).status).toBe(403)
        expect((await call(`/api/runs/${runId}/pause`, { method: "POST", session: ctl, body: JSON.stringify({ operationId: uuid() }) })).status).toBe(403)
        expect((await call(`/api/runs/${runId}/controller-invites`, { method: "POST", session: ctl, body: "{}" })).status).toBe(403)
    })

    test("a controller session from an old run cannot touch the new run", async () => {
        const op = await join_("OPERATOR")
        const ctl = await join_("CONTROLLER", op.runId)
        const reset = await call(`/api/runs/${op.runId}/reset`, { method: "POST", session: op, body: JSON.stringify({ operationId: uuid() }) })
        expect(reset.status).toBe(200)
        const next = reset.body.runId as string
        expect(next).not.toBe(op.runId)
        expect((await call(`/api/runs/${next}/commands`, { method: "POST", session: ctl, body: JSON.stringify(weather(next)) })).status).toBe(403)
        expect((await call(`/api/runs/${op.runId}/commands`, { method: "POST", session: ctl, body: JSON.stringify(weather(op.runId)) })).status).toBe(409)
    })

    test("rate limit: six commands in one second from one session gives 429", async () => {
        const op = await join_("OPERATOR")
        const codes: number[] = []
        for (let i = 0; i < 6; i++) codes.push((await call(`/api/runs/${op.runId}/commands`, { method: "POST", session: op, body: JSON.stringify(weather(op.runId)) })).status)
        expect(codes.slice(0, 5).every(c => c === 202)).toBe(true)
        expect(codes[5]).toBe(429)
    })

    test.todo("incident commands traverse real Relay to the target actor and return COMMAND_RESULT")
})

describe("run lifecycle", () => {
    test("POST /api/runs: 409 RUN_ACTIVE while running; in place while CONFIGURING; requestId replays", async () => {
        const op = await join_("OPERATOR")
        const cfg = { flightCount: 5, seed: 20261031, speed: 10 }
        const busy = await call("/api/runs", { method: "POST", session: op, body: JSON.stringify({ requestId: uuid(), config: cfg }) })
        expect(busy.status).toBe(409)
        expect(busy.body.error.code).toBe("RUN_ACTIVE")
        const fresh = (await call(`/api/runs/${op.runId}/reset`, { method: "POST", session: op, body: JSON.stringify({ operationId: uuid() }) })).body
        expect(fresh.phase).toBe("CONFIGURING")
        const requestId = uuid()
        const a = await call("/api/runs", { method: "POST", session: op, body: JSON.stringify({ requestId, config: cfg }) })
        expect(a.status).toBe(200)
        expect(a.body.runId).toBe(fresh.runId)
        expect(a.body.config.flightCount).toBe(5)
        const b = await call("/api/runs", { method: "POST", session: op, body: JSON.stringify({ requestId, config: cfg }) })
        expect(b.body).toEqual(a.body)
        const bad = await call("/api/runs", { method: "POST", session: op, body: JSON.stringify({ requestId: uuid(), config: { ...cfg, flightCount: 31 } }) })
        expect(bad.status).toBe(400)
    })

    test("operator invites carry the public origin and a fragment token", async () => {
        const op = await join_("OPERATOR")
        const res = await call(`/api/runs/${op.runId}/controller-invites`, { method: "POST", session: op, body: "{}" })
        expect(res.status).toBe(200)
        expect(res.body.joinUrl).toMatch(/^https:\/\/tunnel\.example\.com\/join#token=[A-Za-z0-9_-]{40,}$/)
        expect(res.body.expiresAtWallMs).toBeGreaterThan(Date.now())
    })
})

describe("read model", () => {
    test("snapshots and SSE frames carry no private fields or tokens", async () => {
        const op = await join_("OPERATOR")
        const snap = await call(`/api/runs/${op.runId}/snapshot`)
        for (const word of ["inbox", "outbox", "leaseToken", "workspaceKey", "authorization", op.csrf]) expect(snap.text).not.toContain(word)
    })

    test("SSE sends a named snapshot event with id = projectionVersion immediately", async () => {
        const runId = (await call("/api/bootstrap")).body.activeRun.runId
        const ac = new AbortController()
        const res = await app.fetch(new Request(`http://localhost:3000/api/runs/${runId}/events`, { signal: ac.signal }))
        expect(res.headers.get("content-type")).toBe("text/event-stream")
        const reader = res.body!.getReader()
        let text = ""
        while (!/event: snapshot\nid: \d+\ndata: .*\n\n/.test(text)) {
            const { value, done } = await reader.read()
            if (done) break
            text += new TextDecoder().decode(value)
        }
        const frame = text.slice(text.indexOf("event: snapshot"))
        const id = Number(frame.match(/\nid: (\d+)\n/)![1])
        const data = PublicSnapshotSchema.parse(JSON.parse(frame.match(/\ndata: (.*)\n/)![1]!))
        expect(data.projectionVersion).toBe(id)
        expect(data.runId).toBe(runId)
        ac.abort()
        await reader.cancel().catch(() => {})
        await Bun.sleep(10)
        expect(hub.subscriberCount(runId)).toBe(0)
    })

    test("old-run stream emits run-reset after reset", async () => {
        const op = await join_("OPERATOR")
        const events: string[] = []
        const unsubscribe = hub.subscribe(op.runId, e => events.push(e.type))
        await Bun.sleep(50)
        await call(`/api/runs/${op.runId}/reset`, { method: "POST", session: op, body: JSON.stringify({ operationId: uuid() }) })
        await Bun.sleep(600)
        unsubscribe()
        expect(events).toContain("snapshot")
        expect(events).toContain("run-reset")
    })
})
