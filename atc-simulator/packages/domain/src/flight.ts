// Flight movement, fuel, approach and terminal outcomes (design §4, plan Task 8).
// Pure functions over FlightState. Every transition returns a whole new aggregate;
// the actor persists it with one assignment.
import {
    AIRPORTS,
    APPROACH_RADIUS_NM,
    CLEARANCE_LEAD_SEC,
    FUEL_BURN_PER_SIM_SEC,
    HOLDING_RADIUS_NM,
    LANDING_GRACE_SEC,
    LOW_FUEL_EMERGENCY_THRESHOLD_SEC,
} from "./constants.ts"
import {
    airportEntityId,
    entityHandle,
    type AgentActionType,
    type AirportId,
    type Assignment,
    type ClearanceCheckResult,
    type DomainResult,
    type FlightState,
    type Job,
    type MutationContext,
    type OutboxEntry,
    type Point,
    type ProtocolEnvelope,
    type TerminalReason,
    type Tick,
    type TouchdownReceipt,
    type Transition,
} from "./contracts.ts"
import { distanceNm, headingDeg, moveToward, polarOffset, travelSeconds } from "./geometry.ts"
import { stableUuid } from "./stable-id.ts"

const EPS_NM = 1e-6
const EPS_SEC = 1e-6

export const AIRPORT_POSITION: Record<AirportId, Point> = Object.fromEntries(
    AIRPORTS.map(a => [a.airportId, { x: a.position.x, y: a.position.y }]),
) as Record<AirportId, Point>


export function isTerminalPhase(phase: FlightState["phase"]): boolean {
    return phase === "LANDED" || phase === "UNRESOLVED"
}

function applied(state: FlightState, code = "OK"): DomainResult {
    return { outcome: "APPLIED", code, stateRevision: state.stateRevision }
}
function rejected(state: FlightState, code: string): DomainResult {
    return { outcome: "REJECTED", code, stateRevision: state.stateRevision }
}
function duplicate(state: FlightState): DomainResult {
    return {
        outcome: "DUPLICATE",
        code: "OK",
        stateRevision: state.stateRevision,
        original: { outcome: "APPLIED", code: "OK", stateRevision: state.stateRevision },
    }
}

// Where the flight is heading right now, or null when it must hold in place.
// A confirmed assignment wins. Without one, keep flying toward the original
// destination unless the last announced status says arrivals there are closed.
export function targetAirport(state: FlightState): AirportId | null {
    const assigned = state.activeAssignment?.airportId ?? null
    const candidate = assigned ?? state.originalDestination
    const status = state.knownAirportStatus[candidate]
    if (status?.restrictions.arrivalsClosed) return null
    if (assigned && status?.restrictions.closedRunways.includes(state.activeAssignment!.runwayId)) return null
    return candidate
}

// Seconds from the given position to the runway threshold (the airport point).
export function secondsToRunway(state: FlightState, airportId: AirportId, position: Point = state.position): number {
    return travelSeconds(distanceNm(position, AIRPORT_POSITION[airportId]), state.speedKnots)
}

// Clearance is requested within 6 NM once the slot is close enough (design §4).
export function clearanceDue(state: FlightState, nowSimSec: number): boolean {
    const a = state.activeAssignment
    if (!a || a.clearanceId !== null || isTerminalPhase(state.phase)) return false
    const d = distanceNm(state.position, AIRPORT_POSITION[a.airportId])
    if (d > APPROACH_RADIUS_NM + EPS_NM) return false
    return a.slotStartSimSec - nowSimSec <= secondsToRunway(state, a.airportId) + CLEARANCE_LEAD_SEC + EPS_SEC
}

// The current travel can no longer reach the runway inside [slotStart, slotStart+grace].
export function slotMissed(state: FlightState, nowSimSec: number): boolean {
    const a = state.activeAssignment
    if (!a || isTerminalPhase(state.phase)) return false
    return nowSimSec + secondsToRunway(state, a.airportId) > a.slotStartSimSec + LANDING_GRACE_SEC + EPS_SEC
}

// Ready for the authoritative touchdown check this tick.
export function touchdownReady(state: FlightState, nowSimSec: number): boolean {
    const a = state.activeAssignment
    if (state.phase !== "APPROACH" || !a || a.clearanceId === null || state.landingReceipt) return false
    if (distanceNm(state.position, AIRPORT_POSITION[a.airportId]) > EPS_NM) return false
    return nowSimSec >= a.slotStartSimSec && nowSimSec <= a.slotStartSimSec + LANDING_GRACE_SEC
}

// ---------------------------------------------------------------- motion

type Motion = Pick<FlightState, "position" | "headingDeg" | "phase" | "holdCenter" | "holdAngle">

