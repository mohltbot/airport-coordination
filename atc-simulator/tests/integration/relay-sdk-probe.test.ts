// Relay SDK seam probe (Task 1, Relay half). Live against hosted Relaycast; run with
//   bun test tests/integration/relay-sdk-probe.test.ts --test-name-pattern bootstrap
// Uses only the two dedicated ghost-probe identities in the ghost-tower workspace.
import { afterAll, describe, expect, test } from "bun:test"
import {
    type AgentRelay,
    SDK_BASE_URL,
    TOKENS_PATH,
    ensureWorkspace,
    eventPage,
    findInEventLog,
    knownSecrets,
    readTokens,
    redact,
    relayFor,
    trackSecret,
    waitConnected,
    withRetry,
    writeTokens,
} from "../../server/src/relay/probe"

type Client = Awaited<ReturnType<AgentRelay["workspace"]["reconnect"]>>
type Seen = { at: number; type: string; text: string; fromName?: string; envelopeFrom?: string; messageId: string; metadata?: unknown }

const results: Record<string, any> = { baseUrl: SDK_BASE_URL }
const relays: AgentRelay[] = []
let key = ""
let nameA = ""
let nameB = ""
let tokenA = ""
let tokenB = ""
let clientA: Client | undefined

const ms = (t0: number) => Math.round(performance.now() - t0)

/** Collect dm.received events on one relay into an array; returns the unsubscribe. */
function collect(relay: AgentRelay, into: Seen[]) {
    return relay.addListener("dm.received", event => {
        into.push({
            at: performance.now(),
            type: event.type,
            text: event.message.text,
            fromName: event.message.from?.name,
            envelopeFrom: event.envelope.from?.name,
            messageId: event.message.messageId,
            metadata: event.message.metadata,
        })
    })
}

async function waitFor(into: Seen[], marker: string, timeoutMs: number): Promise<Seen | undefined> {
    const end = performance.now() + timeoutMs
    while (performance.now() < end) {
        const hit = into.find(s => s.text?.includes(marker))
        if (hit) return hit
        await Bun.sleep(100)
    }
    return undefined
}

/** One A -> B -> A round trip. Falls back to the event log if a callback never fires. */
async function roundTrip(label: string, relayA: AgentRelay, a: Client, relayB: AgentRelay, b: Client) {
    const seenA: Seen[] = []
    const seenB: Seen[] = []
    const offA = collect(relayA, seenA)
    const offB = collect(relayB, seenB)
    const [connA, connB] = await Promise.all([waitConnected(relayA), waitConnected(relayB)])
    const before = (await eventPage(key, 0, 1)).latest_seq ?? 0
    const marker = crypto.randomUUID()
    const out: Record<string, any> = { socketsConnected: { a: connA, b: connB } }

    const t0 = performance.now()
    const sent = await withRetry(() =>
        a.sendMessage({ to: `@${nameB}`, text: `probe ${marker}`, idempotencyKey: `probe-${marker}`, metadata: { probe: label, marker } }),
    )
    out.sendMs = ms(t0)
    out.sentId = sent.messageId
    out.sentFrom = sent.from?.name
    const logP = findInEventLog(key, marker, { since: before, limit: 50, timeoutMs: 30_000 })
    const atB = await waitFor(seenB, marker, 45_000)
    out.callbackB = atB
        ? { ms: Math.round(atB.at - t0), fromName: atB.fromName, envelopeFrom: atB.envelopeFrom, sameId: atB.messageId === sent.messageId, metadata: atB.metadata }
        : null
    const log = await logP
    // findInEventLog starts right after the send returns, so this is send-return to visible-in-log.
    out.eventLogMsAfterSend = log.foundAtMs === undefined ? null : Math.round(log.foundAtMs)
    out.eventLogType = log.matches[0]?.type
    out.eventLogNamesSender = JSON.stringify(log.matches[0] ?? {}).includes(`"${nameA}"`)

    const replyMarker = `reply-${marker}`
    const t1 = performance.now()
    const reply = await withRetry(() => b.sendMessage({ to: `@${nameA}`, text: `ack ${replyMarker}`, idempotencyKey: `probe-${replyMarker}` }))
    out.replySendMs = ms(t1)
    const atA = await waitFor(seenA, replyMarker, 45_000)
    out.callbackA = atA ? { ms: Math.round(atA.at - t1), fromName: atA.fromName, sameId: atA.messageId === reply.messageId } : null
    if (!atA) {
        const replyLog = await findInEventLog(key, replyMarker, { since: before, limit: 50, timeoutMs: 30_000 })
        out.replyInEventLog = replyLog.matches.length > 0
    }
    out.selfEchoA = seenA.some(s => s.text?.includes(`probe ${marker}`))
    out.selfEchoB = seenB.some(s => s.text?.includes(`ack ${replyMarker}`))
    offA()
    offB()
    return out
}

