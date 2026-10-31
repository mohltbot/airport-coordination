import { describe, expect, test } from "bun:test"
import {
    IncidentCommandSchema,
    ProtocolEnvelopeSchema,
    PublicSnapshotSchema,
    ReceivedEnvelopeSchema,
    RunConfigSchema,
    entityHandle,
    entityActorId,
} from "../../packages/domain/src/contracts.ts"
import { RELAY_TIMING, minSlotLeadSimSec, resolveRelayTiming } from "../../packages/domain/src/constants.ts"
import { samplePublicSnapshot } from "../fixtures.ts"

const runId = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"
const uuid = () => crypto.randomUUID()

describe("RunConfig", () => {
    test("accepts 1 and 30 flights", () => {
        expect(RunConfigSchema.safeParse({ flightCount: 1, seed: 20261031, speed: 10 }).success).toBe(true)
        expect(RunConfigSchema.safeParse({ flightCount: 30, seed: 0, speed: 1 }).success).toBe(true)
    })
    test.each([0, 31, 2.5, Number.NaN])("rejects flightCount %p", flightCount => {
        expect(RunConfigSchema.safeParse({ flightCount, seed: 1, speed: 5 }).success).toBe(false)
    })
    test.each([-1, 2 ** 32, 1.5, Number.NaN])("rejects seed %p", seed => {
        expect(RunConfigSchema.safeParse({ flightCount: 10, seed, speed: 5 }).success).toBe(false)
    })
    test("rejects unsupported speed and extra fields", () => {
        expect(RunConfigSchema.safeParse({ flightCount: 10, seed: 1, speed: 2 }).success).toBe(false)
        expect(RunConfigSchema.safeParse({ flightCount: 10, seed: 1, speed: 5, extra: 1 }).success).toBe(false)
    })
})

describe("IncidentCommand target-kind matrix", () => {
    const create = (target: string, kind: string, parameters: object = {}) => ({
        commandId: uuid(),
        runId,
        type: "INCIDENT_CREATE",
        payload: { incidentId: uuid(), target, kind, parameters },
    })
    test("plan §5 examples parse", () => {
        expect(IncidentCommandSchema.safeParse(create("airport:ALP", "WEATHER_CLOSED")).success).toBe(true)
        expect(IncidentCommandSchema.safeParse(create("flight:F001", "SMOKE")).success).toBe(true)
        const clear = { commandId: uuid(), runId, type: "INCIDENT_CLEAR", payload: { incidentId: uuid(), target: "airport:ALP", expectedIncidentRevision: 1 } }
        expect(IncidentCommandSchema.safeParse(clear).success).toBe(true)
    })
    test("airport kinds need airport targets and flight kinds need flight targets", () => {
        expect(IncidentCommandSchema.safeParse(create("flight:F001", "WEATHER_CLOSED")).success).toBe(false)
        expect(IncidentCommandSchema.safeParse(create("airport:ALP", "SMOKE")).success).toBe(false)
        expect(IncidentCommandSchema.safeParse(create("airport:XYZ", "WEATHER_CLOSED")).success).toBe(false)
    })
    test("only RUNWAY_CLOSED takes a runwayId", () => {
        expect(IncidentCommandSchema.safeParse(create("airport:BRV", "RUNWAY_CLOSED", { runwayId: "R1" })).success).toBe(true)
        expect(IncidentCommandSchema.safeParse(create("airport:BRV", "RUNWAY_CLOSED", {})).success).toBe(false)
        expect(IncidentCommandSchema.safeParse(create("airport:BRV", "RUNWAY_CLOSED", { runwayId: "R3" })).success).toBe(false)
        expect(IncidentCommandSchema.safeParse(create("airport:BRV", "WEATHER_CLOSED", { runwayId: "R1" })).success).toBe(false)
        expect(IncidentCommandSchema.safeParse(create("flight:F002", "LOW_FUEL", { runwayId: "R1" })).success).toBe(false)
    })
    test("unknown properties reject", () => {
        expect(IncidentCommandSchema.safeParse({ ...create("airport:ALP", "WEATHER_CLOSED"), priority: "HIGH" }).success).toBe(false)
    })
})

