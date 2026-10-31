// Task 5: Relay transport, router and outbox.
//   bun test tests/integration/relay.test.ts                 contract tests, no network
//   RELAY_LIVE=1 bun test tests/integration/relay.test.ts    plus the hosted Relay round trip
// The live test creates its own throwaway Relaycast workspace, so it never touches the team's
// coding-agent workspace or the demo workspace in .env.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    entityHandle,
    type DomainResult,
    type EntityId,
    type OutboxEntry,
    type ProtocolEnvelope,
    type ReceivedEnvelope,
} from "../../packages/domain/src/contracts.ts"
import { RELAY_TIMING } from "../../packages/domain/src/constants.ts"
import { DEFAULT_RELAY_BASE_URL, HostedRelayTransport, RelaycastRest, fileTokenStore } from "../../server/src/relay/agent-relay.ts"
import { dispatchDueOutboxes, selectDue } from "../../server/src/relay/outbox.ts"
import { attachRouter, buildDomainAck, commandProof, routeReceived, type RouteEvent, type RouterContext } from "../../server/src/relay/router.ts"
import {
    LoopbackRelayTransport,
    memoryCursorStore,
    registrationsFor,
    runChannelName,
    type EntityInboxPort,
    type OutboxPort,
    type RejectedRelayMessage,
} from "../../server/src/relay/transport.ts"

// ---------------------------------------------------------------- helpers

/** Actor-inbox stand-in with the actor contract: dedup by (runId, messageId), stored result replayed. */
class MemoryInbox implements EntityInboxPort {
    readonly received = new Map<string, ReceivedEnvelope>() // `${entityId}|${messageId}`
    readonly effects = new Map<string, number>()
    readonly duplicates = new Map<string, number>()
    private stored = new Map<string, DomainResult & { outcome: "APPLIED" | "REJECTED" }>()
    private rev = new Map<string, number>()
    async receive(entityId: EntityId, m: ReceivedEnvelope): Promise<DomainResult> {
        const key = `${m.runId}|${m.messageId}`
        const prior = this.stored.get(key)
        if (prior) {
            this.duplicates.set(m.messageId, (this.duplicates.get(m.messageId) ?? 0) + 1)
            return { outcome: "DUPLICATE", code: prior.code, stateRevision: prior.stateRevision, original: prior }
        }
        const r = (this.rev.get(entityId) ?? 0) + 1
        this.rev.set(entityId, r)
        const result = { outcome: "APPLIED" as const, code: "OK", stateRevision: r }
        this.stored.set(key, result)
        this.received.set(`${entityId}|${m.messageId}`, m)
        this.effects.set(m.messageId, (this.effects.get(m.messageId) ?? 0) + 1)
        return result
    }
    find(entityId: EntityId, pred: (m: ReceivedEnvelope) => boolean) {
        for (const [k, m] of this.received) if (k.startsWith(`${entityId}|`) && pred(m)) return m
        return null
    }
}

const RUN = crypto.randomUUID()
const F001 = "flight:F001" as const
const F002 = "flight:F002" as const
const ALP = "airport:ALP" as const

function landingRequest(runId: string, from: `flight:${string}` = F001, flightId = "F001"): ProtocolEnvelope {
    return {
        schemaVersion: 1,
        messageId: crypto.randomUUID(),
        runId,
        fromEntityId: from,
        toEntityId: ALP,
        type: "LANDING_REQUEST",
        correlationId: "neg-1",
        causationId: null,
        createdAtWallMs: Date.now(),
        expiresAtWallMs: null,
        payload: {
            negotiationId: "neg-1",
            flightId,
            flightDecisionRevision: 1,
            position: { x: 70, y: 60 },
            speedKnots: 240,
            fuelRemainingSec: 3600,
            sampledAtSimSec: 0,
            priority: "NORMAL",
            deadlineSimSec: null,
        },
    }
}