describe("relay sdk probe", () => {
    afterAll(async () => {
        for (const r of relays) await r.events.disconnect().catch(() => {})
    })

    test("bootstrap (a) A->B DM, B sees authenticated sender, B replies, A receives", async () => {
        const ws = await ensureWorkspace()
        key = ws.key
        results.workspaceCreated = ws.created
        const store = readTokens()
        const prior = store ? Object.keys(store.agents) : []
        const relayA = relayFor(key)
        const relayB = relayFor(key)
        relays.push(relayA, relayB)
        let a: Client
        let b: Client
        const existingA = prior.find(n => n.startsWith("ghost-probe-a-"))
        const existingB = prior.find(n => n.startsWith("ghost-probe-b-"))
        const t0 = performance.now()
        if (store && existingA && existingB) {
            a = await withRetry(() => relayA.workspace.reconnect({ apiToken: store.agents[existingA] }))
            b = await withRetry(() => relayB.workspace.reconnect({ apiToken: store.agents[existingB] }))
            results.identitySource = "reconnected-from-store"
        } else {
            const short = crypto.randomUUID().slice(0, 6)
            a = await withRetry(() => relayA.workspace.register({ name: `ghost-probe-a-${short}`, type: "agent" }))
            b = await withRetry(() => relayB.workspace.register({ name: `ghost-probe-b-${short}`, type: "agent" }))
            results.identitySource = "registered"
        }
        results.identityMs = ms(t0)
        nameA = a.name
        nameB = b.name
        tokenA = a.token ?? ""
        tokenB = b.token ?? ""
        trackSecret(tokenA)
        trackSecret(tokenB)
        expect(tokenA.length).toBeGreaterThan(8)
        expect(tokenB.length).toBeGreaterThan(8)
        writeTokens({ baseUrl: SDK_BASE_URL, workspaceId: ws.workspaceId ?? store?.workspaceId, agents: { ...(store?.agents ?? {}), [nameA]: tokenA, [nameB]: tokenB } })
        results.names = { a: nameA, b: nameB }
        // Agent lookup lags a moment after registration (relaycast issue #477).
        if (results.identitySource === "registered") await Bun.sleep(2000)

        const r = await roundTrip("a", relayA, a, relayB, b)
        results.caseA = r
        expect(r.sentFrom).toBe(nameA)
        if (r.callbackB) expect(r.callbackB.fromName).toBe(nameA)
        else expect(r.eventLogNamesSender).toBe(true)
        expect(r.callbackA !== null || r.replyInEventLog === true).toBe(true)
    }, 180_000)

    test("bootstrap (b) reconnect both from saved tokens and repeat", async () => {
        for (const r of relays.splice(0)) await r.events.disconnect().catch(() => {})
        const store = readTokens()
        expect(store).not.toBeNull()
        const relayA = relayFor(key)
        const relayB = relayFor(key)
        relays.push(relayA, relayB)
        const t0 = performance.now()
        const a = await withRetry(() => relayA.workspace.reconnect({ apiToken: store!.agents[nameA] }))
        const b = await withRetry(() => relayB.workspace.reconnect({ apiToken: store!.agents[nameB] }))
        results.reconnectMs = ms(t0)
        expect(a.name).toBe(nameA)
        expect(b.name).toBe(nameB)
        clientA = a
        const r = await roundTrip("b", relayA, a, relayB, b)
        results.caseB = r
        expect(r.sentFrom).toBe(nameA)
        if (r.callbackB) expect(r.callbackB.fromName).toBe(nameA)
        else expect(r.eventLogNamesSender).toBe(true)
        expect(r.callbackA !== null || r.replyInEventLog === true).toBe(true)
    }, 180_000)

    test("bootstrap (c) same idempotency key twice", async () => {
        const relayB = relays[1]
        const a = clientA!
        const seenB: Seen[] = []
        const offB = collect(relayB, seenB)
        await waitConnected(relayB)
        const before = (await eventPage(key, 0, 1)).latest_seq ?? 0
        const marker = crypto.randomUUID()
        const idem = `probe-idem-${marker}`
        const send = () => withRetry(() => a.sendMessage({ to: `@${nameB}`, text: `idem ${marker}`, idempotencyKey: idem }))
        const t0 = performance.now()
        const first = await send()
        const firstMs = ms(t0)
        const t1 = performance.now()
        let second: Awaited<ReturnType<typeof send>> | undefined
        let secondError: string | undefined
        try {
            second = await send()
        } catch (err) {
            secondError = String((err as Error).message)
        }
        const secondMs = ms(t1)
        await waitFor(seenB, marker, 30_000)
        await Bun.sleep(10_000) // window for a duplicate callback
        const callbacks = seenB.filter(s => s.text?.includes(marker))
        const log = await findInEventLog(key, marker, { since: before, limit: 50, timeoutMs: 20_000, settleMs: 5_000 })
        offB()
        results.caseC = {
            firstMs,
            secondMs,
            sameMessageId: second ? second.messageId === first.messageId : null,
            secondError: secondError ?? null,
            callbackCount: callbacks.length,
            callbackIds: [...new Set(callbacks.map(c => (c.messageId === first.messageId ? "first" : "other")))],
            eventLogMatches: log.matches.length,
            eventLogTypes: log.matches.map(m => m.type),
        }
        expect(first.messageId).toBeTruthy()
    }, 120_000)

    test("bootstrap (d) lost callback recovered from durable event log with paging", async () => {
        const store = readTokens()!
        // No listener on B for this send: the callback is lost by construction.
        const relayA = relayFor(key)
        relays.push(relayA)
        const a = await withRetry(() => relayA.workspace.reconnect({ apiToken: store.agents[nameA] }))
        const head = await eventPage(key, 0, 1)
        const before = head.latest_seq ?? 0
        const marker = crypto.randomUUID()
        const t0 = performance.now()
        const sent = await withRetry(() => a.sendMessage({ to: `@${nameB}`, text: `lost ${marker}`, idempotencyKey: `probe-lost-${marker}`, metadata: { marker } }))
        const sendMs = ms(t0)
        // Small limit forces several pages from a cursor a little behind the head.
        const since = Math.max(0, before - 5)
        const log = await findInEventLog(key, marker, { since, limit: 2, timeoutMs: 45_000 })
        const hit = log.matches[0]
        // Re-read exactly the page that holds the hit to prove since=<seq-1>&limit=1 returns it.
        const exact = hit ? await eventPage(key, hit.seq - 1, 1) : undefined
        results.caseD = {
            sendMs,
            timeToEventLogMs: log.foundAtMs === undefined ? null : Math.round(log.foundAtMs + sendMs),
            startSince: since,
            headLatestSeqBefore: before,
            pageResponseKeys: log.pageKeys,
            eventKeys: hit ? Object.keys(hit) : [],
            payloadKeys: hit?.payload ? Object.keys(hit.payload) : [],
            eventType: hit?.type,
            hitSeq: hit?.seq,
            pages: log.pages,
            seqMonotonic: log.monotonic,
            cursorsAdvanced: log.cursors.every((c, i) => i === 0 || c >= log.cursors[i - 1]),
            exactPageReturnsHit: exact ? exact.events[0]?.seq === hit.seq : false,
            exactPageNextSince: exact?.next_since,
            idMatchesSend: hit ? JSON.stringify(hit).includes(sent.messageId) : false,
            senderNamed: hit ? JSON.stringify(hit).includes(`"${nameA}"`) : false,
        }
        expect(hit).toBeDefined()
        expect(log.monotonic).toBe(true)
        expect(results.caseD.exactPageReturnsHit).toBe(true)
    }, 120_000)

    test("bootstrap (e) probe results carry no secrets", () => {
        const serialized = JSON.stringify(results)
        const secrets = [key, tokenA, tokenB, ...knownSecrets()].filter(s => s && s.length >= 8)
        expect(secrets.length).toBeGreaterThanOrEqual(3)
        for (const s of secrets) expect(serialized.includes(s)).toBe(false)
        expect(redact(serialized)).toBe(serialized)
        results.tokensPath = TOKENS_PATH.replace(/.*atc-simulator\//, "")
        console.log("RELAY_PROBE_RESULTS " + JSON.stringify(results, null, 2))
    })
})