function tangentHeading(angle: number): number {
    // Increasing angle with y pointing south moves clockwise on the map.
    return headingDeg({ x: 0, y: 0 }, { x: -Math.sin(angle), y: Math.cos(angle) })
}

function orbit(m: Motion, center: Point, radius: number, angle: number, speedKnots: number, seconds: number): Motion {
    const next = angle + (speedKnots / 3600 / radius) * seconds
    return { ...m, phase: "HOLDING", holdCenter: center, holdAngle: next, position: polarOffset(center, next, radius), headingDeg: tangentHeading(next) }
}

function samePoint(a: Point | null, b: Point): boolean {
    return a !== null && Math.abs(a.x - b.x) < EPS_NM && Math.abs(a.y - b.y) < EPS_NM
}

// Move the aircraft for `seconds` of airborne time starting at simulated time `t0`.
export function simulateMotion(state: FlightState, t0: number, seconds: number): Motion {
    let m: Motion = {
        position: state.position,
        headingDeg: state.headingDeg,
        phase: state.phase,
        holdCenter: state.holdCenter,
        holdAngle: state.holdAngle,
    }
    const speed = state.speedKnots
    const target = targetAirport(state)
    const a = state.activeAssignment
    const cleared = a !== null && a.clearanceId !== null && target === a.airportId
    let t = t0
    let remaining = seconds

    for (let guard = 0; guard < 8 && remaining > EPS_SEC; guard++) {
        if (target === null) {
            // Hold in place: keep an existing orbit, else capture (x-6, y) at angle 0.
            if (m.phase === "HOLDING" && m.holdCenter && m.holdAngle !== null) {
                const r = Math.max(distanceNm(m.position, m.holdCenter), EPS_NM)
                return orbit(m, m.holdCenter, r, m.holdAngle, speed, remaining)
            }
            const center = { x: m.position.x - HOLDING_RADIUS_NM, y: m.position.y }
            return orbit(m, center, HOLDING_RADIUS_NM, 0, speed, remaining)
        }

        const runway = AIRPORT_POSITION[target]
        const d = distanceNm(m.position, runway)

        if (m.phase === "APPROACH" && cleared) {
            const step = (speed * remaining) / 3600
            if (d > EPS_NM) m = { ...m, headingDeg: headingDeg(m.position, runway), position: moveToward(m.position, runway, step) }
            return { ...m, holdCenter: null, holdAngle: null }
        }

        if (d > APPROACH_RADIUS_NM + EPS_NM) {
            const needed = travelSeconds(d - APPROACH_RADIUS_NM, speed)
            const used = Math.min(remaining, needed)
            const next = used >= needed ? moveToward(m.position, runway, d - APPROACH_RADIUS_NM) : moveToward(m.position, runway, (speed * used) / 3600)
            m = { ...m, phase: "ENROUTE", holdCenter: null, holdAngle: null, headingDeg: headingDeg(m.position, runway), position: next }
            t += used
            remaining -= used
            continue
        }

        // Within 6 NM of a valid destination.
        const r = Math.max(d, EPS_NM)
        if (cleared) {
            const startApproachAt = a!.slotStartSimSec - travelSeconds(r, speed)
            if (t >= startApproachAt - EPS_SEC) {
                m = { ...m, phase: "APPROACH" }
                continue
            }
            const wait = Math.min(remaining, startApproachAt - t)
            const angle = samePoint(m.holdCenter, runway) && m.holdAngle !== null ? m.holdAngle : Math.atan2(m.position.y - runway.y, m.position.x - runway.x)
            m = orbit(m, runway, r, angle, speed, wait)
            t += wait
            remaining -= wait
            continue
        }
        const angle = samePoint(m.holdCenter, runway) && m.holdAngle !== null ? m.holdAngle : Math.atan2(m.position.y - runway.y, m.position.x - runway.x)
        return orbit(m, runway, r, angle, speed, remaining)
    }
    return m
}

// ---------------------------------------------------------------- jobs and outbox

function cancelOpenJobs(jobs: FlightState["jobs"]): FlightState["jobs"] {
    const out: FlightState["jobs"] = {}
    for (const [id, job] of Object.entries(jobs)) {
        out[id] = job.status === "QUEUED" || job.status === "LEASED" ? { ...job, status: "CANCELLED", leaseToken: null, leaseUntilWallMs: null } : job
    }
    return out
}

export function pilotJob(
    jobId: string,
    trigger: string,
    state: FlightState,
    allowedActions: AgentActionType[],
    wallNowMs: number,
    decisionRevision = state.decisionRevision,
): Job {
    return {
        jobId,
        kind: "PILOT_DECISION",
        status: "QUEUED",
        decisionRevision,
        input: { trigger, priority: state.priority, allowedActions, relevantMessageIds: [], createdAtWallMs: wallNowMs },
        leaseToken: null,
        leaseUntilWallMs: null,
        attemptCount: 0,
        outcome: null,
    }
}

