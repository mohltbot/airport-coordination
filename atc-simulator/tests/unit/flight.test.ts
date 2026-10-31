import { describe, expect, test } from "bun:test"
import type { Assignment, FlightState, MutationContext, Tick, TouchdownReceipt } from "../../packages/domain/src/contracts.ts"
import {
    AIRPORT_POSITION,
    advanceFlight,
    applyApproachGuard,
    clearanceDue,
    recordFlightTouchdown,
    touchdownReady,
} from "../../packages/domain/src/flight.ts"
import { distanceNm } from "../../packages/domain/src/geometry.ts"

const runId = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"

function flight(overrides: Partial<FlightState> = {}): FlightState {
    return {
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
        fencing: { workerEpoch: 1, leaseToken: "lease" },
        initializedByOperationId: "init",
        entityId: "flight:F001",
        flightId: "F001",
        callsign: "GHOST 001",
        originalDestination: "ALP",
        // 40 NM east of Alpha.
        position: { x: 90, y: 50 },
        headingDeg: 270,
        speedKnots: 240,
        fuelRemainingSec: 3600,
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
    }
}

function ctx(simNowSec: number, wallNowMs = 1_000): MutationContext {
    return { runId, workerEpoch: 1, leaseToken: "lease", simNowSec, wallNowMs, operationId: `op-${simNowSec}` }
}
let tickSeq = 0
function tick(from: number, to: number): Tick {
    return { tickId: `t${++tickSeq}`, fromSimSec: from, toSimSec: to }
}
function run(state: FlightState, from: number, to: number, step = 2.5): FlightState {
    let s = state
    for (let t = from; t < to - 1e-9; t += step) {
        s = advanceFlight(s, tick(t, Math.min(to, t + step)), ctx(Math.min(to, t + step))).state
    }
    return s
}
const closed = (airportId: "ALP" | "BRV" | "CHR") => ({
    airportId,
    statusRevision: 1,
    restrictions: { arrivalsClosed: true, closedRunways: [], occupancySec: 60, activeIncidentIds: [] },
})