function incident(runId: string, seq: number, kind: "INCIDENT_CREATE" | "INCIDENT_CLEAR", secret = "s"): ProtocolEnvelope {
    const commandId = crypto.randomUUID()
    const incidentId = "6f9c1d2e-0a4b-4c8d-9e7f-123456789abc"
    const base = {
        schemaVersion: 1 as const,
        messageId: crypto.randomUUID(),
        runId,
        fromEntityId: "controller" as const,
        toEntityId: ALP,
        correlationId: commandId,
        causationId: null,
        createdAtWallMs: Date.now(),
        expiresAtWallMs: Date.now() + 60_000,
        commandId,
        commandSequence: seq,
        authorization: commandProof(secret, { runId, commandId, commandSequence: seq, toEntityId: ALP, type: kind, incidentId }),
    }
    return kind === "INCIDENT_CREATE"
        ? { ...base, type: kind, payload: { incidentId, target: ALP, kind: "WEATHER_CLOSED", parameters: {} } }
        : { ...base, type: kind, payload: { incidentId, target: ALP, expectedIncidentRevision: 1 } }
}

async function waitFor<T>(what: string, fn: () => T | null | undefined | false, timeoutMs: number): Promise<T> {
    const end = Date.now() + timeoutMs
    for (;;) {
        const v = fn()
        if (v) return v
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
        await Bun.sleep(100)
    }
}

// ---------------------------------------------------------------- contract tests (no network)

