// Task 3 against the real local Terse runtime (127.0.0.1:7100): controller incident
// commands reach fresh AirportActor / FlightActor instances out of order and duplicated,
// and the persisted aggregate never resurrects a cleared incident.
// Uses a random run ID that is never registered with SimulationActor, so it cannot
// disturb the active demo run.  bun run test:integration -- --filter=incidents
import { beforeAll, describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import {
    AirportStateSchema,
    FlightStateSchema,
    ReceivedEnvelopeSchema,
    SimulationStateSchema,
    entityActorId,
    entityHandle,
    type AirportState,
    type FlightState,
    type IncidentCommand,
    type MutationContext,
    type ReceivedEnvelope,
    type SimulationState,
} from "../../packages/domain/src/contracts.ts"
import { submitCommandToLedger } from "../../packages/domain/src/command-ledger.ts"

const ROOT = resolve(import.meta.dir, "../..")
const runId = crypto.randomUUID()
const uuid = () => crypto.randomUUID()
type Client = Record<string, (...args: unknown[]) => Promise<unknown>>
let actors: Record<string, { get(id: string): Client }> | null = null

beforeAll(async () => {
    try {
        await fetch("http://127.0.0.1:7100/", { signal: AbortSignal.timeout(1000) })
        actors = (await import(join(ROOT, "server/generated/index.js"))).actors
    } catch {
        actors = null
    }
})

const ctx = (simNowSec = 100): MutationContext => ({ runId, workerEpoch: 1, leaseToken: "itest-lease", simNowSec, wallNowMs: Date.now(), operationId: uuid() })

const common = {
    runId,
    stateRevision: 0,
    decisionRevision: 0,
    lastTickId: null,
    lastAdvancedSimSec: 0,
    inbox: {},
    outbox: [],
    jobs: {},
    lastControllerSequence: 0,
    bufferedControllerMessages: [],
    fencing: { workerEpoch: 1, leaseToken: null },
    initializedByOperationId: "itest",
}
const airport = (): AirportState =>
    AirportStateSchema.parse({
        ...common,
        entityId: "airport:ALP",
        airportId: "ALP",
        name: "Alpha",
        position: { x: 50, y: 50 },
        incidents: {},
        restrictions: { arrivalsClosed: false, closedRunways: [], occupancySec: 60, activeIncidentIds: [] },
        statusRevision: 0,
        operationalRevision: 0,
        runways: [
            { runwayId: "R1", occupiedUntilSimSec: null },
            { runwayId: "R2", occupiedUntilSimSec: null },
        ],
        offers: {},
        reservations: {},
        clearances: {},
        touchdowns: {},
    })
const flight = (): FlightState =>
    FlightStateSchema.parse({
        ...common,
        entityId: "flight:F001",
        flightId: "F001",
        callsign: "GHOST 001",
        originalDestination: "ALP",
        position: { x: 80, y: 60 },
        headingDeg: 270,
        speedKnots: 240,
        fuelRemainingSec: 4000,
        phase: "ENROUTE",
        holdCenter: null,
        holdAngle: null,
        incidents: {},
        priority: "NORMAL",
        deadlineSimSec: null,
        knownAirportStatus: {},
        negotiation: null,
        negotiationCounter: 0,
        pendingAcceptance: null,
        activeAssignment: null,
        releaseObligations: [],
        landingReceipt: null,
        terminalReason: null,
    })

function ledger(commands: IncidentCommand[]): SimulationState {
    let sim = SimulationStateSchema.parse({
        runId,
        stateRevision: 0,
        createRequestId: "itest",
        config: { flightCount: 1, seed: 1, speed: 10 },
        phase: "RUNNING",
        entities: [
            { entityId: "controller", handle: entityHandle(runId, "controller"), role: "CONTROLLER" },
            { entityId: "airport:ALP", handle: entityHandle(runId, "airport:ALP"), role: "ATC" },
            { entityId: "flight:F001", handle: entityHandle(runId, "flight:F001"), role: "PILOT" },
        ],
        simNowSec: 100,
        tickCounter: 0,
        pendingTick: null,
        lastCompletedTickId: null,
        commands: {},
        targetSequences: {},
        controllerOutbox: [],
        controllerInbox: {},
        initialization: { steps: [], completedAtWallMs: null },
        workerLease: null,
        workerEpoch: 1,
        projectionVersion: 0,
        publicSnapshot: null,
        events: [],
        operations: {},
        createdAtWallMs: Date.now(),
        fencedAtWallMs: null,
    })
    for (const c of commands) {
        const r = submitCommandToLedger(sim, c, { principalId: "itest", role: "OPERATOR", runId, sessionId: "itest" }, { wallNowMs: Date.now(), authorization: "itest" })
        if (!r.ok) throw new Error(r.code)
        sim = r.state
    }
    return sim
}

function delivered(sim: SimulationState, commandId: string): ReceivedEnvelope {
    const entry = sim.commands[commandId]!
    const envelope = sim.controllerOutbox.find(e => e.envelope.messageId === entry.messageId)!.envelope
    return ReceivedEnvelopeSchema.parse({
        ...envelope,
        transportMessageId: `itest-${envelope.messageId}`,
        senderHandle: entityHandle(runId, "controller"),
        recipientHandle: entityHandle(runId, envelope.toEntityId),
        receivedAtWallMs: Date.now(),
    })
}

describe("incident commands on real Terse actors", () => {
    test("clear before create, duplicate create: applied in sequence and never resurrected", async () => {
        if (!actors) return console.warn("NOT RUN: Terse runtime on 7100 unavailable")
        const a = actors.AirportActor!.get(entityActorId(runId, "airport:ALP"))
        expect(await a.initialize!(ctx(), airport())).toMatchObject({ outcome: "APPLIED" })

        const incidentId = uuid()
        const create: IncidentCommand = { commandId: uuid(), runId, type: "INCIDENT_CREATE", payload: { incidentId, target: "airport:ALP", kind: "WEATHER_CLOSED", parameters: {} } }
        const clear: IncidentCommand = { commandId: uuid(), runId, type: "INCIDENT_CLEAR", payload: { incidentId, target: "airport:ALP", expectedIncidentRevision: 1 } }
        const sim = ledger([create, clear])

        expect(await a.receive!(ctx(), delivered(sim, clear.commandId))).toMatchObject({ outcome: "REJECTED", code: "BUFFERED" })
        let state = (await a.read!()) as AirportState
        expect(state.incidents).toEqual({})
        expect(state.bufferedControllerMessages).toHaveLength(1)

        expect(await a.receive!(ctx(110), delivered(sim, create.commandId))).toMatchObject({ outcome: "APPLIED" })
        state = (await a.read!()) as AirportState
        expect(state.lastControllerSequence).toBe(2)
        expect(state.incidents[incidentId]).toMatchObject({ status: "RESOLVED", revision: 2 })
        expect(state.restrictions.arrivalsClosed).toBe(false)
        expect(state.outbox.filter(e => e.envelope.type === "COMMAND_RESULT")).toHaveLength(2)

        expect(await a.receive!(ctx(500), delivered(sim, create.commandId))).toMatchObject({ outcome: "DUPLICATE" })
        const after = (await a.read!()) as AirportState
        expect(after.incidents[incidentId]!.status).toBe("RESOLVED")
        expect(after.stateRevision).toBe(state.stateRevision)
    })

    test("smoke on a flight declares an emergency and opens an urgent round in one write", async () => {
        if (!actors) return console.warn("NOT RUN: Terse runtime on 7100 unavailable")
        const f = actors.FlightActor!.get(entityActorId(runId, "flight:F001"))
        expect(await f.initialize!(ctx(), flight())).toMatchObject({ outcome: "APPLIED" })
        const smoke: IncidentCommand = { commandId: uuid(), runId, type: "INCIDENT_CREATE", payload: { incidentId: uuid(), target: "flight:F001", kind: "SMOKE", parameters: {} } }
        expect(await f.receive!(ctx(200), delivered(ledger([smoke]), smoke.commandId))).toMatchObject({ outcome: "APPLIED" })
        const state = (await f.read!()) as FlightState
        expect(state.priority).toBe("EMERGENCY")
        expect(state.deadlineSimSec).toBe(1100)
        expect(state.negotiation?.trigger).toBe("EMERGENCY")
        expect(state.outbox.some(e => e.envelope.type === "COMMAND_RESULT")).toBe(true)
    })
})
