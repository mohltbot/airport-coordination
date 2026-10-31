// Incident activation, resolution and derived conditions (design §5), plus the
// target-side half of controller command ordering (design §7 "Command ordering
// and clearing"). Pure functions: each returns the complete next aggregate,
// so an actor method assigns it once (Terse: reassign, never mutate).
//
// Invariants enforced here:
// - A resolved incident is never reactivated. A delayed or duplicated create
//   for a resolved ID is rejected (ALREADY_TERMINAL) or deduplicated; a new
//   activation needs a new incident ID.
// - Controller commands apply strictly in commandSequence order per target.
//   A gap is buffered; rejected and expired commands still consume their
//   sequence with a recorded COMMAND_RESULT.
// - Clearing never undoes physical consequences (fuel, position, revoked
//   arrangements) and never removes the incident record.
import {
    IncidentClearSchema,
    IncidentCreateSchema,
    entityHandle,
    flightEntityId,
    type AirportRestrictions,
    type AirportState,
    type AirportStatusLabel,
    type DomainCode,
    type DomainResult,
    type FlightState,
    type Incident,
    type IncidentClear,
    type IncidentCreate,
    type IncidentKind,
    type InboxResult,
    type MutationContext,
    type OutboxEntry,
    type Priority,
    type ProtocolEnvelope,
    type ReceivedEnvelope,
    type RunwayId,
    type Transition,
} from "./contracts.ts"
import {
    CRUISE_SPEED_KNOTS,
    ENGINE_TROUBLE_DEADLINE_SEC,
    ENGINE_TROUBLE_SPEED_KNOTS,
    LOW_FUEL_CAP_SEC,
    LOW_FUEL_EMERGENCY_THRESHOLD_SEC,
    REDUCED_CAPACITY_OCCUPANCY_SEC,
    RUNWAY_IDS,
    RUNWAY_OCCUPANCY_SEC,
    SMOKE_DEADLINE_SEC,
} from "./constants.ts"
import { stableUuid } from "./stable-id.ts"

// ---------------------------------------------------------------- types

export type EntityState = AirportState | FlightState

export type IncidentContext = Pick<MutationContext, "runId" | "simNowSec" | "wallNowMs"> & {
    /** Stored on the incident record. Defaults to "controller". */
    createdBy?: string
    /** Message that caused this change; becomes causationId on notices. */
    causationId?: string | null
    /** Extra flights to send AIRPORT_STATUS to (for example the whole roster). */
    notifyFlightIds?: readonly string[]
    /** Airport hook: negotiation.revokeArrangements bound to a NegotiationContext,
     *  so revoked holds answer their pending request with LANDING_REFUSED and
     *  their ATC jobs are cancelled. Without it a built-in revocation is used. */
    revokeArrangements?: (
        airport: AirportState,
        affects: (runwayId: string) => boolean,
        code: DomainCode,
        reason: string,
        causationId: string | null,
    ) => { airport: AirportState; out: ProtocolEnvelope[] }
    /** Flight hook: open an urgent round (negotiation.openRound(f, "EMERGENCY", ctx).state)
     *  when an incident makes the flight an emergency or tightens its deadline. */
    openEmergencyRound?: (flight: FlightState) => FlightState
}

export type IncidentEvent =
    | { type: "INCIDENT_ACTIVATED"; incidentId: string; kind: IncidentKind; target: string; summary: string }
    | { type: "INCIDENT_RESOLVED"; incidentId: string; kind: IncidentKind; target: string; summary: string }
    | {
          type: "AIRPORT_CONDITIONS_CHANGED"
          airportId: string
          before: AirportRestrictions
          after: AirportRestrictions
          status: AirportStatusLabel
          summary: string
      }
    | {
          type: "ARRANGEMENT_REVOKED"
          airportId: string
          flightId: string
          arrangement: "OFFER" | "RESERVATION" | "CLEARANCE"
          id: string
          summary: string
      }
    | {
          type: "FLIGHT_CONDITIONS_CHANGED"
          flightId: string
          before: FlightConditions
          after: FlightConditions
          /** True when the flight should open an urgent negotiation round. */
          renegotiate: boolean
          summary: string
      }

/** Transition<S> plus what a COMMAND_RESULT and the timeline need. */
export type IncidentTransition<S> = Transition<S> & {
    code: DomainCode
    incidentId: string
    /** Incident revision after the operation; null when the incident is unknown. */
    incidentRevision: number | null
    events: IncidentEvent[]
}