describe("movement and fuel", () => {
    test("240 kt travels 4 NM and burns 60 in 60 s", () => {
        const s = advanceFlight(flight(), tick(0, 60), ctx(60)).state
        expect(s.position.x).toBeCloseTo(86, 6)
        expect(s.position.y).toBeCloseTo(50, 6)
        expect(s.fuelRemainingSec).toBe(3540)
        expect(s.headingDeg).toBeCloseTo(270, 6)
        expect(s.lastAdvancedSimSec).toBe(60)
    })

    test("180 kt engine trouble travels 3 NM and burns 60 in 60 s", () => {
        const s = advanceFlight(flight({ speedKnots: 180 }), tick(0, 60), ctx(60)).state
        expect(s.position.x).toBeCloseTo(87, 6)
        expect(s.fuelRemainingSec).toBe(3540)
    })

    test("a paused clock (empty interval) changes neither position nor fuel", () => {
        const base = advanceFlight(flight(), tick(0, 60), ctx(60)).state
        const paused = advanceFlight(base, tick(60, 60), ctx(60))
        expect(paused.state.position).toEqual(base.position)
        expect(paused.state.fuelRemainingSec).toBe(base.fuelRemainingSec)
        expect(paused.result.code).toBe("STALE_STATE")
    })

    test("the same tick applied twice changes fuel and position once", () => {
        const t = tick(0, 60)
        const once = advanceFlight(flight(), t, ctx(60))
        const twice = advanceFlight(once.state, t, ctx(60))
        expect(twice.result.outcome).toBe("DUPLICATE")
        expect(twice.state).toBe(once.state)
        // A different tick ID covering already-applied time is also a no-op.
        const replay = advanceFlight(once.state, tick(0, 60), ctx(60))
        expect(replay.state.fuelRemainingSec).toBe(3540)
        expect(replay.state.position).toEqual(once.state.position)
    })

    test("movement stops at the 6 NM boundary instead of overshooting, then holds", () => {
        // 34 NM to the boundary takes 510 s; give it 600 s in one tick.
        const s = advanceFlight(flight(), tick(0, 600), ctx(600)).state
        expect(distanceNm(s.position, AIRPORT_POSITION.ALP)).toBeCloseTo(6, 6)
        expect(s.phase).toBe("HOLDING")
        expect(s.holdCenter).toEqual(AIRPORT_POSITION.ALP)
    })

    test("holding burns fuel and stays on a stable 6 NM orbit", () => {
        let s = run(flight(), 0, 600)
        const fuelAt600 = s.fuelRemainingSec
        for (let i = 0; i < 20; i++) {
            s = run(s, 600 + i * 30, 630 + i * 30)
            expect(distanceNm(s.position, AIRPORT_POSITION.ALP)).toBeCloseTo(6, 6)
        }
        expect(s.fuelRemainingSec).toBeCloseTo(fuelAt600 - 600, 6)
        expect(s.phase).toBe("HOLDING")
    })

    test("a closed destination without assignment holds in place without teleporting", () => {
        const start = flight({ knownAirportStatus: { ALP: closed("ALP") } })
        const s = advanceFlight(start, tick(0, 0.001), ctx(0.001)).state
        expect(s.phase).toBe("HOLDING")
        expect(s.holdCenter).toEqual({ x: 84, y: 50 })
        expect(distanceNm(s.position, start.position)).toBeLessThan(0.01)
        const later = run(s, 0.001, 300)
        expect(distanceNm(later.position, { x: 84, y: 50 })).toBeCloseTo(6, 6)
    })

    test("at zero fuel the flight becomes UNRESOLVED once and releases its booking", () => {
        const assignment: Assignment = { airportId: "ALP", runwayId: "R1", reservationId: "res-1", slotStartSimSec: 5000, occupancySec: 60, clearanceId: null }
        const s1 = advanceFlight(flight({ fuelRemainingSec: 30, activeAssignment: assignment }), tick(0, 60), ctx(60)).state
        expect(s1.phase).toBe("UNRESOLVED")
        expect(s1.terminalReason).toBe("FUEL_EXHAUSTED")
        expect(s1.fuelRemainingSec).toBe(0)
        expect(s1.activeAssignment).toBeNull()
        expect(s1.outbox.map(e => e.envelope.type)).toEqual(["RESERVATION_RELEASE"])
        // Flew only for the 30 s it had fuel.
        expect(s1.position.x).toBeCloseTo(88, 6)
        const s2 = advanceFlight(s1, tick(60, 120), ctx(120)).state
        expect(s2.phase).toBe("UNRESOLVED")
        expect(s2.position).toEqual(s1.position)
        expect(s2.outbox).toHaveLength(1)
        expect(s2.fuelRemainingSec).toBe(0)
    })

    test("an expired emergency deadline ends the flight as UNRESOLVED", () => {
        const s = advanceFlight(flight({ deadlineSimSec: 30, priority: "EMERGENCY" }), tick(0, 60), ctx(60)).state
        expect(s.phase).toBe("UNRESOLVED")
        expect(s.terminalReason).toBe("EMERGENCY_DEADLINE")
    })

    test("fuel at or below 900 derives EMERGENCY priority", () => {
        const s = advanceFlight(flight({ fuelRemainingSec: 950 }), tick(0, 60), ctx(60)).state
        expect(s.priority).toBe("EMERGENCY")
    })
})