describe("relay contract (loopback)", () => {
    const entities: EntityId[] = ["controller", ALP, F001, F002]
    const registry = registrationsFor(RUN, entities)

    async function setup(extra: Partial<RouterContext> = {}) {
        const transport = new LoopbackRelayTransport()
        await transport.connect(RUN, registry)
        const inbox = new MemoryInbox()
        const events: RouteEvent[] = []
        const ctx: RouterContext = { runId: RUN, registry, inbox, transport, log: e => events.push(e), ackMode: "await", ...extra }
        transport.onMessage(m => routeReceived(m, ctx).then(() => {}))
        return { transport, inbox, events, ctx }
    }

    test("typed message reaches the recipient inbox with the authenticated sender, and is ACKed back", async () => {
        const { transport, inbox } = await setup()
        const env = landingRequest(RUN)
        const { transportMessageId } = await transport.send(env)
        const got = inbox.find(ALP, m => m.messageId === env.messageId)!
        expect(got.senderHandle).toBe(entityHandle(RUN, F001))
        expect(got.transportMessageId).toBe(transportMessageId)
        expect(got.type).toBe("LANDING_REQUEST")
        expect(got.correlationId).toBe(env.correlationId) // thread key unchanged end to end
        expect(JSON.parse(transport.sent[0]!.text).correlationId).toBe(env.correlationId)
        const ack = inbox.find(F001, m => m.type === "DOMAIN_ACK")!
        expect(ack.type === "DOMAIN_ACK" && ack.payload.processedMessageId).toBe(env.messageId)
        expect(ack.correlationId).toBe(env.correlationId) // ACK stays in the same thread
        expect(ack.causationId).toBe(env.messageId)
        expect(ack.senderHandle).toBe(entityHandle(RUN, ALP))
        expect(inbox.find(ALP, m => m.type === "DOMAIN_ACK")).toBeNull() // ACKs are not ACKed
    })

    test("replayed message ID produces one effect even with a different transport ID", async () => {
        const { transport, inbox } = await setup()
        const env = landingRequest(RUN)
        const a = await transport.send(env)
        const b = await transport.send(env) // loopback assigns a new transport ID each time
        expect(a.transportMessageId).not.toBe(b.transportMessageId)
        expect(inbox.effects.get(env.messageId)).toBe(1)
        expect(inbox.duplicates.get(env.messageId)).toBe(1)
        // Each delivery reissues the same deterministic ACK message ID.
        expect(buildDomainAck({ ...env, transportMessageId: "x", senderHandle: "", recipientHandle: "", receivedAtWallMs: 0 } as ReceivedEnvelope, "OK", 1).messageId).toBe(
            buildDomainAck({ ...env, transportMessageId: "y", senderHandle: "", recipientHandle: "", receivedAtWallMs: 0 } as ReceivedEnvelope, "OK", 2).messageId,
        )
    })

    test("sender handle that does not match fromEntityId is rejected before the actor", async () => {
        const { transport, inbox } = await setup()
        const env = landingRequest(RUN)
        await transport.deliverRaw({
            transportMessageId: "t1",
            senderHandle: entityHandle(RUN, F002), // F002's token posting F001's envelope
            recipientHandle: entityHandle(RUN, ALP),
            text: JSON.stringify(env),
            channel: runChannelName(RUN),
            receivedAtWallMs: Date.now(),
            via: "test",
        })
        expect(transport.rejected.at(-1)?.code).toBe("UNAUTHORIZED")
        expect(inbox.received.size).toBe(0)
    })

    test("cross-run message cannot apply", async () => {
        const { transport, inbox } = await setup()
        const other = crypto.randomUUID()
        const env = landingRequest(other)
        await transport.deliverRaw({
            transportMessageId: "t2",
            senderHandle: entityHandle(other, F001),
            recipientHandle: entityHandle(other, ALP),
            text: JSON.stringify(env),
            channel: runChannelName(RUN),
            receivedAtWallMs: Date.now(),
            via: "test",
        })
        expect(transport.rejected.at(-1)?.code).toBe("WRONG_RUN")
        expect(inbox.received.size).toBe(0)
    })

    test("body over 8192 UTF-8 bytes is rejected before parsing; smuggled transport fields are rejected", async () => {
        const { transport, inbox } = await setup()
        await transport.deliverRaw({
            transportMessageId: "t3",
            senderHandle: entityHandle(RUN, F001),
            recipientHandle: entityHandle(RUN, ALP),
            text: "{" + "é".repeat(4100), // 8201 bytes, not valid JSON either way
            channel: runChannelName(RUN),
            receivedAtWallMs: Date.now(),
            via: "test",
        })
        expect(transport.rejected.at(-1)?.detail).toBe("body exceeds 8 KiB")
        const env = { ...landingRequest(RUN), senderHandle: entityHandle(RUN, ALP) }
        await transport.deliverRaw({
            transportMessageId: "t4",
            senderHandle: entityHandle(RUN, F001),
            recipientHandle: entityHandle(RUN, ALP),
            text: JSON.stringify(env),
            channel: runChannelName(RUN),
            receivedAtWallMs: Date.now(),
            via: "test",
        })
        expect(transport.rejected.at(-1)?.code).toBe("INVALID_PAYLOAD")
        expect(inbox.received.size).toBe(0)
    })

    test("valid JSON with an unauthorized type, role or payload identity is rejected", async () => {
        const { inbox, ctx } = await setup()
        const asReceived = (e: ProtocolEnvelope): ReceivedEnvelope =>
            ({ ...e, transportMessageId: "t", senderHandle: entityHandle(RUN, e.fromEntityId), recipientHandle: entityHandle(RUN, e.toEntityId), receivedAtWallMs: Date.now() }) as ReceivedEnvelope
        // A pilot cannot send a LANDING_OFFER.
        const offer = {
            ...landingRequest(RUN),
            type: "LANDING_OFFER",
            payload: { negotiationId: "n", offerId: "o", airportId: "ALP", runwayId: "R1", slotStartSimSec: 600, occupancySec: 60, expiresAtWallMs: Date.now() + 1, airportOperationalRevision: 1 },
        } as ProtocolEnvelope
        expect((await routeReceived(asReceived(offer), ctx)).code).toBe("UNAUTHORIZED")
        // F001 cannot request a landing for F002.
        expect((await routeReceived(asReceived(landingRequest(RUN, F001, "F002")), ctx)).code).toBe("UNAUTHORIZED")
        // Only the controller sends incident commands, and the proof must verify.
        const cmd = incident(RUN, 1, "INCIDENT_CREATE", "wrong-secret")
        expect((await routeReceived(asReceived(cmd), { ...ctx, commandSecret: "right-secret" })).code).toBe("UNAUTHORIZED")
        expect((await routeReceived(asReceived(incident(RUN, 1, "INCIDENT_CREATE", "right-secret")), { ...ctx, commandSecret: "right-secret" })).outcome).toBe("APPLIED")
        // Identity outside the run registry.
        const stranger = { ...asReceived(landingRequest(RUN, "flight:F009", "F009")) }
        expect((await routeReceived(stranger, ctx)).code).toBe("UNAUTHORIZED")
        // Only the proven command reached ALP; its ACK reached the controller.
        expect([...inbox.received.keys()].filter(k => k.startsWith(`${ALP}|`)).length).toBe(1)
        expect([...inbox.received.keys()].filter(k => k.startsWith("controller|")).length).toBe(1)
    })

    test("outbox sends due entries, keeps them un-acknowledged, backs off on the HOSTED profile, and holds later commands per target", async () => {
        const transport = new LoopbackRelayTransport()
        await transport.connect(RUN, registry)
        const now = 1_000_000
        const entry = (envelope: ProtocolEnvelope, nextAttemptAtWallMs = now): OutboxEntry => ({
            envelope,
            recipientHandle: entityHandle(RUN, envelope.toEntityId),
            attemptCount: 0,
            nextAttemptAtWallMs,
            transportMessageId: null,
            acknowledged: false,
        })
        const create = incident(RUN, 1, "INCIDENT_CREATE")
        const clear = incident(RUN, 2, "INCIDENT_CLEAR")
        const req = landingRequest(RUN)
        const later = landingRequest(RUN)
        const store: Record<string, OutboxEntry[]> = { controller: [entry(clear), entry(create)], [F001]: [entry(req), entry(later, now + 10)] }
        const attempts: { entityId: EntityId; messageId: string; attemptCount: number; nextAttemptAtWallMs: number; transportMessageId: string | null }[] = []
        const port: OutboxPort = {
            entities: async () => Object.keys(store) as EntityId[],
            list: async id => store[id] ?? [],
            recordAttempt: async (entityId, a) => void attempts.push({ entityId, ...a }),
        }
        const report = await dispatchDueOutboxes({ transport, outbox: port, timing: RELAY_TIMING.HOSTED, now: () => now })
        expect(report.sent).toBe(2)
        const sentIds = transport.sent.map(s => JSON.parse(s.text).messageId)
        expect(sentIds).toContain(create.messageId) // sequence 1 first
        expect(sentIds).not.toContain(clear.messageId) // sequence 2 waits for 1's result
        expect(sentIds).toContain(req.messageId)
        expect(sentIds).not.toContain(later.messageId)
        const a = attempts.find(x => x.messageId === req.messageId)!
        expect(a.attemptCount).toBe(1)
        expect(a.nextAttemptAtWallMs).toBe(now + 5_000) // HOSTED profile, first backoff
        expect(a.transportMessageId).toMatch(/^loop-/)
        // Expired non-command entries are left for their actor; expired commands still go out.
        const stale = { ...landingRequest(RUN), expiresAtWallMs: now - 1 }
        const oldCmd = { ...incident(RUN, 3, "INCIDENT_CREATE"), expiresAtWallMs: now - 1 }
        const sel = selectDue(F001, [entry(stale)], now)
        expect(sel.expired.length).toBe(1)
        expect(selectDue("controller", [entry(oldCmd)], now).due.length).toBe(1)
    })
})