export type AirportConditions = {
    restrictions: AirportRestrictions
    openRunways: RunwayId[]
    status: AirportStatusLabel
    statusReason: string | null
}

export type FlightConditions = {
    priority: Priority
    deadlineSimSec: number | null
    speedKnots: number
    emergencyReasons: Array<"SMOKE" | "ENGINE_TROUBLE" | "LOW_FUEL">
}

export type ControllerCommandEnvelope = Extract<ReceivedEnvelope, { type: "INCIDENT_CREATE" | "INCIDENT_CLEAR" }>

export type ProcessedControllerCommand = {
    messageId: string
    commandId: string
    commandSequence: number
    outcome: "APPLIED" | "REJECTED"
    code: DomainCode
    incidentId: string
    incidentRevision: number | null
}

export type ControllerReceiveTransition<S> = Transition<S> & {
    /** Commands applied or rejected by this call, in sequence order (the
     *  incoming one plus any buffered successors it unblocked). */
    processed: ProcessedControllerCommand[]
    events: IncidentEvent[]
}

/** DomainResult code for a command parked behind a sequence gap. */
export const BUFFERED_CODE = "BUFFERED"

const AIRPORT_KINDS: ReadonlySet<IncidentKind> = new Set(["WEATHER_CLOSED", "RUNWAY_CLOSED", "CAPACITY_REDUCED"])
const FLIGHT_KINDS: ReadonlySet<IncidentKind> = new Set(["SMOKE", "ENGINE_TROUBLE", "LOW_FUEL"])

// ---------------------------------------------------------------- small helpers

/** True for INCIDENT_CREATE / INCIDENT_CLEAR; route those to receiveControllerCommand. */
export function isControllerCommand(message: ReceivedEnvelope): message is ControllerCommandEnvelope {
    return message.type === "INCIDENT_CREATE" || message.type === "INCIDENT_CLEAR"
}

export function isAirportState(state: EntityState): state is AirportState {
    return state.entityId.startsWith("airport:")
}

export function isTerminalFlight(state: FlightState): boolean {
    return state.phase === "LANDED" || state.phase === "UNRESOLVED"
}

/** Actor effective time never runs behind its own last tick. */
export function effectiveSimSec(state: EntityState, ctx: Pick<IncidentContext, "simNowSec">): number {
    return Math.max(ctx.simNowSec, state.lastAdvancedSimSec)
}

export function activeIncidents(state: Pick<EntityState, "incidents">): Incident[] {
    return Object.values(state.incidents)
        .filter(i => i.status === "ACTIVE")
        .sort((a, b) => a.createdAtSimSec - b.createdAtSimSec || a.createdAtWallMs - b.createdAtWallMs || (a.incidentId < b.incidentId ? -1 : 1))
}

function runwayParam(incident: Pick<Incident, "parameters">): RunwayId | null {
    const p = incident.parameters as { runwayId?: RunwayId }
    return p.runwayId ?? null
}

function sameContents(existing: Incident, input: IncidentCreate): boolean {
    return (
        existing.kind === input.kind &&
        existing.target === input.target &&
        runwayParam(existing) === runwayParam(input) &&
        Object.keys(existing.parameters).length === Object.keys(input.parameters).length
    )
}

function sameRestrictions(a: AirportRestrictions, b: AirportRestrictions): boolean {
    return (
        a.arrivalsClosed === b.arrivalsClosed &&
        a.occupancySec === b.occupancySec &&
        a.closedRunways.join(",") === b.closedRunways.join(",") &&
        a.activeIncidentIds.join(",") === b.activeIncidentIds.join(",")
    )
}

function rejected<S extends EntityState>(
    state: S,
    code: DomainCode,
    incidentId: string,
    incidentRevision: number | null = null,
): IncidentTransition<S> {
    return {
        state,
        result: { outcome: "REJECTED", code, stateRevision: state.stateRevision },
        code,
        incidentId,
        incidentRevision,
        events: [],
    }
}

function unchangedApplied<S extends EntityState>(state: S, incident: Incident): IncidentTransition<S> {
    return {
        state,
        result: { outcome: "APPLIED", code: "OK", stateRevision: state.stateRevision },
        code: "OK",
        incidentId: incident.incidentId,
        incidentRevision: incident.revision,
        events: [],
    }
}

export function outboxEntry(envelope: ProtocolEnvelope, wallNowMs: number): OutboxEntry {
    return {
        envelope,
        recipientHandle: entityHandle(envelope.runId, envelope.toEntityId),
        attemptCount: 0,
        nextAttemptAtWallMs: wallNowMs,
        transportMessageId: null,
        acknowledged: false,
    }
}