// One release per reservation; the ID is derived so a retried transition emits
// the same message and the airport's (runId, messageId) dedup absorbs it.
export function releaseEnvelope(state: FlightState, assignment: Assignment, ctx: MutationContext): OutboxEntry {
    const toEntityId = airportEntityId(assignment.airportId)
    const envelope: ProtocolEnvelope = {
        schemaVersion: 1,
        messageId: stableUuid(state.runId, state.flightId, "RESERVATION_RELEASE", assignment.reservationId),
        runId: state.runId,
        fromEntityId: state.entityId,
        toEntityId,
        type: "RESERVATION_RELEASE",
        correlationId: assignment.reservationId,
        causationId: null,
        createdAtWallMs: ctx.wallNowMs,
        expiresAtWallMs: null,
        payload: { reservationId: assignment.reservationId, flightId: state.flightId },
    }
    return {
        envelope,
        recipientHandle: entityHandle(state.runId, toEntityId),
        attemptCount: 0,
        nextAttemptAtWallMs: ctx.wallNowMs,
        transportMessageId: null,
        acknowledged: false,
    }
}

// Drop the active assignment, queue its release, and leave a renegotiation job.
// Used for a missed slot and for an invalidated clearance.
export function abandonAssignment(state: FlightState, trigger: string, ctx: MutationContext): FlightState {
    const a = state.activeAssignment
    if (!a) return state
    const release = releaseEnvelope(state, a, ctx)
    const decisionRevision = state.decisionRevision + 1
    const jobs = cancelOpenJobs(state.jobs)
    const jobId = `${trigger.toLowerCase()}-${a.reservationId}`.slice(0, 128)
    const next: FlightState = {
        ...state,
        activeAssignment: null,
        phase: state.phase === "APPROACH" ? "HOLDING" : state.phase,
        // Leaving an approach at the runway: capture a fresh hold where we are.
        holdCenter: state.phase === "APPROACH" ? null : state.holdCenter,
        holdAngle: state.phase === "APPROACH" ? null : state.holdAngle,
        releaseObligations: [
            ...state.releaseObligations,
            { airportId: a.airportId, reservationId: a.reservationId, messageId: release.envelope.messageId, acknowledged: false },
        ],
        outbox: [...state.outbox, release],
        decisionRevision,
        stateRevision: state.stateRevision + 1,
        jobs: { ...jobs, [jobId]: pilotJob(jobId, trigger, state, ["REQUEST_LANDING", "HOLD"], ctx.wallNowMs, decisionRevision) },
    }
    return next
}

function terminate(state: FlightState, reason: TerminalReason, ctx: MutationContext): FlightState {
    const a = state.activeAssignment
    const release = a ? releaseEnvelope(state, a, ctx) : null
    return {
        ...state,
        phase: "UNRESOLVED",
        terminalReason: reason,
        activeAssignment: null,
        pendingAcceptance: null,
        negotiation: null,
        holdCenter: null,
        holdAngle: null,
        jobs: cancelOpenJobs(state.jobs),
        releaseObligations: a
            ? [...state.releaseObligations, { airportId: a.airportId, reservationId: a.reservationId, messageId: release!.envelope.messageId, acknowledged: false }]
            : state.releaseObligations,
        outbox: release ? [...state.outbox, release] : state.outbox,
        decisionRevision: state.decisionRevision + 1,
    }
}

// ---------------------------------------------------------------- tick