describe("approach and clearance", () => {
    // Alpha at (50,50). Start 6 NM east, already holding.
    const near = (a: Partial<Assignment> = {}, extra: Partial<FlightState> = {}) =>
        flight({
            position: { x: 56, y: 50 },
            phase: "HOLDING",
            holdCenter: { x: 50, y: 50 },
            holdAngle: 0,
            activeAssignment: { airportId: "ALP", runwayId: "R1", reservationId: "res-1", slotStartSimSec: 300, occupancySec: 60, clearanceId: null, ...a },
            ...extra,
        })

    test("clearance job appears within 6 NM once the slot is close enough", () => {
        expect(clearanceDue(near(), 50)).toBe(false) // 250 > 90 + 120
        const s = advanceFlight(near(), tick(0, 92), ctx(92)).state // 208 <= 210
        expect(Object.keys(s.jobs)).toEqual(["clearance-res-1"])
        expect(s.jobs["clearance-res-1"]!.input.allowedActions).toContain("REQUEST_CLEARANCE")
        const again = advanceFlight(s, tick(92, 100), ctx(100)).state
        expect(Object.keys(again.jobs)).toHaveLength(1)
    })

    test("early clearance keeps holding until slotStart minus travel, then lands on time", () => {
        let s = near({ clearanceId: "clr-1" })
        s = run(s, 0, 200)
        expect(s.phase).toBe("HOLDING") // approach starts at 300 - 90 = 210
        expect(distanceNm(s.position, AIRPORT_POSITION.ALP)).toBeCloseTo(6, 6)
        s = run(s, 200, 300)
        expect(s.phase).toBe("APPROACH")
        expect(distanceNm(s.position, AIRPORT_POSITION.ALP)).toBeLessThan(1e-6)
        expect(touchdownReady(s, 300)).toBe(true)
        expect(touchdownReady(s, 331)).toBe(false)
    })

    test("a missed slot drops the assignment, queues a release and renegotiates", () => {
        // Holding without clearance until 300 + 30 - 90 = 240 is no longer reachable.
        const s = run(near(), 0, 250)
        expect(s.activeAssignment).toBeNull()
        expect(s.outbox.map(e => e.envelope.type)).toEqual(["RESERVATION_RELEASE"])
        expect(s.releaseObligations).toHaveLength(1)
        expect(Object.values(s.jobs).some(j => j.input.trigger === "SLOT_MISSED" && j.status === "QUEUED")).toBe(true)
        expect(s.jobs["clearance-res-1"]!.status).toBe("CANCELLED")
    })

    test("closure after clearance: an invalid guard forces holding and a new negotiation", () => {
        let s = run(near({ clearanceId: "clr-1" }), 0, 250)
        expect(s.phase).toBe("APPROACH")
        const guarded = applyApproachGuard(s, { valid: false, reason: "airport closed", reservationId: "res-1", clearanceId: "clr-1" }, ctx(250))
        expect(guarded.result.outcome).toBe("APPLIED")
        s = guarded.state
        expect(s.activeAssignment).toBeNull()
        expect(s.phase).toBe("HOLDING")
        expect(s.decisionRevision).toBe(1)
        const before = s.position
        s = advanceFlight(s, tick(250, 252.5), ctx(252.5)).state
        // Holding in place near where approach was abandoned, not flying onto the runway.
        expect(distanceNm(s.position, before)).toBeLessThan(0.2)
    })

    test("arrival at a closed runway holds rather than continuing", () => {
        const status = { airportId: "ALP" as const, statusRevision: 2, restrictions: { arrivalsClosed: false, closedRunways: ["R1" as const], occupancySec: 60, activeIncidentIds: [] } }
        const s = run(near({ clearanceId: "clr-1" }, { knownAirportStatus: { ALP: status } }), 0, 250)
        expect(s.phase).toBe("HOLDING")
        expect(distanceNm(s.position, AIRPORT_POSITION.ALP)).toBeGreaterThan(1)
    })

    test("guard for a stale clearance does not touch the current assignment", () => {
        const s = near({ clearanceId: "clr-2" })
        const r = applyApproachGuard(s, { valid: false, reason: "x", reservationId: "res-1", clearanceId: "clr-1" }, ctx(10))
        expect(r.result.code).toBe("STALE_STATE")
        expect(r.state.activeAssignment?.clearanceId).toBe("clr-2")
    })
})

describe("touchdown", () => {
    const receipt: TouchdownReceipt = {
        receiptId: "rcpt-1",
        runId,
        flightId: "F001",
        airportId: "ALP",
        runwayId: "R1",
        reservationId: "res-1",
        clearanceId: "clr-1",
        touchdownAtSimSec: 300,
        occupiedUntilSimSec: 360,
    }
    const approaching = () =>
        flight({
            position: { x: 50, y: 50 },
            phase: "APPROACH",
            activeAssignment: { airportId: "ALP", runwayId: "R1", reservationId: "res-1", slotStartSimSec: 300, occupancySec: 60, clearanceId: "clr-1" },
            jobs: {},
        })

    test("records LANDED once; duplicate receipt is a no-op; fuel stops burning", () => {
        const once = recordFlightTouchdown(approaching(), receipt, ctx(300))
        expect(once.result.outcome).toBe("APPLIED")
        expect(once.state.phase).toBe("LANDED")
        const twice = recordFlightTouchdown(once.state, receipt, ctx(300))
        expect(twice.result.outcome).toBe("DUPLICATE")
        const other = recordFlightTouchdown(once.state, { ...receipt, receiptId: "rcpt-2" }, ctx(300))
        expect(other.result.code).toBe("ALREADY_TERMINAL")
        const later = advanceFlight(once.state, tick(300, 400), ctx(400)).state
        expect(later.fuelRemainingSec).toBe(once.state.fuelRemainingSec)
        expect(later.position).toEqual(once.state.position)
    })

    test("a receipt from another run is rejected", () => {
        const r = recordFlightTouchdown(approaching(), { ...receipt, runId: "11111111-1111-4111-8111-111111111111" }, ctx(300))
        expect(r.result.code).toBe("WRONG_RUN")
    })

    test("a terminal flight ignores later movement and wrong-run ticks", () => {
        const landed = recordFlightTouchdown(approaching(), receipt, ctx(300)).state
        const wrong = advanceFlight(landed, tick(300, 310), { ...ctx(310), runId: "11111111-1111-4111-8111-111111111111" })
        expect(wrong.result.code).toBe("WRONG_RUN")
        expect(wrong.state).toBe(landed)
    })
})