/** Append entries whose messageId is not already in the outbox. */
function appendOutbox(outbox: OutboxEntry[], entries: OutboxEntry[]): OutboxEntry[] {
    if (entries.length === 0) return outbox
    const seen = new Set(outbox.map(e => e.envelope.messageId))
    const fresh = entries.filter(e => !seen.has(e.envelope.messageId))
    return fresh.length ? [...outbox, ...fresh] : outbox
}

// ---------------------------------------------------------------- derived conditions

/** Combine active airport incidents: closures are a union, reduced capacity
 *  applies if any such incident is active. */
export function deriveAirportConditions(state: Pick<AirportState, "incidents">): AirportConditions {
    const active = activeIncidents(state)
    const weather = active.some(i => i.kind === "WEATHER_CLOSED")
    const capacity = active.some(i => i.kind === "CAPACITY_REDUCED")
    const closedRunways = RUNWAY_IDS.filter(r => active.some(i => i.kind === "RUNWAY_CLOSED" && runwayParam(i) === r))
    const openRunways = weather ? [] : RUNWAY_IDS.filter(r => !closedRunways.includes(r))
    const restrictions: AirportRestrictions = {
        arrivalsClosed: openRunways.length === 0,
        closedRunways: [...closedRunways],
        occupancySec: capacity ? REDUCED_CAPACITY_OCCUPANCY_SEC : RUNWAY_OCCUPANCY_SEC,
        activeIncidentIds: active.map(i => i.incidentId),
    }
    const reasons: string[] = []
    if (weather) reasons.push("Weather closure")
    if (closedRunways.length) reasons.push(`Runway ${closedRunways.join(", ")} closed`)
    if (capacity) reasons.push(`Reduced capacity, ${REDUCED_CAPACITY_OCCUPANCY_SEC}s occupancy`)
    const status: AirportStatusLabel = openRunways.length === 0 ? "CLOSED" : reasons.length ? "RESTRICTED" : "OPEN"
    return { restrictions, openRunways: [...openRunways], status, statusReason: reasons.length ? reasons.join("; ") : null }
}

/** Speed is the minimum imposed speed, deadline the earliest active deadline,
 *  priority the most urgent condition. Fuel urgency is derived from actual
 *  fuel while airborne, so it outlives a resolved LOW_FUEL report. */
export function deriveFlightConditions(state: Pick<FlightState, "incidents" | "fuelRemainingSec" | "phase">): FlightConditions {
    const active = activeIncidents(state)
    const airborne = state.phase !== "LANDED" && state.phase !== "UNRESOLVED"
    const reasons: FlightConditions["emergencyReasons"] = []
    const deadlines: number[] = []
    if (active.some(i => i.kind === "SMOKE")) reasons.push("SMOKE")
    if (active.some(i => i.kind === "ENGINE_TROUBLE")) reasons.push("ENGINE_TROUBLE")
    if (airborne && (state.fuelRemainingSec <= LOW_FUEL_EMERGENCY_THRESHOLD_SEC || active.some(i => i.kind === "LOW_FUEL"))) reasons.push("LOW_FUEL")
    for (const i of active) {
        if (i.kind === "SMOKE") deadlines.push(i.createdAtSimSec + SMOKE_DEADLINE_SEC)
        if (i.kind === "ENGINE_TROUBLE") deadlines.push(i.createdAtSimSec + ENGINE_TROUBLE_DEADLINE_SEC)
    }
    return {
        priority: reasons.length ? "EMERGENCY" : "NORMAL",
        deadlineSimSec: deadlines.length ? Math.min(...deadlines) : null,
        speedKnots: active.some(i => i.kind === "ENGINE_TROUBLE") ? ENGINE_TROUBLE_SPEED_KNOTS : CRUISE_SPEED_KNOTS,
        emergencyReasons: reasons,
    }
}

// ---------------------------------------------------------------- airport effects

type AirportRecompute = { state: AirportState; events: IncidentEvent[] }

/** Built-in revocation, used when no revokeArrangements hook is supplied:
 *  offers become REVOKED, reservations REVOKED with a RESERVATION_REVOKED
 *  notice, clearances REVOKED. Occupied or completed runway time is untouched. */