// Advance one flight for one tick. Applying the same tick twice, or a tick that
// ends at or before lastAdvancedSimSec, changes nothing (design §4 clock behavior).
export function advanceFlight(
    state: FlightState,
    tick: Tick,
    context: MutationContext,
): Transition<FlightState> {
    if (context.runId !== state.runId) return { state, result: rejected(state, "WRONG_RUN") }
    if (state.lastTickId === tick.tickId) return { state, result: duplicate(state) }
    if (tick.toSimSec <= state.lastAdvancedSimSec + EPS_SEC) {
        // Older or empty interval: record the tick ID so a retry stays a duplicate.
        const next = { ...state, lastTickId: tick.tickId }
        return { state: next, result: applied(next, "STALE_STATE") }
    }

    const t0 = state.lastAdvancedSimSec
    const delta = tick.toSimSec - t0
    const clockOnly = { lastTickId: tick.tickId, lastAdvancedSimSec: tick.toSimSec }

    if (isTerminalPhase(state.phase)) {
        const next = { ...state, ...clockOnly }
        return { state: next, result: applied(next) }
    }

    const fuelBefore = Math.max(0, state.fuelRemainingSec)
    const airborne = Math.min(delta, fuelBefore / FUEL_BURN_PER_SIM_SEC)
    const motion = simulateMotion(state, t0, airborne)
    const fuel = Math.max(0, fuelBefore - delta * FUEL_BURN_PER_SIM_SEC)

    let next: FlightState = {
        ...state,
        ...motion,
        ...clockOnly,
        fuelRemainingSec: fuel,
        // Derived fuel urgency stays while airborne (design §5 LOW_FUEL).
        priority: fuel <= LOW_FUEL_EMERGENCY_THRESHOLD_SEC ? "EMERGENCY" : state.priority,
        stateRevision: state.stateRevision + 1,
    }

    if (fuel <= 0) {
        next = terminate(next, "FUEL_EXHAUSTED", context)
        return { state: next, result: applied(next) }
    }
    if (next.deadlineSimSec !== null && tick.toSimSec > next.deadlineSimSec + EPS_SEC) {
        next = terminate(next, "EMERGENCY_DEADLINE", context)
        return { state: next, result: applied(next) }
    }

    if (next.phase !== "APPROACH" && slotMissed(next, tick.toSimSec)) {
        next = abandonAssignment(next, "SLOT_MISSED", context)
        return { state: next, result: applied(next) }
    }
    if (next.phase === "APPROACH" && next.activeAssignment && tick.toSimSec > next.activeAssignment.slotStartSimSec + LANDING_GRACE_SEC + EPS_SEC) {
        next = abandonAssignment(next, "SLOT_MISSED", context)
        return { state: next, result: applied(next) }
    }

    if (clearanceDue(next, tick.toSimSec)) {
        const jobId = `clearance-${next.activeAssignment!.reservationId}`.slice(0, 128)
        if (!next.jobs[jobId]) {
            next = { ...next, jobs: { ...next.jobs, [jobId]: pilotJob(jobId, "CLEARANCE_WINDOW", next, ["REQUEST_CLEARANCE", "HOLD"], context.wallNowMs) } }
        }
    }
    return { state: next, result: applied(next) }
}

// ---------------------------------------------------------------- approach guard and touchdown

// The engine checks the clearance against current airport state every approach
// tick. An invalid clearance forces holding and a new negotiation (design §4).
export function applyApproachGuard(
    state: FlightState,
    check: ClearanceCheckResult,
    context: MutationContext,
): Transition<FlightState> {
    if (context.runId !== state.runId) return { state, result: rejected(state, "WRONG_RUN") }
    if (isTerminalPhase(state.phase)) return { state, result: rejected(state, "ALREADY_TERMINAL") }
    const a = state.activeAssignment
    if (!a || a.reservationId !== check.reservationId || a.clearanceId !== check.clearanceId) {
        return { state, result: rejected(state, "STALE_STATE") }
    }
    if (check.valid) return { state, result: applied(state) }
    const next = abandonAssignment(state, "CLEARANCE_INVALID", context)
    return { state: next, result: applied(next, "CLOSED") }
}

// Mark the flight landed from the airport's authoritative receipt. Idempotent.
export function recordFlightTouchdown(state: FlightState, receipt: TouchdownReceipt, context: MutationContext): Transition<FlightState> {
    if (context.runId !== state.runId || receipt.runId !== state.runId) return { state, result: rejected(state, "WRONG_RUN") }
    if (receipt.flightId !== state.flightId) return { state, result: rejected(state, "INVALID_PAYLOAD") }
    if (state.landingReceipt?.receiptId === receipt.receiptId) return { state, result: duplicate(state) }
    if (state.phase === "LANDED") return { state, result: rejected(state, "ALREADY_TERMINAL") }
    // The airport receipt is authoritative: once it exists the flight landed, even
    // if a later tick marked it unresolved before recovery finished (design §4).
    const position = AIRPORT_POSITION[receipt.airportId]
    const assignment: Assignment =
        state.activeAssignment?.reservationId === receipt.reservationId
            ? { ...state.activeAssignment, clearanceId: receipt.clearanceId }
            : {
                  airportId: receipt.airportId,
                  runwayId: receipt.runwayId,
                  reservationId: receipt.reservationId,
                  slotStartSimSec: receipt.touchdownAtSimSec,
                  occupancySec: Math.max(1, Math.round(receipt.occupiedUntilSimSec - receipt.touchdownAtSimSec)),
                  clearanceId: receipt.clearanceId,
              }
    const next: FlightState = {
        ...state,
        phase: "LANDED",
        position,
        holdCenter: null,
        holdAngle: null,
        terminalReason: null,
        landingReceipt: receipt,
        activeAssignment: assignment,
        pendingAcceptance: null,
        negotiation: null,
        jobs: cancelOpenJobs(state.jobs),
        stateRevision: state.stateRevision + 1,
        decisionRevision: state.decisionRevision + 1,
    }
    return { state: next, result: applied(next) }
}
