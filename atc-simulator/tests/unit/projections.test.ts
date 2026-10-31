import { describe, expect, test } from "bun:test"
import {
    AirportStateSchema,
    FlightStateSchema,
    PublicSnapshotSchema,
    SimulationStateSchema,
    type AirportState,
    type FlightState,
    type Job,
    type OutboxEntry,
    type ProtocolEnvelope,
    type SimulationState,
} from "../../packages/domain/src/contracts.ts"
import {
    assertNoPrivateFields,
    buildPublicSnapshot,
    projectAirport,
    projectIncident,
    summarizePayload,
    timelineFromEntities,
    toPublicAirport,
    toPublicFlight,
} from "../../packages/domain/src/projections.ts"

const uuid = () => crypto.randomUUID()
const NOW = 1_800_000_000_000
const runId = uuid()
const weatherId = uuid()
const lowFuelId = uuid()
const refusedMsgId = uuid()
const ackMsgId = uuid()
const requestMsgId = uuid()
const commandId = uuid()
const statusMsgId = uuid()
const resultMsgId = uuid()
const clearanceMsgId = uuid()

function common(entityId: string) {
    return {
        runId,
        stateRevision: 7,
        decisionRevision: 3,
        lastTickId: null,
        lastAdvancedSimSec: 300,
        inbox: {},
        outbox: [] as OutboxEntry[],
        jobs: {} as Record<string, Job>,
        lastControllerSequence: 0,
        bufferedControllerMessages: [],
        fencing: { workerEpoch: 1, leaseToken: `lease-${entityId}` },
        initializedByOperationId: "op-init",
    }
}

function envelope(fields: Record<string, unknown>): ProtocolEnvelope {
    return {
        schemaVersion: 1,
        runId,
        causationId: null,
        expiresAtWallMs: null,
        ...fields,
    } as ProtocolEnvelope
}

function outbox(env: ProtocolEnvelope, acknowledged: boolean): OutboxEntry {
    return { envelope: env, recipientHandle: "ghost-test", attemptCount: 1, nextAttemptAtWallMs: NOW, transportMessageId: null, acknowledged }
}

function job(
    jobId: string,
    source: "MODEL" | "RULES_FALLBACK",
    action: Job["input"]["allowedActions"][number],
    reason: string,
    at: number,
    relevantMessageIds: string[] = [],
): Job {
    return {
        jobId,
        kind: action === "PROPOSE_OFFER" || action === "REFUSE" ? "ATC_DECISION" : "PILOT_DECISION",
        status: "COMMITTED",
        decisionRevision: 3,
        input: { trigger: "TEST", priority: "EMERGENCY", allowedActions: [action], relevantMessageIds, createdAtWallMs: at - 100 },
        leaseToken: "job-lease-secret",
        leaseUntilWallMs: null,
        attemptCount: 1,
        outcome: { source, action, reason, committedAtWallMs: at },
    }
}

const offerBase = {
    negotiationId: "neg-1",
    airportId: "ALP" as const,
    occupancySec: 60,
    airportOperationalRevision: 2,
    flightId: "F001",
    requestMessageId: requestMsgId,
    priority: "EMERGENCY" as const,
}