function defaultRevoke(airport: AirportState, affects: (runwayId: string) => boolean, code: DomainCode, reason: string, causationId: string | null, wallNowMs: number) {
    let offers = airport.offers
    let reservations = airport.reservations
    let clearances = airport.clearances
    const out: ProtocolEnvelope[] = []
    for (const o of Object.values(airport.offers)) {
        if (o.status !== "OFFERED" || !affects(o.runwayId)) continue
        offers = { ...offers, [o.offerId]: { ...o, status: "REVOKED" } }
    }
    for (const r of Object.values(airport.reservations)) {
        if ((r.status !== "CONFIRMED" && r.status !== "CLEARED") || !affects(r.runwayId)) continue
        reservations = { ...reservations, [r.reservationId]: { ...r, status: "REVOKED" } }
        out.push({
            schemaVersion: 1,
            messageId: stableUuid(airport.runId, airport.entityId, "RESERVATION_REVOKED", r.reservationId, airport.operationalRevision),
            runId: airport.runId,
            fromEntityId: airport.entityId,
            toEntityId: flightEntityId(r.flightId),
            correlationId: r.reservationId,
            causationId,
            createdAtWallMs: wallNowMs,
            expiresAtWallMs: null,
            type: "RESERVATION_REVOKED",
            payload: { reservationId: r.reservationId, code, reason: reason.slice(0, 240), airportOperationalRevision: airport.operationalRevision },
        })
    }
    for (const c of Object.values(airport.clearances)) {
        if (c.status !== "ACTIVE" || !affects(c.runwayId)) continue
        clearances = { ...clearances, [c.clearanceId]: { ...c, status: "REVOKED" } }
    }
    return { airport: { ...airport, offers, reservations, clearances }, out }
}

/** Recompute restrictions after an incident change, revoke every non-terminal
 *  arrangement on a runway that is no longer open, and queue notices. */
function recomputeAirport(prev: AirportState, incidents: AirportState["incidents"], ctx: IncidentContext): AirportRecompute {
    const conditions = deriveAirportConditions({ incidents })
    const open = new Set<string>(conditions.openRunways)
    const events: IncidentEvent[] = []
    const airportId = prev.airportId
    const causationId = ctx.causationId ?? null

    // Flights to inform: current holders of live arrangements here, flights
    // that lost one here earlier, and any roster the caller supplies.
    const notify = new Set<string>(ctx.notifyFlightIds ?? [])
    for (const o of Object.values(prev.offers)) if (o.status === "OFFERED" || o.status === "REVOKED") notify.add(o.flightId)
    for (const r of Object.values(prev.reservations)) if (r.status === "CONFIRMED" || r.status === "CLEARED" || r.status === "REVOKED") notify.add(r.flightId)

    const statusRevision = prev.statusRevision + 1
    const operationalRevision = prev.operationalRevision + 1
    const reason = conditions.statusReason ?? "Airport restriction"
    const affects = (runwayId: string) => !open.has(runwayId)
    const staged: AirportState = { ...prev, incidents, restrictions: conditions.restrictions, statusRevision, operationalRevision }
    const revoked = ctx.revokeArrangements
        ? ctx.revokeArrangements(staged, affects, "CLOSED", reason, causationId)
        : defaultRevoke(staged, affects, "CLOSED", reason, causationId, ctx.wallNowMs)
    const after = revoked.airport

    for (const o of Object.values(prev.offers))
        if (o.status === "OFFERED" && after.offers[o.offerId]?.status !== "OFFERED")
            events.push({ type: "ARRANGEMENT_REVOKED", airportId, flightId: o.flightId, arrangement: "OFFER", id: o.offerId, summary: `${airportId} withdrew offer to ${o.flightId}: runway ${o.runwayId} unavailable` })
    for (const r of Object.values(prev.reservations))
        if ((r.status === "CONFIRMED" || r.status === "CLEARED") && after.reservations[r.reservationId]?.status === "REVOKED")
            events.push({ type: "ARRANGEMENT_REVOKED", airportId, flightId: r.flightId, arrangement: "RESERVATION", id: r.reservationId, summary: `${airportId} revoked ${r.flightId}'s ${r.runwayId} reservation: ${reason}` })
    for (const c of Object.values(prev.clearances))
        if (c.status === "ACTIVE" && after.clearances[c.clearanceId]?.status === "REVOKED")
            events.push({ type: "ARRANGEMENT_REVOKED", airportId, flightId: c.flightId, arrangement: "CLEARANCE", id: c.clearanceId, summary: `${airportId} revoked ${c.flightId}'s landing clearance` })

    const statusNotices: ProtocolEnvelope[] = [...notify].sort().map(flightId => ({
        schemaVersion: 1,
        messageId: stableUuid(prev.runId, prev.entityId, "AIRPORT_STATUS", statusRevision, flightId),
        runId: prev.runId,
        fromEntityId: prev.entityId,
        toEntityId: flightEntityId(flightId),
        correlationId: `${airportId}-status-${statusRevision}`,
        causationId,
        createdAtWallMs: ctx.wallNowMs,
        expiresAtWallMs: null,
        type: "AIRPORT_STATUS",
        payload: { airportId, statusRevision, restrictions: conditions.restrictions },
    }))

    if (!sameRestrictions(prev.restrictions, conditions.restrictions)) {
        events.push({
            type: "AIRPORT_CONDITIONS_CHANGED",
            airportId,
            before: prev.restrictions,
            after: conditions.restrictions,
            status: conditions.status,
            summary: `${airportId} ${conditions.status}${conditions.statusReason ? `: ${conditions.statusReason}` : ""}`,
        })
    }

    return {
        state: {
            ...after,
            outbox: appendOutbox(
                after.outbox,
                [...statusNotices, ...revoked.out].map(e => outboxEntry(e, ctx.wallNowMs)),
            ),
            stateRevision: prev.stateRevision + 1,
            decisionRevision: prev.decisionRevision + 1,
        },
        events,
    }
}