// ---------------------------------------------------------------- hosted Relay (real network)

const LIVE = process.env.RELAY_LIVE === "1"
const BASE = process.env.RELAY_BASE_URL || DEFAULT_RELAY_BASE_URL

describe.skipIf(!LIVE)("relay live (hosted Relaycast)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-relay-"))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    test(
        "flight -> Relay -> router -> ATC inbox, ACK back through Relay, duplicates and spoofs ignored, reconnect without re-registering",
        async () => {
            const ws = await fetch(`${BASE}/workspaces`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: `ghost-test-${Date.now()}`, provenance: { source: "api" } }),
            }).then(r => r.json() as Promise<any>)
            const workspaceKey: string = ws.data.api_key
            const runId = crypto.randomUUID()
            const registry = registrationsFor(runId, ["controller", ALP, F001])
            const storePath = join(dir, "tokens.json")
            const cursor = memoryCursorStore()
            const inbox = new MemoryInbox()
            const routed: RouteEvent[] = []
            const rejected: RejectedRelayMessage[] = []
            const timings: Record<string, number> = {}

            // localEcho off: every delivery below comes from Relay's workspace event log.
            const t1 = new HostedRelayTransport({ baseUrl: BASE, workspaceKey, tokenStore: fileTokenStore(storePath, { baseUrl: BASE, workspaceKey }), cursor, pollIntervalMs: 1_000, onRejected: r => rejected.push(r) })
            const ctx: RouterContext = { runId, registry, inbox, transport: t1, log: e => routed.push(e) } // no memo: the inbox is the dedup authority
            t1.onMessage(m => routeReceived(m, ctx).then(() => {}))
            let t = Date.now()
            await t1.connect(runId, registry)
            timings.connectMs = Date.now() - t
            expect(t1.stats.registered).toBe(3)

            // 1. Typed, run-scoped request from F001 to ALP.
            const env = landingRequest(runId)
            t = Date.now()
            const { transportMessageId } = await t1.send(env)
            timings.sendMs = Date.now() - t
            const got = await waitFor("ALP inbox", () => inbox.find(ALP, m => m.messageId === env.messageId), 60_000)
            timings.sendToInboxMs = Date.now() - t
            expect(got.senderHandle).toBe(entityHandle(runId, F001))
            expect(got.transportMessageId).toBe(transportMessageId)
            expect(got.correlationId).toBe(env.correlationId)
            const ack = await waitFor("ACK in F001 inbox", () => inbox.find(F001, m => m.type === "DOMAIN_ACK" && m.payload.processedMessageId === env.messageId), 60_000)
            timings.sendToAckMs = Date.now() - t
            expect(ack.senderHandle).toBe(entityHandle(runId, ALP))
            expect(ack.correlationId).toBe(env.correlationId)

            // 2. Duplicates. Same idempotency key: Relay returns the same message. A copy posted under a
            //    new idempotency key gets a new transport ID and still has exactly one effect.
            const again = await t1.send(env)
            expect(again.transportMessageId).toBe(transportMessageId)
            const tokens = JSON.parse(readFileSync(storePath, "utf8")).agents
            const rest = new RelaycastRest(BASE)
            const post = (handle: string, text: string, to: string) =>
                rest.call(`/channels/${runChannelName(runId)}/messages`, { token: tokens[handle].token, body: { text, data: { to } }, idempotencyKey: crypto.randomUUID() })
            const f001 = entityHandle(runId, F001)
            const alp = entityHandle(runId, ALP)
            // 3. Spoof: F001's token posting an envelope that claims to come from ALP. 4. Wrong run.
            const spoof = { ...landingRequest(runId), fromEntityId: ALP, toEntityId: F001 }
            const otherRun = landingRequest(crypto.randomUUID())
            const [copy] = await Promise.all([
                post(f001, JSON.stringify(env), alp),
                post(f001, JSON.stringify(spoof), f001),
                post(f001, JSON.stringify(otherRun), alp),
            ])
            expect(String(copy.id)).not.toBe(transportMessageId)
            await waitFor("duplicate seen by inbox", () => (inbox.duplicates.get(env.messageId) ?? 0) >= 1, 60_000)
            await waitFor("spoof and wrong-run rejected", () => rejected.length >= 2, 60_000)
            expect(inbox.effects.get(env.messageId)).toBe(1)
            expect(rejected.map(r => r.code).sort()).toEqual(["UNAUTHORIZED", "WRONG_RUN"])
            expect(inbox.received.size).toBe(2) // the request and its ACK, nothing else
            await t1.disconnect()

            // 5. Restart: a new adapter reconnects saved identities (no registration) from the saved
            //    cursor, and a controller command travels controller -> Relay -> ALP inbox.
            const t2 = new HostedRelayTransport({ baseUrl: BASE, workspaceKey, tokenStore: fileTokenStore(storePath, { baseUrl: BASE, workspaceKey }), cursor, pollIntervalMs: 1_000, onRejected: r => rejected.push(r) })
            t2.onMessage(m => routeReceived(m, { ...ctx, transport: t2 }).then(() => {}))
            t = Date.now()
            await t2.connect(runId, registry)
            timings.reconnectMs = Date.now() - t
            expect(t2.stats.registered).toBe(0)
            expect(t2.stats.reconnected).toBe(3)
            const cmd = incident(runId, 1, "INCIDENT_CREATE")
            t = Date.now()
            await t2.send(cmd)
            const gotCmd = await waitFor("command in ALP inbox", () => inbox.find(ALP, m => m.messageId === cmd.messageId), 60_000)
            expect(gotCmd.correlationId).toBe(cmd.correlationId)
            timings.commandToInboxMs = Date.now() - t
            await waitFor("command ACK at controller", () => inbox.find("controller", m => m.type === "DOMAIN_ACK"), 60_000)
            timings.commandToAckMs = Date.now() - t
            await t2.disconnect()
            expect(inbox.effects.get(env.messageId)).toBe(1)
            console.log("relay live timings (ms):", JSON.stringify(timings))
        },
        300_000,
    )
})
