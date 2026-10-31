import { describe, expect, test } from "bun:test"
import {
    AirportStateSchema,
    FlightStateSchema,
    ReceivedEnvelopeSchema,
    SimulationStateSchema,
    entityHandle,
    type AirportState,
    type ControllerPrincipal,
    type FlightState,
    type IncidentCommand,
    type OutboxEntry,
    type ReceivedEnvelope,
    type SimulationState,
} from "../../packages/domain/src/contracts.ts"
import {
    BUFFERED_CODE,
    applyIncident,
    deriveAirportConditions,
    deriveFlightConditions,
    receiveControllerCommand,
    resolveIncident,
    type ControllerCommandEnvelope,
    type IncidentContext,
} from "../../packages/domain/src/incidents.ts"
import {
    PARKED_AT_WALL_MS,
    applyCommandResult,
    dueControllerOutbox,
    markControllerCommandSent,
    readCommandReceipt,
    refreshDelayedCommands,
    submitCommandToLedger,
} from "../../packages/domain/src/command-ledger.ts"
import { stableUuid } from "../../packages/domain/src/stable-id.ts"

const runId = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"
const otherRunId = "0b2e4c6a-8d1f-4a3b-9c5e-7f9a1b3c5d7e"
const uuid = () => crypto.randomUUID()
const T0 = 1_761_930_000_000

function ctx(simNowSec = 100, wallNowMs = T0): IncidentContext {
    return { runId, simNowSec, wallNowMs }
}

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
    initializedByOperationId: "init-1",
}