function makeAirport(): AirportState {
    const airport: AirportState = {
        ...common("airport:ALP"),
        entityId: "airport:ALP",
        airportId: "ALP",
        name: "Alpha",
        position: { x: 50, y: 50 },
        incidents: {
            [weatherId]: {
                incidentId: weatherId,
                runId,
                target: "airport:ALP",
                kind: "WEATHER_CLOSED",
                parameters: {},
                createdAtSimSec: 200,
                createdAtWallMs: NOW - 60_000,
                createdBy: "principal-secret",
                status: "ACTIVE",
                resolvedAtSimSec: null,
                revision: 1,
            },
        },
        restrictions: { arrivalsClosed: true, closedRunways: [], occupancySec: 60, activeIncidentIds: [weatherId] },
        statusRevision: 2,
        operationalRevision: 2,
        runways: [
            { runwayId: "R1", occupiedUntilSimSec: null },
            { runwayId: "R2", occupiedUntilSimSec: 500 },
        ],
        offers: {
            "off-live": { ...offerBase, offerId: "off-live", runwayId: "R1", slotStartSimSec: 750, expiresAtWallMs: NOW + 10_000, status: "OFFERED" },
            "off-old": { ...offerBase, offerId: "off-old", runwayId: "R2", slotStartSimSec: 600, expiresAtWallMs: NOW - 1, status: "OFFERED" },
            "off-declined": { ...offerBase, offerId: "off-declined", runwayId: "R2", slotStartSimSec: 700, expiresAtWallMs: NOW + 10_000, status: "DECLINED" },
        },
        reservations: {
            "res-b": { ...offerBase, offerId: "o-b", runwayId: "R2", slotStartSimSec: 900, expiresAtWallMs: NOW, reservationId: "res-b", status: "CONFIRMED", flightId: "F002", priority: "NORMAL" },
            "res-a": { ...offerBase, offerId: "o-a", runwayId: "R2", slotStartSimSec: 840, expiresAtWallMs: NOW, reservationId: "res-a", status: "CLEARED" },
            "res-c": { ...offerBase, offerId: "o-c", runwayId: "R1", slotStartSimSec: 840, expiresAtWallMs: NOW, reservationId: "res-c", status: "CONFIRMED", flightId: "F003" },
            "res-done": { ...offerBase, offerId: "o-d", runwayId: "R1", slotStartSimSec: 100, expiresAtWallMs: NOW, reservationId: "res-done", status: "COMPLETED" },
        },
        clearances: {},
        touchdowns: {},
    }
    airport.outbox = [
        outbox(
            envelope({
                messageId: refusedMsgId,
                fromEntityId: "airport:ALP",
                toEntityId: "flight:F001",
                correlationId: "corr-envelope",
                createdAtWallMs: NOW - 5_000,
                type: "LANDING_REFUSED",
                payload: { negotiationId: "neg-1", airportId: "ALP", code: "CLOSED", explanation: "Weather closure" },
            }),
            true,
        ),
        outbox(
            envelope({
                messageId: ackMsgId,
                fromEntityId: "airport:ALP",
                toEntityId: "flight:F001",
                correlationId: "neg-1",
                createdAtWallMs: NOW - 4_000,
                type: "DOMAIN_ACK",
                payload: { processedMessageId: requestMsgId, resultCode: "OK" },
            }),
            false,
        ),
        outbox(
            envelope({
                messageId: statusMsgId,
                fromEntityId: "airport:ALP",
                toEntityId: "flight:F001",
                correlationId: "status-1",
                createdAtWallMs: NOW - 59_000,
                type: "AIRPORT_STATUS",
                payload: {
                    airportId: "ALP",
                    statusRevision: 2,
                    restrictions: { arrivalsClosed: true, closedRunways: [], occupancySec: 60, activeIncidentIds: [weatherId] },
                },
            }),
            true,
        ),
        outbox(
            envelope({
                messageId: resultMsgId,
                fromEntityId: "airport:ALP",
                toEntityId: "controller",
                correlationId: commandId,
                createdAtWallMs: NOW - 60_000,
                type: "COMMAND_RESULT",
                payload: { commandId, outcome: "APPLIED", code: "OK", resultingRevision: 1, incidentId: weatherId },
            }),
            true,
        ),
        outbox(
            envelope({
                messageId: clearanceMsgId,
                fromEntityId: "airport:ALP",
                toEntityId: "flight:F002",
                correlationId: "neg-2",
                createdAtWallMs: NOW - 3_000,
                type: "CLEARANCE_REFUSED",
                payload: { reservationId: "res-b", code: "CLOSED" },
            }),
            false,
        ),
    ]
    airport.jobs = { "job-atc": job("job-atc", "MODEL", "REFUSE", "Arrivals closed for weather", NOW - 5_500, [requestMsgId]) }
    return airport
}