// ---------------------------------------------------------------- flight effects

function recomputeFlight(prev: FlightState, next: FlightState): { state: FlightState; events: IncidentEvent[] } {
    const before = deriveFlightConditions(prev)
    const after = deriveFlightConditions(next)
    const state: FlightState = {
        ...next,
        priority: after.priority,
        deadlineSimSec: after.deadlineSimSec,
        speedKnots: after.speedKnots,
        stateRevision: prev.stateRevision + 1,
        decisionRevision: prev.decisionRevision + 1,
    }
    const events: IncidentEvent[] = []
    const changed =
        before.priority !== after.priority ||
        before.deadlineSimSec !== after.deadlineSimSec ||
        before.speedKnots !== after.speedKnots ||
        before.emergencyReasons.join(",") !== after.emergencyReasons.join(",")
    if (changed) {
        const becameUrgent = before.priority === "NORMAL" && after.priority === "EMERGENCY"
        const tighterDeadline = after.deadlineSimSec !== null && (before.deadlineSimSec === null || after.deadlineSimSec < before.deadlineSimSec)
        events.push({
            type: "FLIGHT_CONDITIONS_CHANGED",
            flightId: prev.flightId,
            before,
            after,
            renegotiate: !isTerminalFlight(prev) && (becameUrgent || tighterDeadline),
            summary: `${prev.callsign} ${after.priority}${after.emergencyReasons.length ? ` (${after.emergencyReasons.join(", ")})` : ""}${after.deadlineSimSec !== null ? `, land by T+${Math.round(after.deadlineSimSec)}s` : ""}, ${after.speedKnots} kt`,
        })
    }
    return { state, events }
}

// ---------------------------------------------------------------- apply / resolve

function checkCommon<S extends EntityState>(state: S, ctx: IncidentContext, target: string, incidentId: string): IncidentTransition<S> | null {
    if (ctx.runId !== state.runId) return rejected(state, "WRONG_RUN", incidentId)
    if (target !== state.entityId) return rejected(state, "UNAUTHORIZED", incidentId)
    return null
}

/** Activate an incident on its target. Idempotent for the same ID and
 *  contents; a resolved ID is never reactivated. */