function airport(): AirportState {
    return AirportStateSchema.parse({
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
}

function flight(overrides: Partial<FlightState> = {}): FlightState {
    return FlightStateSchema.parse({
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
        ...overrides,
    })
}

const weather = (incidentId = uuid()) => ({ incidentId, target: "airport:ALP" as const, kind: "WEATHER_CLOSED" as const, parameters: {} })
const runway = (runwayId: "R1" | "R2", incidentId = uuid()) => ({ incidentId, target: "airport:ALP" as const, kind: "RUNWAY_CLOSED" as const, parameters: { runwayId } })
const capacity = (incidentId = uuid()) => ({ incidentId, target: "airport:ALP" as const, kind: "CAPACITY_REDUCED" as const, parameters: {} })
const flightIncident = (kind: "SMOKE" | "ENGINE_TROUBLE" | "LOW_FUEL", incidentId = uuid()) => ({ incidentId, target: "flight:F001" as const, kind, parameters: {} })
const clear = (incidentId: string, target: "airport:ALP" | "flight:F001", expectedIncidentRevision = 1) => ({ incidentId, target, expectedIncidentRevision })

describe("airport incidents", () => {
    test("two weather closures keep ALP closed after clearing only one", () => {
        const a = weather()
        const b = weather()
        let s = applyIncident(airport(), a, ctx()).state
        s = applyIncident(s, b, ctx(110)).state
        expect(deriveAirportConditions(s).status).toBe("CLOSED")
        const r = resolveIncident(s, clear(a.incidentId, "airport:ALP"), ctx(120))
        expect(r.result.outcome).toBe("APPLIED")
        expect(r.state.restrictions.arrivalsClosed).toBe(true)
        expect(deriveAirportConditions(r.state).status).toBe("CLOSED")
        expect(r.state.incidents[a.incidentId]!.status).toBe("RESOLVED")
        const open = resolveIncident(r.state, clear(b.incidentId, "airport:ALP"), ctx(130)).state
        expect(open.restrictions.arrivalsClosed).toBe(false)
        expect(deriveAirportConditions(open).status).toBe("OPEN")
        expect(AirportStateSchema.safeParse(open).success).toBe(true)
    })

    test("RUNWAY_CLOSED R1 leaves R2 available", () => {
        const s = applyIncident(airport(), runway("R1"), ctx()).state
        const c = deriveAirportConditions(s)
        expect(c.openRunways).toEqual(["R2"])
        expect(c.status).toBe("RESTRICTED")
        expect(s.restrictions).toMatchObject({ arrivalsClosed: false, closedRunways: ["R1"] })
    })

    test("both runways closed by separate incidents closes arrivals", () => {
        let s = applyIncident(airport(), runway("R1"), ctx()).state
        s = applyIncident(s, runway("R2"), ctx()).state
        expect(s.restrictions.arrivalsClosed).toBe(true)
        expect(deriveAirportConditions(s).status).toBe("CLOSED")
    })

    test("reduced capacity gives 120-second occupancy and clearing restores 60", () => {
        const inc = capacity()
        const s = applyIncident(airport(), inc, ctx()).state
        expect(s.restrictions.occupancySec).toBe(120)
        expect(deriveAirportConditions(s).status).toBe("RESTRICTED")
        expect(resolveIncident(s, clear(inc.incidentId, "airport:ALP"), ctx()).state.restrictions.occupancySec).toBe(60)
    })

    test("closure revokes live offers, reservations and clearances, notifies flights, spares occupied runway time", () => {
        const base = airport()
        const offerBase = { negotiationId: "n1", airportId: "ALP" as const, slotStartSimSec: 600, occupancySec: 60, expiresAtWallMs: T0 + 20_000, airportOperationalRevision: 0, requestMessageId: uuid(), priority: "NORMAL" as const }
        const s0: AirportState = {
            ...base,
            offers: {
                o1: { ...offerBase, offerId: "o1", runwayId: "R1", flightId: "F002", status: "OFFERED" },
                o2: { ...offerBase, offerId: "o2", runwayId: "R2", flightId: "F003", status: "OFFERED" },
            },
            reservations: {
                r1: { ...offerBase, offerId: "o9", runwayId: "R1", flightId: "F004", reservationId: "r1", status: "CONFIRMED" },
                r2: { ...offerBase, offerId: "o8", runwayId: "R1", flightId: "F005", reservationId: "r2", status: "CLEARED" },
                r3: { ...offerBase, offerId: "o7", runwayId: "R1", flightId: "F006", reservationId: "r3", status: "OCCUPIED" },
                r4: { ...offerBase, offerId: "o6", runwayId: "R2", flightId: "F007", reservationId: "r4", status: "CONFIRMED" },
            },
            clearances: {
                c2: { clearanceId: "c2", reservationId: "r2", flightId: "F005", runwayId: "R1", windowStartSimSec: 600, windowEndSimSec: 630, airportOperationalRevision: 0, status: "ACTIVE" },
            },
        }
        // Runway closure touches only R1 arrangements.
        const r = applyIncident(s0, runway("R1"), ctx())
        expect(r.state.offers.o1!.status).toBe("REVOKED")
        expect(r.state.offers.o2!.status).toBe("OFFERED")
        expect(r.state.reservations.r1!.status).toBe("REVOKED")
        expect(r.state.reservations.r2!.status).toBe("REVOKED")
        expect(r.state.reservations.r3!.status).toBe("OCCUPIED")
        expect(r.state.reservations.r4!.status).toBe("CONFIRMED")
        expect(r.state.clearances.c2!.status).toBe("REVOKED")
        expect(r.state.operationalRevision).toBe(1)
        const revoked = r.state.outbox.filter(e => e.envelope.type === "RESERVATION_REVOKED").map(e => e.envelope.toEntityId)
        expect(revoked.sort()).toEqual(["flight:F004", "flight:F005"])
        const statusTo = r.state.outbox.filter(e => e.envelope.type === "AIRPORT_STATUS").map(e => e.envelope.toEntityId)
        expect(statusTo).toContain("flight:F002")
        expect(statusTo).toContain("flight:F007")
        expect(statusTo).not.toContain("flight:F006")
        expect(AirportStateSchema.safeParse(r.state).success).toBe(true)

        // Weather then closes everything still live, and clearing reopens without un-revoking.
        const w = weather()
        const closed = applyIncident(r.state, w, ctx(150)).state
        expect(closed.offers.o2!.status).toBe("REVOKED")
        expect(closed.reservations.r4!.status).toBe("REVOKED")
        expect(closed.reservations.r3!.status).toBe("OCCUPIED")
        const reopened = resolveIncident(closed, clear(w.incidentId, "airport:ALP"), ctx(200)).state
        expect(reopened.reservations.r4!.status).toBe("REVOKED")
        expect(reopened.restrictions.closedRunways).toEqual(["R1"])
        expect(reopened.statusRevision).toBeGreaterThan(closed.statusRevision)
    })

    test("flight kinds are refused on an airport, airport kinds on a flight", () => {
        expect(applyIncident(airport(), { ...flightIncident("SMOKE"), target: "airport:ALP" } as never, ctx()).code).toBe("INVALID_PAYLOAD")
        expect(applyIncident(flight(), { ...weather(), target: "flight:F001" } as never, ctx()).code).toBe("INVALID_PAYLOAD")
        expect(applyIncident(flight(), weather(), ctx()).code).toBe("UNAUTHORIZED")
    })
})

describe("flight incidents", () => {
    test("smoke creates EMERGENCY with a 900-second deadline", () => {
        const r = applyIncident(flight(), flightIncident("SMOKE"), ctx(300))
        expect(r.state.priority).toBe("EMERGENCY")
        expect(r.state.deadlineSimSec).toBe(1200)
        expect(r.events.find(e => e.type === "FLIGHT_CONDITIONS_CHANGED")).toMatchObject({ renegotiate: true })
        expect(FlightStateSchema.safeParse(r.state).success).toBe(true)
    })

    test("engine trouble sets 1200-second deadline and 180 kt; resolving restores speed but not fuel or position", () => {
        const inc = flightIncident("ENGINE_TROUBLE")
        const s = applyIncident(flight(), inc, ctx(100)).state
        expect(s.speedKnots).toBe(180)
        expect(s.deadlineSimSec).toBe(1300)
        expect(s.priority).toBe("EMERGENCY")
        const moved: FlightState = { ...s, fuelRemainingSec: 3700, position: { x: 70, y: 58 }, lastAdvancedSimSec: 400 }
        const r = resolveIncident(moved, clear(inc.incidentId, "flight:F001"), ctx(400)).state
        expect(r.speedKnots).toBe(240)
        expect(r.fuelRemainingSec).toBe(3700)
        expect(r.position).toEqual({ x: 70, y: 58 })
        expect(r.priority).toBe("NORMAL")
        expect(r.deadlineSimSec).toBeNull()
        expect(r.incidents[inc.incidentId]).toMatchObject({ status: "RESOLVED", resolvedAtSimSec: 400, revision: 2 })
    })

    test("deadline is the earliest active one", () => {
        let s = applyIncident(flight(), flightIncident("ENGINE_TROUBLE"), ctx(0)).state
        const smoke = flightIncident("SMOKE")
        s = applyIncident(s, smoke, ctx(200)).state
        expect(s.deadlineSimSec).toBe(1100)
        s = resolveIncident(s, clear(smoke.incidentId, "flight:F001"), ctx(250)).state
        expect(s.deadlineSimSec).toBe(1200)
        expect(s.speedKnots).toBe(180)
    })

    test("LOW_FUEL caps once; duplicate after burn does not refuel; clearing keeps fuel and urgency", () => {
        const inc = flightIncident("LOW_FUEL")
        const capped = applyIncident(flight(), inc, ctx(100)).state
        expect(capped.fuelRemainingSec).toBe(900)
        expect(capped.priority).toBe("EMERGENCY")
        const burned: FlightState = { ...capped, fuelRemainingSec: 800, lastAdvancedSimSec: 200 }
        const dup = applyIncident(burned, inc, ctx(200))
        expect(dup.result.outcome).toBe("APPLIED")
        expect(dup.state).toBe(burned)
        expect(dup.state.fuelRemainingSec).toBe(800)
        const cleared = resolveIncident(burned, clear(inc.incidentId, "flight:F001"), ctx(210)).state
        expect(cleared.fuelRemainingSec).toBe(800)
        expect(cleared.priority).toBe("EMERGENCY")
        expect(deriveFlightConditions(cleared).emergencyReasons).toEqual(["LOW_FUEL"])
    })

    test("a terminal flight rejects new incidents", () => {
        const r = applyIncident(flight({ phase: "LANDED" }), flightIncident("SMOKE"), ctx())
        expect(r.result.outcome).toBe("REJECTED")
        expect(r.code).toBe("ALREADY_TERMINAL")
    })
})

describe("incident identity and clears", () => {
    test("same incident ID with different contents is a conflict", () => {
        const id = uuid()
        const s = applyIncident(airport(), runway("R1", id), ctx()).state
        const r = applyIncident(s, runway("R2", id), ctx())
        expect(r.code).toBe("REVISION_CONFLICT")
        expect(r.state).toBe(s)
    })

    test("repeated clear of a resolved incident succeeds idempotently", () => {
        const inc = weather()
        const s = applyIncident(airport(), inc, ctx()).state
        const once = resolveIncident(s, clear(inc.incidentId, "airport:ALP", 1), ctx())
        const twice = resolveIncident(once.state, clear(inc.incidentId, "airport:ALP", 1), ctx())
        expect(twice.result.outcome).toBe("APPLIED")
        expect(twice.incidentRevision).toBe(2)
        expect(twice.state).toBe(once.state)
    })

    test("unknown clear rejects and a stale revision conflicts", () => {
        expect(resolveIncident(airport(), clear(uuid(), "airport:ALP"), ctx()).code).toBe("UNKNOWN_INCIDENT")
        const inc = weather()
        const s = applyIncident(airport(), inc, ctx()).state
        const stale = resolveIncident(s, clear(inc.incidentId, "airport:ALP", 7), ctx())
        expect(stale.code).toBe("REVISION_CONFLICT")
        expect(stale.state.incidents[inc.incidentId]!.status).toBe("ACTIVE")
    })

    test("a delayed create for a resolved ID never reactivates it", () => {
        const inc = weather()
        let s = applyIncident(airport(), inc, ctx()).state
        s = resolveIncident(s, clear(inc.incidentId, "airport:ALP"), ctx()).state
        const late = applyIncident(s, inc, ctx(500))
        expect(late.result.outcome).toBe("REJECTED")
        expect(late.code).toBe("ALREADY_TERMINAL")
        expect(late.state.incidents[inc.incidentId]!.status).toBe("RESOLVED")
        expect(late.state.restrictions.arrivalsClosed).toBe(false)
    })

    test("wrong run is rejected without change", () => {
        const r = applyIncident(airport(), weather(), { ...ctx(), runId: otherRunId })
        expect(r.code).toBe("WRONG_RUN")
        expect(r.state.incidents).toEqual({})
    })
})

// ---------------------------------------------------------------- command ordering

const principal: ControllerPrincipal = { principalId: "phone-1", role: "CONTROLLER", runId, sessionId: "sess-1" }

function simulation(): SimulationState {
    return SimulationStateSchema.parse({
        runId,
        stateRevision: 0,
        createRequestId: "req-1",
        config: { flightCount: 10, seed: 20261031, speed: 10 },
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
        createdAtWallMs: T0,
        fencedAtWallMs: null,
    })
}

const createCmd = (payload: ReturnType<typeof weather> | ReturnType<typeof flightIncident>): IncidentCommand => ({ commandId: uuid(), runId, type: "INCIDENT_CREATE", payload })
const clearCmd = (incidentId: string, target: "airport:ALP" | "flight:F001", rev = 1): IncidentCommand => ({
    commandId: uuid(),
    runId,
    type: "INCIDENT_CLEAR",
    payload: { incidentId, target, expectedIncidentRevision: rev },
})

/** What the Relay router hands the actor: the stored envelope plus transport fields. */
function deliver<E extends OutboxEntry["envelope"]>(envelope: E, at = T0): ReceivedEnvelope {
    return ReceivedEnvelopeSchema.parse({
        ...envelope,
        transportMessageId: `t-${envelope.messageId}`,
        senderHandle: entityHandle(envelope.runId, envelope.fromEntityId),
        recipientHandle: entityHandle(envelope.runId, envelope.toEntityId),
        receivedAtWallMs: at,
    })
}

function submit(sim: SimulationState, command: IncidentCommand, wallNowMs = T0) {
    const r = submitCommandToLedger(sim, command, principal, { wallNowMs, authorization: "sig" })
    if (!r.ok) throw new Error(`submit failed: ${r.code}`)
    return r
}

function envelopeFor(sim: SimulationState, commandId: string): ControllerCommandEnvelope {
    const entry = sim.commands[commandId]!
    const out = sim.controllerOutbox.find(e => e.envelope.messageId === entry.messageId)!
    return deliver(out.envelope) as ControllerCommandEnvelope
}

function resultsFrom(state: AirportState | FlightState) {
    return state.outbox.filter(e => e.envelope.type === "COMMAND_RESULT").map(e => deliver(e.envelope) as Extract<ReceivedEnvelope, { type: "COMMAND_RESULT" }>)
}

describe("controller ledger", () => {
    test("dedups the commandId, conflicts on changed content, sequences per target", () => {
        const cmd = createCmd(weather())
        const a = submit(simulation(), cmd)
        expect(a.receipt.status).toBe("QUEUED")
        expect(a.state.commands[cmd.commandId]!.commandSequence).toBe(1)
        const again = submit(a.state, cmd)
        expect(again.duplicate).toBe(true)
        expect(again.state).toBe(a.state)
        const changed = submitCommandToLedger(a.state, { ...cmd, payload: weather() }, principal, { wallNowMs: T0, authorization: "sig" })
        expect(changed).toMatchObject({ ok: false, httpStatus: 409, code: "COMMAND_ID_CONFLICT" })
        const b = submit(a.state, createCmd(flightIncident("SMOKE")))
        const c = submit(b.state, createCmd(weather()))
        expect(b.state.commands[Object.keys(b.state.commands)[1]!]!.commandSequence).toBe(1)
        expect(c.state.targetSequences).toEqual({ "airport:ALP": 2, "flight:F001": 1 })
        expect(SimulationStateSchema.safeParse(c.state).success).toBe(true)
    })

    test("rejects wrong run, wrong phase and unknown targets", () => {
        const wrongRun = submitCommandToLedger(simulation(), { ...createCmd(weather()), runId: otherRunId }, principal, { wallNowMs: T0, authorization: "s" })
        expect(wrongRun).toMatchObject({ ok: false, code: "WRONG_RUN" })
        const configuring = submitCommandToLedger({ ...simulation(), phase: "CONFIGURING" }, createCmd(weather()), principal, { wallNowMs: T0, authorization: "s" })
        expect(configuring).toMatchObject({ ok: false, code: "WRONG_PHASE" })
        const unknown = submitCommandToLedger(simulation(), createCmd({ ...flightIncident("SMOKE"), target: "flight:F009" } as never), principal, { wallNowMs: T0, authorization: "s" })
        expect(unknown).toMatchObject({ ok: false, httpStatus: 404, code: "UNKNOWN_ENTITY" })
        const extra = submitCommandToLedger(simulation(), { ...createCmd(weather()), priority: "HIGH" }, principal, { wallNowMs: T0, authorization: "s" })
        expect(extra).toMatchObject({ ok: false, httpStatus: 400 })
    })

    test("only one unresolved command per target is dispatchable; the result releases the next", () => {
        const inc = weather()
        const create = createCmd(inc)
        const clr = clearCmd(inc.incidentId, "airport:ALP")
        let sim = submit(simulation(), create).state
        sim = submit(sim, clr, T0 + 1000).state
        expect(dueControllerOutbox(sim, T0 + 1000).map(e => e.envelope.messageId)).toEqual([sim.commands[create.commandId]!.messageId])
        expect(sim.controllerOutbox[1]!.nextAttemptAtWallMs).toBe(PARKED_AT_WALL_MS)

        sim = markControllerCommandSent(sim, sim.commands[create.commandId]!.messageId, "relay-1", T0 + 2000)
        expect(readCommandReceipt(sim, create.commandId)!.status).toBe("SENT")
        sim = refreshDelayedCommands(sim, T0 + 16_000)
        expect(readCommandReceipt(sim, create.commandId)!.status).toBe("DELAYED")
        expect(readCommandReceipt(sim, clr.commandId)!.status).toBe("QUEUED")

        const target = receiveControllerCommand(airport(), envelopeFor(sim, create.commandId), ctx(100, T0 + 17_000))
        const [result] = resultsFrom(target.state)
        const applied = applyCommandResult(sim, result!, T0 + 20_000)
        sim = applied.state
        expect(readCommandReceipt(sim, create.commandId)).toMatchObject({ status: "APPLIED", code: "OK", resultingRevision: 1 })
        expect(dueControllerOutbox(sim, T0 + 20_000).map(e => e.envelope.messageId)).toEqual([sim.commands[clr.commandId]!.messageId])

        // A duplicated result changes nothing and APPLIED never regresses.
        const dup = applyCommandResult(sim, result!, T0 + 21_000)
        expect(dup.result.outcome).toBe("DUPLICATE")
        expect(dup.state).toBe(sim)
        expect(refreshDelayedCommands(sim, T0 + 90_000).commands[create.commandId]!.receipt.status).toBe("APPLIED")
    })

    test("a result from the wrong sender is ignored", () => {
        const create = createCmd(weather())
        const sim = submit(simulation(), create).state
        const target = receiveControllerCommand(airport(), envelopeFor(sim, create.commandId), ctx())
        const forged = { ...resultsFrom(target.state)[0]!, messageId: uuid(), fromEntityId: "flight:F001" as const }
        const r = applyCommandResult(sim, forged, T0)
        expect(r.result).toMatchObject({ outcome: "REJECTED", code: "UNAUTHORIZED" })
        expect(readCommandReceipt(r.state, create.commandId)!.status).toBe("QUEUED")
    })
})

describe("target-side command ordering (review focus 1)", () => {
    function ledgerWith(...commands: IncidentCommand[]) {
        let sim = simulation()
        for (const c of commands) sim = submit(sim, c).state
        return sim
    }

    test("sequence 2 clear arriving before sequence 1 create waits, then both apply in order", () => {
        const inc = weather()
        const create = createCmd(inc)
        const clr = clearCmd(inc.incidentId, "airport:ALP")
        const sim = ledgerWith(create, clr)
        const createEnv = envelopeFor(sim, create.commandId)
        const clearEnv = envelopeFor(sim, clr.commandId)
        expect(clearEnv.commandSequence).toBe(2)

        const early = receiveControllerCommand(airport(), clearEnv, ctx(100))
        expect(early.result).toMatchObject({ outcome: "REJECTED", code: BUFFERED_CODE })
        expect(early.processed).toEqual([])
        expect(early.state.incidents).toEqual({})
        expect(early.state.bufferedControllerMessages.map(b => b.commandSequence)).toEqual([2])
        // The clear redelivered while buffered stays buffered once.
        const again = receiveControllerCommand(early.state, clearEnv, ctx(100))
        expect(again.state).toBe(early.state)

        const r = receiveControllerCommand(early.state, createEnv, ctx(110))
        expect(r.processed.map(p => [p.commandSequence, p.outcome, p.code])).toEqual([
            [1, "APPLIED", "OK"],
            [2, "APPLIED", "OK"],
        ])
        expect(r.state.incidents[inc.incidentId]).toMatchObject({ status: "RESOLVED", revision: 2 })
        expect(r.state.restrictions.arrivalsClosed).toBe(false)
        expect(r.state.lastControllerSequence).toBe(2)
        expect(r.state.bufferedControllerMessages).toEqual([])
        expect(resultsFrom(r.state).map(e => e.payload.commandId)).toEqual([create.commandId, clr.commandId])
        expect(AirportStateSchema.safeParse(r.state).success).toBe(true)

        // Delayed duplicate of the original create: deduplicated, never reactivates.
        const late = receiveControllerCommand(r.state, createEnv, ctx(500, T0 + 60_000))
        expect(late.result).toMatchObject({ outcome: "DUPLICATE", original: { outcome: "APPLIED" } })
        expect(late.state.incidents[inc.incidentId]!.status).toBe("RESOLVED")
        expect(late.state.restrictions.arrivalsClosed).toBe(false)
        expect(resultsFrom(late.state)).toHaveLength(2)
    })

    test("a new create command reusing a resolved incident ID is rejected and consumes its sequence", () => {
        const inc = flightIncident("SMOKE")
        const create = createCmd(inc)
        const clr = clearCmd(inc.incidentId, "flight:F001")
        const retry = createCmd(inc)
        const sim = ledgerWith(create, clr, retry)
        let s = flight()
        for (const id of [create.commandId, clr.commandId, retry.commandId]) s = receiveControllerCommand(s, envelopeFor(sim, id), ctx(100)).state
        expect(s.incidents[inc.incidentId]!.status).toBe("RESOLVED")
        expect(s.priority).toBe("NORMAL")
        expect(s.lastControllerSequence).toBe(3)
        const last = resultsFrom(s).at(-1)!
        expect(last.payload).toMatchObject({ commandId: retry.commandId, outcome: "REJECTED", code: "ALREADY_TERMINAL", resultingRevision: 2 })
    })

    test("full loop through ledger and target in shuffled delivery order", () => {
        const a = weather()
        const b = weather()
        const cmds = [createCmd(a), createCmd(b), clearCmd(a.incidentId, "airport:ALP")]
        const sim = ledgerWith(...cmds)
        const envs = cmds.map(c => envelopeFor(sim, c.commandId))
        let s = airport()
        for (const env of [envs[2]!, envs[1]!, envs[2]!, envs[0]!, envs[1]!]) s = receiveControllerCommand(s, env, ctx(100)).state
        expect(s.lastControllerSequence).toBe(3)
        expect(s.incidents[a.incidentId]!.status).toBe("RESOLVED")
        expect(s.incidents[b.incidentId]!.status).toBe("ACTIVE")
        expect(s.restrictions.arrivalsClosed).toBe(true)
        expect(resultsFrom(s)).toHaveLength(3)

        let ledger = sim
        for (const result of resultsFrom(s)) ledger = applyCommandResult(ledger, result, T0 + 5000).state
        expect(cmds.map(c => readCommandReceipt(ledger, c.commandId)!.status)).toEqual(["APPLIED", "APPLIED", "APPLIED"])
        expect(dueControllerOutbox(ledger, T0 + 5000)).toEqual([])
    })

    test("expired and terminal-flight commands still consume their sequence", () => {
        const smoke = createCmd(flightIncident("SMOKE"))
        const engine = createCmd(flightIncident("ENGINE_TROUBLE"))
        const sim = ledgerWith(smoke, engine)
        const expired = receiveControllerCommand(flight(), envelopeFor(sim, smoke.commandId), ctx(100, T0 + 61_000))
        expect(expired.processed[0]).toMatchObject({ outcome: "REJECTED", code: "TIMEOUT" })
        expect(expired.state.lastControllerSequence).toBe(1)
        expect(expired.state.priority).toBe("NORMAL")
        const landed = receiveControllerCommand({ ...expired.state, phase: "LANDED" }, envelopeFor(sim, engine.commandId), ctx())
        expect(landed.processed[0]).toMatchObject({ outcome: "REJECTED", code: "ALREADY_TERMINAL" })
        expect(landed.state.lastControllerSequence).toBe(2)
    })

    test("wrong run or non-controller sender is refused without touching the sequence", () => {
        const create = createCmd(weather())
        const env = envelopeFor(ledgerWith(create), create.commandId)
        const forged = receiveControllerCommand(airport(), { ...env, messageId: uuid(), fromEntityId: "flight:F001" } as ControllerCommandEnvelope, ctx())
        expect(forged.result.code).toBe("UNAUTHORIZED")
        expect(forged.state.lastControllerSequence).toBe(0)
        expect(forged.state.outbox).toEqual([])
        const otherRun = receiveControllerCommand({ ...airport(), runId: otherRunId }, env, { ...ctx(), runId: otherRunId })
        expect(otherRun.result.code).toBe("WRONG_RUN")
        expect(otherRun.state.lastControllerSequence).toBe(0)
    })

    test("re-running the same receive yields identical message IDs (crash before save)", () => {
        const create = createCmd(weather())
        const env = envelopeFor(ledgerWith(create), create.commandId)
        const s0: AirportState = { ...airport(), offers: {} }
        const one = receiveControllerCommand(s0, env, ctx())
        const two = receiveControllerCommand(s0, env, ctx())
        expect(one.state.outbox.map(e => e.envelope.messageId)).toEqual(two.state.outbox.map(e => e.envelope.messageId))
        expect(stableUuid("a", 1)).toBe(stableUuid("a", 1))
        expect(ReceivedEnvelopeSchema.safeParse(deliver(one.state.outbox[0]!.envelope)).success).toBe(true)
    })
})