function makeFlight(): FlightState {
    const flight: FlightState = {
        ...common("flight:F001"),
        entityId: "flight:F001",
        flightId: "F001",
        callsign: "GHT001",
        originalDestination: "ALP",
        position: { x: 60, y: 70 },
        headingDeg: 90,
        speedKnots: 240,
        fuelRemainingSec: 840,
        phase: "HOLDING",
        holdCenter: null,
        holdAngle: null,
        incidents: {
            [lowFuelId]: {
                incidentId: lowFuelId,
                runId,
                target: "flight:F001",
                kind: "LOW_FUEL",
                parameters: {},
                createdAtSimSec: 100,
                createdAtWallMs: NOW - 90_000,
                createdBy: "principal-secret",
                status: "ACTIVE",
                resolvedAtSimSec: null,
                revision: 1,
            },
        },
        priority: "EMERGENCY",
        deadlineSimSec: 900,
        knownAirportStatus: {},
        negotiation: { roundId: "round-1", trigger: "LOW_FUEL", candidateAirports: ["ALP"], replies: [], collectUntilWallMs: null, stage: "COLLECTING" },
        negotiationCounter: 1,
        pendingAcceptance: null,
        activeAssignment: null,
        releaseObligations: [],
        landingReceipt: null,
        terminalReason: null,
    }
    flight.outbox = [
        outbox(
            envelope({
                messageId: requestMsgId,
                fromEntityId: "flight:F001",
                toEntityId: "airport:ALP",
                correlationId: "neg-1",
                createdAtWallMs: NOW - 6_000,
                type: "LANDING_REQUEST",
                payload: {
                    negotiationId: "neg-1",
                    flightId: "F001",
                    flightDecisionRevision: 3,
                    position: { x: 60, y: 70 },
                    speedKnots: 240,
                    fuelRemainingSec: 840,
                    sampledAtSimSec: 290,
                    priority: "EMERGENCY",
                    deadlineSimSec: 900,
                },
            }),
            true,
        ),
    ]
    flight.jobs = {
        "job-old": job("job-old", "RULES_FALLBACK", "HOLD", "Holding while waiting", NOW - 20_000),
        "job-new": job("job-new", "MODEL", "REQUEST_LANDING", "Low fuel, nearest open airport", NOW - 7_000),
    }
    return flight
}

function makeRun(): SimulationState {
    return {
        runId,
        stateRevision: 4,
        createRequestId: "req-1",
        config: { flightCount: 1, seed: 7, speed: 10 },
        phase: "RUNNING",
        entities: [],
        simNowSec: 300,
        tickCounter: 12,
        pendingTick: null,
        lastCompletedTickId: null,
        commands: {
            [commandId]: {
                command: {
                    commandId,
                    runId,
                    type: "INCIDENT_CREATE",
                    payload: { incidentId: weatherId, target: "airport:ALP", kind: "WEATHER_CLOSED", parameters: {} },
                },
                principal: { principalId: "p-1", role: "CONTROLLER", runId, sessionId: "sess-secret" },
                commandSequence: 1,
                target: "airport:ALP",
                contentHash: "hash",
                messageId: uuid(),
                receipt: { runId, commandId, status: "APPLIED", incidentId: weatherId, code: "OK", resultingRevision: 1 },
                submittedAtWallMs: NOW - 61_000,
                updatedAtWallMs: NOW - 60_000,
            },
        },
        targetSequences: { "airport:ALP": 1 },
        controllerOutbox: [
            outbox(
                envelope({
                    messageId: uuid(),
                    fromEntityId: "controller",
                    toEntityId: "airport:ALP",
                    correlationId: commandId,
                    createdAtWallMs: NOW - 61_000,
                    commandId,
                    commandSequence: 1,
                    authorization: "signed-proof-secret",
                    type: "INCIDENT_CREATE",
                    payload: { incidentId: weatherId, target: "airport:ALP", kind: "WEATHER_CLOSED", parameters: {} },
                }),
                true,
            ),
        ],
        controllerInbox: {},
        initialization: { steps: ["READY"], completedAtWallMs: NOW - 100_000 },
        workerLease: { runId, ownerId: "worker-1", epoch: 1, token: "worker-token-secret", expiresAtWallMs: NOW + 10_000 },
        workerEpoch: 1,
        projectionVersion: 9,
        publicSnapshot: null,
        events: [
            { eventIndex: 0, wallMs: NOW - 100_000, simSec: 0, type: "RUN_STARTED", summary: "Run started", operationId: null },
            { eventIndex: 1, wallMs: NOW - 61_000, simSec: 200, type: "COMMAND_ACCEPTED", summary: "Weather command accepted", operationId: commandId },
            { eventIndex: 2, wallMs: NOW - 50_000, simSec: 210, type: "SPEED_CHANGED", summary: "Speed 10x", operationId: "op-speed" },
        ],
        operations: {},
        createdAtWallMs: NOW - 120_000,
        fencedAtWallMs: null,
    }
}