export function applyIncident(state: AirportState, input: IncidentCreate, ctx: IncidentContext): IncidentTransition<AirportState>
export function applyIncident(state: FlightState, input: IncidentCreate, ctx: IncidentContext): IncidentTransition<FlightState>
export function applyIncident(state: EntityState, input: IncidentCreate, ctx: IncidentContext): IncidentTransition<EntityState>
export function applyIncident(state: EntityState, input: IncidentCreate, ctx: IncidentContext): IncidentTransition<EntityState> {
    const parsed = IncidentCreateSchema.safeParse(input)
    const incidentId = typeof (input as { incidentId?: unknown })?.incidentId === "string" ? input.incidentId : ""
    if (!parsed.success) return rejected(state, "INVALID_PAYLOAD", incidentId)
    const create = parsed.data
    const bad = checkCommon(state, ctx, create.target, create.incidentId)
    if (bad) return bad
    const airport = isAirportState(state)
    if (airport ? !AIRPORT_KINDS.has(create.kind) : !FLIGHT_KINDS.has(create.kind)) return rejected(state, "UNAUTHORIZED", create.incidentId)

    const existing = state.incidents[create.incidentId]
    if (existing) {
        if (!sameContents(existing, create)) return rejected(state, "REVISION_CONFLICT", create.incidentId, existing.revision)
        if (existing.status === "RESOLVED") return rejected(state, "ALREADY_TERMINAL", create.incidentId, existing.revision)
        return unchangedApplied(state, existing)
    }
    if (!airport && isTerminalFlight(state)) return rejected(state, "ALREADY_TERMINAL", create.incidentId)

    const now = effectiveSimSec(state, ctx)
    const incident: Incident = {
        incidentId: create.incidentId,
        runId: state.runId,
        target: create.target,
        kind: create.kind,
        parameters: create.kind === "RUNWAY_CLOSED" ? { runwayId: create.parameters.runwayId } : {},
        createdAtSimSec: now,
        createdAtWallMs: ctx.wallNowMs,
        createdBy: ctx.createdBy ?? "controller",
        status: "ACTIVE",
        resolvedAtSimSec: null,
        revision: 1,
    }
    const incidents = { ...state.incidents, [incident.incidentId]: incident }
    const activated: IncidentEvent = {
        type: "INCIDENT_ACTIVATED",
        incidentId: incident.incidentId,
        kind: incident.kind,
        target: incident.target,
        summary: `${incident.kind}${runwayParam(incident) ? ` ${runwayParam(incident)}` : ""} active at ${incident.target}`,
    }

    let next: EntityState
    let events: IncidentEvent[]
    if (isAirportState(state)) {
        const r = recomputeAirport(state, incidents, ctx)
        next = r.state
        events = [activated, ...r.events]
    } else {
        // LOW_FUEL caps remaining fuel once, on first application of this ID.
        const fuelRemainingSec = create.kind === "LOW_FUEL" ? Math.min(state.fuelRemainingSec, LOW_FUEL_CAP_SEC) : state.fuelRemainingSec
        const r = recomputeFlight(state, { ...state, incidents, fuelRemainingSec })
        const urgent = r.events.some(e => e.type === "FLIGHT_CONDITIONS_CHANGED" && e.renegotiate)
        next = urgent && ctx.openEmergencyRound ? ctx.openEmergencyRound(r.state) : r.state
        events = [activated, ...r.events]
    }
    return {
        state: next,
        result: { outcome: "APPLIED", code: "OK", stateRevision: next.stateRevision },
        code: "OK",
        incidentId: incident.incidentId,
        incidentRevision: incident.revision,
        events,
    }
}

/** Resolve an active incident. A repeated clear of a resolved incident returns
 *  the original success without change; an unknown ID is rejected; a stale
 *  expectedIncidentRevision on an active incident conflicts. */
export function resolveIncident(state: AirportState, input: IncidentClear, ctx: IncidentContext): IncidentTransition<AirportState>
export function resolveIncident(state: FlightState, input: IncidentClear, ctx: IncidentContext): IncidentTransition<FlightState>
export function resolveIncident(state: EntityState, input: IncidentClear, ctx: IncidentContext): IncidentTransition<EntityState>
export function resolveIncident(state: EntityState, input: IncidentClear, ctx: IncidentContext): IncidentTransition<EntityState> {
    const parsed = IncidentClearSchema.safeParse(input)
    const incidentId = typeof (input as { incidentId?: unknown })?.incidentId === "string" ? input.incidentId : ""
    if (!parsed.success) return rejected(state, "INVALID_PAYLOAD", incidentId)
    const clear = parsed.data
    const bad = checkCommon(state, ctx, clear.target, clear.incidentId)
    if (bad) return bad
    const existing = state.incidents[clear.incidentId]
    if (!existing) return rejected(state, "UNKNOWN_INCIDENT", clear.incidentId)
    if (existing.status === "RESOLVED") return unchangedApplied(state, existing)
    if (clear.expectedIncidentRevision !== existing.revision) return rejected(state, "REVISION_CONFLICT", clear.incidentId, existing.revision)

    const resolved: Incident = {
        ...existing,
        status: "RESOLVED",
        resolvedAtSimSec: effectiveSimSec(state, ctx),
        revision: existing.revision + 1,
    }
    const incidents = { ...state.incidents, [resolved.incidentId]: resolved }
    const resolvedEvent: IncidentEvent = {
        type: "INCIDENT_RESOLVED",
        incidentId: resolved.incidentId,
        kind: resolved.kind,
        target: resolved.target,
        summary: `${resolved.kind}${runwayParam(resolved) ? ` ${runwayParam(resolved)}` : ""} resolved at ${resolved.target}`,
    }
    let next: EntityState
    let events: IncidentEvent[]
    if (isAirportState(state)) {
        const r = recomputeAirport(state, incidents, ctx)
        next = r.state
        events = [resolvedEvent, ...r.events]
    } else {
        // Fuel, position and route stay as they are; only the derived
        // priority, deadline and speed are recomputed.
        const r = recomputeFlight(state, { ...state, incidents })
        next = r.state
        events = [resolvedEvent, ...r.events]
    }
    return {
        state: next,
        result: { outcome: "APPLIED", code: "OK", stateRevision: next.stateRevision },
        code: "OK",
        incidentId: resolved.incidentId,
        incidentRevision: resolved.revision,
        events,
    }
}