describe("envelopes", () => {
    const base = {
        schemaVersion: 1,
        messageId: uuid(),
        runId,
        fromEntityId: "flight:F001",
        toEntityId: "airport:ALP",
        correlationId: "neg-1",
        causationId: null,
        createdAtWallMs: 1,
        expiresAtWallMs: null,
    }
    test("ACK parses; received form adds transport fields", () => {
        const ack = { ...base, type: "DOMAIN_ACK", payload: { processedMessageId: uuid(), resultCode: "OK" } }
        expect(ProtocolEnvelopeSchema.safeParse(ack).success).toBe(true)
        expect(ReceivedEnvelopeSchema.safeParse(ack).success).toBe(false)
        const received = { ...ack, transportMessageId: "t1", senderHandle: "h1", recipientHandle: "h2", receivedAtWallMs: 2 }
        expect(ReceivedEnvelopeSchema.safeParse(received).success).toBe(true)
        expect(ProtocolEnvelopeSchema.safeParse(received).success).toBe(false)
    })
    test("incident commands require command identity and proof", () => {
        const payload = { incidentId: uuid(), target: "airport:ALP", kind: "WEATHER_CLOSED", parameters: {} }
        const env = { ...base, fromEntityId: "controller", type: "INCIDENT_CREATE", payload }
        expect(ProtocolEnvelopeSchema.safeParse(env).success).toBe(false)
        expect(ProtocolEnvelopeSchema.safeParse({ ...env, commandId: uuid(), commandSequence: 1, authorization: "sig" }).success).toBe(true)
    })
})

describe("identity helpers", () => {
    test("handles and actor IDs", () => {
        expect(entityHandle(runId, "controller")).toBe("ghost-controller")
        expect(entityHandle(runId, "airport:ALP")).toBe("ghost-atc-alp")
        expect(entityHandle(runId, "flight:F001")).toBe("ghost-flight-f001")
        expect(entityActorId(runId, "airport:ALP")).toBe(`${runId}.airport.ALP`)
        expect(entityActorId(runId, "flight:F012")).toBe(`${runId}.flight.F012`)
    })
})

describe("timing profiles", () => {
    test("LOCAL keeps spec values; HOSTED is the agreed profile", () => {
        expect(RELAY_TIMING.LOCAL.replyCollectionWindowMs).toBe(4000)
        expect(RELAY_TIMING.LOCAL.offerTtlMs).toBe(20000)
        expect(RELAY_TIMING.HOSTED.replyCollectionWindowMs).toBe(60000)
        expect(RELAY_TIMING.HOSTED.offerTtlMs).toBe(120000)
        expect(minSlotLeadSimSec(1, RELAY_TIMING.HOSTED)).toBe(90)
        expect(minSlotLeadSimSec(5, RELAY_TIMING.HOSTED)).toBe(450)
        expect(minSlotLeadSimSec(10, RELAY_TIMING.LOCAL)).toBe(60)
    })
    test("env overrides", () => {
        const t = resolveRelayTiming("HOSTED", { RELAY_OFFER_TTL_MS: "60000", RELAY_ACK_RETRY_BACKOFF_MS: "1000,2000" })
        expect(t.offerTtlMs).toBe(60000)
        expect(t.ackRetryBackoffMs).toEqual([1000, 2000])
        expect(() => resolveRelayTiming("HOSTED", { SIM_DEFAULT_SPEED: "3" })).toThrow()
    })
})

describe("public snapshot fixture", () => {
    test("matches the agreed shape", () => {
        const s = samplePublicSnapshot
        expect(s.airports.map(a => a.airportId)).toEqual(["ALP", "BRV", "CHR"])
        expect(s.flights).toHaveLength(10)
        expect(s.incidents.some(i => i.kind === "WEATHER_CLOSED" && i.target === "airport:ALP" && i.status === "ACTIVE")).toBe(true)
        expect(s.incidents.some(i => i.status === "RESOLVED")).toBe(true)
        expect(s.flights.filter(f => f.priority === "EMERGENCY")).toHaveLength(1)
        expect(s.commands.some(c => c.status === "QUEUED" || c.status === "SENT")).toBe(true)
        expect(s.timeline.some(e => e.status === "REFUSED")).toBe(true)
        expect(PublicSnapshotSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s)
    })
})