const ready = { status: "READY" as const, detail: null }
const health = { actors: ready, relay: ready, model: ready, worker: ready }

describe("projections", () => {
    const airport = AirportStateSchema.parse(makeAirport())
    const flight = FlightStateSchema.parse(makeFlight())
    const run = SimulationStateSchema.parse(makeRun())

    test("airport is CLOSED with a reason; runways and queue projected", () => {
        const pub = toPublicAirport(airport, 300)
        expect(pub.status).toBe("CLOSED")
        expect(pub.statusReason).toBe("Weather closure")
        expect(pub.runways.map(r => r.status)).toEqual(["CLOSED", "CLOSED"])
        expect(pub.queue.map(q => q.reservationId)).toEqual(["res-c", "res-a", "res-b"])
        expect(pub.stateRevision).toBe(7)
    })

    test("airport status RESTRICTED and OPEN, OCCUPIED runway", () => {
        const restricted = toPublicAirport(
            { ...airport, incidents: {}, restrictions: { ...airport.restrictions, arrivalsClosed: false, closedRunways: ["R1"] } },
            300,
        )
        expect(restricted.status).toBe("RESTRICTED")
        expect(restricted.statusReason).toBe("Runway R1 closed")
        expect(restricted.runways.map(r => r.status)).toEqual(["CLOSED", "OCCUPIED"])
        const open = toPublicAirport({ ...airport, incidents: {}, restrictions: { ...airport.restrictions, arrivalsClosed: false } }, 600)
        expect(open.status).toBe("OPEN")
        expect(open.statusReason).toBeNull()
        expect(open.runways.map(r => r.status)).toEqual(["OPEN", "OPEN"])
    })

    test("flight keeps unexpired OFFERED proposals and the latest decision", () => {
        const pub = toPublicFlight(flight, [airport], NOW)
        expect(pub.proposals.map(p => p.offerId)).toEqual(["off-live"])
        expect(pub.proposals[0]).toEqual({ offerId: "off-live", airportId: "ALP", runwayId: "R1", slotStartSimSec: 750, expiresAtWallMs: NOW + 10_000 })
        expect(pub.lastDecisionSource).toBe("MODEL")
        expect(pub.lastDecisionReason).toBe("Low fuel, nearest open airport")
        expect(pub.negotiationStage).toBe("COLLECTING")
        expect(pub.unresolvedReason).toBeNull()
    })

    test("timeline excludes DOMAIN_ACK and marks refusals", () => {
        const timeline = timelineFromEntities([airport], [flight], run)
        expect(timeline.some(e => e.type === "DOMAIN_ACK")).toBe(false)
        expect(timeline.some(e => e.eventId === ackMsgId)).toBe(false)
        const refused = timeline.find(e => e.eventId === refusedMsgId)
        expect(refused?.status).toBe("REFUSED")
        expect(refused?.summary.startsWith("Unable to accept your landing request: closed.")).toBe(true)
        const request = timeline.find(e => e.eventId === requestMsgId)
        expect(request?.status).toBe("APPLIED")
        expect(request?.summary).toBe("Mayday, declaring an emergency. Request priority landing. We have 14 minutes of fuel remaining.")
        expect(request?.simTimeSec).toBe(290)
        expect(timeline.find(e => e.type === "INCIDENT_CREATE")?.summary).toBe("Weather closure created at ALP")
        const decision = timeline.find(e => e.eventId === "flight:F001:job-new")
        expect(decision?.source).toBe("MODEL")
        expect(decision?.status).toBe("INFO")
        expect(timeline.find(e => e.eventId === `${runId}:event:0`)?.fromEntityId).toBe("system")
        const walls = timeline.map(e => e.wallTimeMs)
        expect(walls).toEqual([...walls].sort((a, b) => a - b))
    })

    test("correlationId is a stable thread key", () => {
        const timeline = timelineFromEntities([airport], [flight], run)
        const key = (eventId: string) => timeline.find(e => e.eventId === eventId)?.correlationId
        expect(key(refusedMsgId)).toBe("neg-1") // payload.negotiationId beats envelope.correlationId
        expect(key(requestMsgId)).toBe("neg-1")
        expect(key(clearanceMsgId)).toBe("neg-2") // no negotiationId in payload: envelope.correlationId
        expect(key(statusMsgId)).toBeNull()
        expect(key(resultMsgId)).toBe(weatherId)
        expect(timeline.find(e => e.type === "INCIDENT_CREATE")?.correlationId).toBe(weatherId)
        expect(key("airport:ALP:job-atc")).toBe("neg-1") // via its relevant LANDING_REQUEST
        expect(key("flight:F001:job-old")).toBeNull()
        expect(key(`${runId}:event:0`)).toBeNull()
        expect(key(`${runId}:event:1`)).toBe(commandId)
        expect(key(`${runId}:event:2`)).toBeNull()
    })

    test("legacy aliases still resolve", () => {
        expect(projectAirport).toBe(toPublicAirport)
        expect(projectIncident(Object.values(airport.incidents)[0]!).incidentId).toBe(weatherId)
    })

    test("summarizePayload formats offers and caps length", () => {
        expect(summarizePayload("LANDING_OFFER", { runwayId: "R1", slotStartSimSec: 750 })).toBe("We can offer runway R1 at T+12:30. Can you accept?")
        expect(summarizePayload("COMMAND_RESULT", { outcome: "APPLIED", code: "OK" })).toBe("Command APPLIED")
        expect(summarizePayload("LANDING_REFUSED", { code: "CLOSED", explanation: "x".repeat(500) }).length).toBeLessThanOrEqual(240)
    })

    test("radio summaries preserve urgency and clearance authority", () => {
        const request = summarizePayload("LANDING_REQUEST", { priority: "NORMAL", fuelRemainingSec: 600 })
        expect(summarizePayload("LANDING_REFUSED", { airportId: "MRY", code: "CLOSED", explanation: "Closed", reasonCode: "RUNWAY_CLOSED", reasonText: "runway closed" })).toBe("Monterey Tower: unable to accept your landing request, runway closed.")
        expect(request).not.toContain("Mayday")
        expect(request).toContain("10 minutes")
        expect(request).not.toContain("smoke")
        expect(summarizePayload("OFFER_ACCEPT", { offerId: "private-offer-id" })).not.toContain("private-offer-id")
        expect(summarizePayload("LANDING_CONFIRMED", { runwayId: "R2", slotStartSimSec: 750 })).toContain("Landing clearance is still required")
        expect(summarizePayload("CLEARANCE_GRANTED", { windowStartSimSec: 750, windowEndSimSec: 780 })).toContain("Cleared to land")
        expect(summarizePayload("CLEARANCE_REFUSED", { code: "RUNWAY_OCCUPIED" })).toBe("Unable to clear you to land: runway occupied.")
    })

    test("buildPublicSnapshot is schema-valid and leaks nothing private", () => {
        const snapshot = buildPublicSnapshot({ run, airports: [airport], flights: [flight], wallNowMs: NOW, projectionVersion: 10, health, agentMode: "live" })
        expect(PublicSnapshotSchema.safeParse(snapshot).success).toBe(true)
        expect(snapshot.incidents.map(i => i.incidentId)).toEqual([lowFuelId, weatherId])
        expect(snapshot.commands).toHaveLength(1)
        expect(snapshot.timeline.length).toBeGreaterThan(0)
        expect(() => assertNoPrivateFields(snapshot)).not.toThrow()
        expect(() => assertNoPrivateFields(airport)).toThrow()
        const json = JSON.stringify(snapshot)
        for (const needle of ["token", "workspaceKey", "inbox", "outbox"]) expect(json).not.toContain(needle)
        expect(json).not.toContain("createdBy")
    })
})