// ---------------------------------------------------------------- controller command receive

/** COMMAND_RESULT back to the controller. The message ID is derived from the
 *  command, so a re-run of the same transition yields the same message. */
export function commandResultEntry(
    state: EntityState,
    command: ControllerCommandEnvelope,
    outcome: "APPLIED" | "REJECTED",
    code: DomainCode,
    incidentRevision: number | null,
    wallNowMs: number,
): OutboxEntry {
    return outboxEntry(
        {
            schemaVersion: 1,
            messageId: stableUuid(state.runId, state.entityId, "COMMAND_RESULT", command.commandId),
            runId: state.runId,
            fromEntityId: state.entityId,
            toEntityId: "controller",
            correlationId: command.commandId,
            causationId: command.messageId,
            createdAtWallMs: wallNowMs,
            expiresAtWallMs: null,
            type: "COMMAND_RESULT",
            payload: {
                commandId: command.commandId,
                outcome,
                code,
                resultingRevision: incidentRevision,
                incidentId: command.payload.incidentId,
            },
        },
        wallNowMs,
    )
}

function inboxRecord(message: ControllerCommandEnvelope, result: InboxResult["result"], wallNowMs: number): InboxResult {
    return { messageId: message.messageId, type: message.type, fromEntityId: message.fromEntityId, result, processedAtWallMs: wallNowMs }
}

function plainResult(r: DomainResult): InboxResult["result"] {
    return r.outcome === "DUPLICATE" ? r.original : r
}

/** Apply exactly one command whose sequence is next. Consumes the sequence
 *  whatever the outcome and queues its COMMAND_RESULT. */
function processSequenced<S extends EntityState>(
    state: S,
    message: ControllerCommandEnvelope,
    ctx: IncidentContext,
): { state: S; processed: ProcessedControllerCommand; events: IncidentEvent[] } {
    const base = { ...state, lastControllerSequence: message.commandSequence } as S
    const opCtx: IncidentContext = { ...ctx, causationId: message.messageId }
    let t: IncidentTransition<EntityState>
    if (message.expiresAtWallMs !== null && ctx.wallNowMs >= message.expiresAtWallMs) {
        t = rejected(base, "TIMEOUT", message.payload.incidentId, base.incidents[message.payload.incidentId]?.revision ?? null)
    } else if (message.type === "INCIDENT_CREATE") {
        t = applyIncident(base, message.payload, opCtx)
    } else {
        t = resolveIncident(base, message.payload, opCtx)
    }
    const outcome = t.result.outcome === "APPLIED" ? "APPLIED" : "REJECTED"
    const after = t.state as S
    const recorded = plainResult({ ...t.result, stateRevision: after.stateRevision + 1 } as DomainResult)
    const next = {
        ...after,
        stateRevision: after.stateRevision + 1,
        inbox: { ...after.inbox, [message.messageId]: inboxRecord(message, recorded, ctx.wallNowMs) },
        outbox: appendOutbox(after.outbox, [commandResultEntry(after, message, outcome, t.code, t.incidentRevision, ctx.wallNowMs)]),
    } as S
    return {
        state: next,
        processed: {
            messageId: message.messageId,
            commandId: message.commandId,
            commandSequence: message.commandSequence,
            outcome,
            code: t.code,
            incidentId: t.incidentId || message.payload.incidentId,
            incidentRevision: t.incidentRevision,
        },
        events: t.events,
    }
}

/**
 * Target-side entry point for INCIDENT_CREATE / INCIDENT_CLEAR received
 * through Relay (call it from AirportActor/FlightActor `receive`).
 *
 * - Duplicate messageId: returns DUPLICATE with the stored result; the
 *   COMMAND_RESULT outbox entry, if still unacknowledged, is retried now.
 * - Wrong run, non-controller sender or wrong recipient: REJECTED, recorded,
 *   sequence untouched, no COMMAND_RESULT.
 * - Sequence gap: buffered (REJECTED/BUFFERED). It is durable, so the router
 *   may ACK it; it applies once the gap fills.
 * - Next sequence: applied or rejected, then buffered successors drain.
 */
export function receiveControllerCommand<S extends EntityState>(
    state: S,
    message: ControllerCommandEnvelope,
    ctx: IncidentContext,
): ControllerReceiveTransition<S> {
    const unchanged = (code: string): ControllerReceiveTransition<S> => ({
        state,
        result: { outcome: "REJECTED", code, stateRevision: state.stateRevision },
        processed: [],
        events: [],
    })

    const prior = state.inbox[message.messageId]
    if (prior) {
        const resultId = stableUuid(state.runId, state.entityId, "COMMAND_RESULT", message.commandId)
        const outbox = state.outbox.map(e =>
            e.envelope.messageId === resultId && !e.acknowledged && e.nextAttemptAtWallMs > ctx.wallNowMs ? { ...e, nextAttemptAtWallMs: ctx.wallNowMs } : e,
        )
        return {
            state: outbox.some((e, i) => e !== state.outbox[i]) ? ({ ...state, outbox } as S) : state,
            result: { outcome: "DUPLICATE", code: prior.result.code, stateRevision: state.stateRevision, original: prior.result },
            processed: [],
            events: [],
        }
    }
    if (state.bufferedControllerMessages.some(b => b.envelope.messageId === message.messageId)) return unchanged(BUFFERED_CODE)

    const refuse = (code: DomainCode): ControllerReceiveTransition<S> => {
        const result = { outcome: "REJECTED" as const, code, stateRevision: state.stateRevision + 1 }
        return {
            state: { ...state, stateRevision: result.stateRevision, inbox: { ...state.inbox, [message.messageId]: inboxRecord(message, result, ctx.wallNowMs) } } as S,
            result,
            processed: [],
            events: [],
        }
    }
    if (message.runId !== state.runId || ctx.runId !== state.runId) return refuse("WRONG_RUN")
    if (message.fromEntityId !== "controller") return refuse("UNAUTHORIZED")
    if (message.toEntityId !== state.entityId) return refuse("UNAUTHORIZED")

    const seq = message.commandSequence
    if (seq <= state.lastControllerSequence) return refuse("STALE_STATE")
    if (seq > state.lastControllerSequence + 1) {
        if (state.bufferedControllerMessages.some(b => b.commandSequence === seq)) return unchanged(BUFFERED_CODE)
        const buffered = [...state.bufferedControllerMessages, { commandSequence: seq, envelope: message }].sort((a, b) => a.commandSequence - b.commandSequence)
        const next = { ...state, bufferedControllerMessages: buffered, stateRevision: state.stateRevision + 1 } as S
        return { state: next, result: { outcome: "REJECTED", code: BUFFERED_CODE, stateRevision: next.stateRevision }, processed: [], events: [] }
    }

    let current: S = state
    let pending: ControllerCommandEnvelope | null = message
    const processed: ProcessedControllerCommand[] = []
    const events: IncidentEvent[] = []
    let first: DomainResult | null = null
    while (pending) {
        const r: { state: S; processed: ProcessedControllerCommand; events: IncidentEvent[] } = processSequenced(current, pending, ctx)
        current = r.state
        processed.push(r.processed)
        events.push(...r.events)
        if (!first) first = current.inbox[pending.messageId]!.result
        const nextSeq = current.lastControllerSequence + 1
        const successor: S["bufferedControllerMessages"][number] | undefined = current.bufferedControllerMessages.find(b => b.commandSequence === nextSeq)
        const remaining = current.bufferedControllerMessages.filter(b => b.commandSequence > current.lastControllerSequence && b !== successor)
        if (remaining.length !== current.bufferedControllerMessages.length) current = { ...current, bufferedControllerMessages: remaining } as S
        pending = successor && !current.inbox[successor.envelope.messageId] ? (successor.envelope as ControllerCommandEnvelope) : null
    }
    return { state: current, result: { ...first!, stateRevision: current.stateRevision }, processed, events }
}
