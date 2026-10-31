// Runway slot search, conflict checks and emergency preemption (design §6, plan Task 4).
// Pure functions over AirportState. Simulation fields are seconds (…Sec); wall-clock fields are ms (…Ms).
// Intervals are half-open [start, end): one ending at 190 does not conflict with one starting at 190.
import {
    FUEL_RESERVE_SEC,
    LANDING_GRACE_SEC,
    PREEMPTION_MIN_LEAD_SEC,
    SLOT_GRID_SEC,
    SLOT_MIN_LEAD_SEC,
    SLOT_SEARCH_HORIZON_SEC,
} from "./constants.ts"
import type {
    AirportState,
    DomainCode,
    FlightFacts,
    Offer,
    Point,
    Priority,
    RunwayId,
} from "./contracts.ts"
import { distanceNm, travelSeconds } from "./geometry.ts"

export type Interval = { start: number; end: number }

export function intervalsOverlap(a: Interval, b: Interval): boolean {
    return a.start < b.end && b.start < a.end
}

// A booked slot protects [slotStart, slotStart + occupancy + 30 s landing grace).
export function protectedInterval(slotStartSimSec: number, occupancySec: number): Interval {
    return { start: slotStartSimSec, end: slotStartSimSec + occupancySec + LANDING_GRACE_SEC }
}

// An offer's TTL is expired at exactly expiresAtWallMs.
export function isOfferExpired(offer: Pick<Offer, "expiresAtWallMs">, wallNowMs: number): boolean {
    return wallNowMs >= offer.expiresAtWallMs
}

export type Commitment = {
    kind: "OFFER" | "RESERVATION" | "OCCUPANCY"
    id: string // offerId, reservationId, or `occupancy:<runwayId>`
    flightId: string | null
    negotiationId: string | null
    runwayId: RunwayId
    interval: Interval
    priority: Priority
    slotStartSimSec: number
    // Cleared, occupied and emergency commitments can never be preempted.
    preemptible: boolean
}

// Everything that currently blocks runway time: live tentative holds, protected reservations, occupancy.
export function runwayCommitments(airport: AirportState, wallNowMs: number, simNowSec: number): Commitment[] {
    const out: Commitment[] = []
    for (const offer of Object.values(airport.offers)) {
        if (offer.status !== "OFFERED" || isOfferExpired(offer, wallNowMs)) continue
        out.push({
            kind: "OFFER",
            id: offer.offerId,
            flightId: offer.flightId,
            negotiationId: offer.negotiationId,
            runwayId: offer.runwayId,
            interval: protectedInterval(offer.slotStartSimSec, offer.occupancySec),
            priority: offer.priority,
            slotStartSimSec: offer.slotStartSimSec,
            preemptible: offer.priority === "NORMAL" && offer.slotStartSimSec >= simNowSec + PREEMPTION_MIN_LEAD_SEC,
        })
    }
    for (const r of Object.values(airport.reservations)) {
        if (r.status !== "CONFIRMED" && r.status !== "CLEARED" && r.status !== "OCCUPIED") continue
        out.push({
            kind: "RESERVATION",
            id: r.reservationId,
            flightId: r.flightId,
            negotiationId: r.negotiationId,
            runwayId: r.runwayId,
            interval: protectedInterval(r.slotStartSimSec, r.occupancySec),
            priority: r.priority,
            slotStartSimSec: r.slotStartSimSec,
            preemptible:
                r.status === "CONFIRMED" &&
                r.priority === "NORMAL" &&
                r.slotStartSimSec >= simNowSec + PREEMPTION_MIN_LEAD_SEC &&
                !Object.values(airport.clearances).some(c => c.reservationId === r.reservationId && c.status === "ACTIVE"),
        })
    }
    for (const rw of airport.runways) {
        if (rw.occupiedUntilSimSec === null || rw.occupiedUntilSimSec <= simNowSec) continue
        out.push({
            kind: "OCCUPANCY",
            id: `occupancy:${rw.runwayId}`,
            flightId: null,
            negotiationId: null,
            runwayId: rw.runwayId,
            interval: { start: 0, end: rw.occupiedUntilSimSec },
            priority: "NORMAL",
            slotStartSimSec: 0,
            preemptible: false,
        })
    }
    return out
}

export function openRunways(airport: AirportState): RunwayId[] {
    if (airport.restrictions.arrivalsClosed) return []
    const closed = new Set(airport.restrictions.closedRunways)
    return airport.runways
        .map(r => r.runwayId)
        .filter(id => !closed.has(id))
        .sort()
}

export function isRunwayOpen(airport: AirportState, runwayId: RunwayId): boolean {
    return openRunways(airport).includes(runwayId)
}

// Earliest grid-aligned slot: ceil((now + travel + lead) / 30) * 30. The lead is
// minSlotLeadSimSec(speed, profile) so wall-clock booking latency fits before the slot.
export function earliestSlotStart(nowSimSec: number, travelSec: number, minSlotLeadSimSec: number = SLOT_MIN_LEAD_SEC): number {
    return Math.ceil((nowSimSec + travelSec + minSlotLeadSimSec) / SLOT_GRID_SEC) * SLOT_GRID_SEC
}

export type ArrivalWindow = {
    effectiveNowSimSec: number
    travelSec: number
    distanceNm: number
    earliestStartSimSec: number // grid aligned, includes the booking lead
    physicalEarliestSimSec: number // now + travel, no lead
    latestStartSimSec: number // min(fuel limit, deadline, search horizon)
    fuelLimitSimSec: number
    deadlineSimSec: number | null
}

// Feasible touchdown window for one flight at one airport, from facts sampled by the flight.
// The airport never uses a time earlier than its own clock or the sample time.
export function arrivalWindow(airportPosition: Point, facts: FlightFacts, simNowSec: number, minSlotLeadSimSec: number): ArrivalWindow {
    const effectiveNowSimSec = Math.max(simNowSec, facts.sampledAtSimSec)
    const fuelNow = facts.fuelRemainingSec - (effectiveNowSimSec - facts.sampledAtSimSec)
    const distance = distanceNm(facts.position, airportPosition)
    const travelSec = travelSeconds(distance, facts.speedKnots)
    const fuelLimitSimSec = effectiveNowSimSec + fuelNow - FUEL_RESERVE_SEC
    const horizon = effectiveNowSimSec + SLOT_SEARCH_HORIZON_SEC
    const latest = Math.min(fuelLimitSimSec, facts.deadlineSimSec ?? Infinity, horizon)
    return {
        effectiveNowSimSec,
        travelSec,
        distanceNm: distance,
        earliestStartSimSec: earliestSlotStart(effectiveNowSimSec, travelSec, minSlotLeadSimSec),
        physicalEarliestSimSec: effectiveNowSimSec + travelSec,
        latestStartSimSec: latest,
        fuelLimitSimSec,
        deadlineSimSec: facts.deadlineSimSec,
    }
}

export type Feasibility = { ok: true } | { ok: false; code: DomainCode; explanation: string }

// Can the flight still make this specific slot? Used at offer, at acceptance and at confirmation.
// `withLead` applies the booking lead (offer time); acceptance/confirmation only need physical reach.
export function slotFeasibility(window: ArrivalWindow, slotStartSimSec: number, withLead: boolean): Feasibility {
    const earliest = withLead ? window.earliestStartSimSec : window.physicalEarliestSimSec
    if (window.physicalEarliestSimSec > window.fuelLimitSimSec)
        return { ok: false, code: "UNREACHABLE", explanation: "Not enough fuel to reach the airport with reserve" }
    if (window.deadlineSimSec !== null && window.physicalEarliestSimSec > window.deadlineSimSec)
        return { ok: false, code: "DEADLINE_EXCEEDED", explanation: "Cannot reach the airport before the emergency deadline" }
    if (slotStartSimSec < earliest)
        return { ok: false, code: "UNREACHABLE", explanation: "Slot is earlier than the flight can arrive" }
    if (slotStartSimSec > window.fuelLimitSimSec)
        return { ok: false, code: "UNREACHABLE", explanation: "Slot is beyond the fuel reserve" }
    if (window.deadlineSimSec !== null && slotStartSimSec > window.deadlineSimSec)
        return { ok: false, code: "DEADLINE_EXCEEDED", explanation: "Slot is after the emergency deadline" }
    return { ok: true }
}

export type SlotChoice = { runwayId: RunwayId; slotStartSimSec: number }

export type SlotSearch = {
    earliestStartSimSec: number
    latestStartSimSec: number
    occupancySec: number
    wallNowMs: number
    simNowSec: number
    excludeIds?: ReadonlySet<string> // commitments to ignore (preemption victim, the offer being checked)
    runwayIds?: readonly RunwayId[]
}

export function conflictsOn(airport: AirportState, runwayId: RunwayId, interval: Interval, search: Pick<SlotSearch, "wallNowMs" | "simNowSec" | "excludeIds">): Commitment[] {
    return runwayCommitments(airport, search.wallNowMs, search.simNowSec).filter(
        c => c.runwayId === runwayId && !search.excludeIds?.has(c.id) && intervalsOverlap(c.interval, interval),
    )
}

// Earliest start on the 30 s grid, then runway ID. Closed runways are never offered.
export function findFreeSlot(airport: AirportState, search: SlotSearch): SlotChoice | null {
    const runways = openRunways(airport).filter(r => !search.runwayIds || search.runwayIds.includes(r))
    if (runways.length === 0) return null
    const commitments = runwayCommitments(airport, search.wallNowMs, search.simNowSec).filter(c => !search.excludeIds?.has(c.id))
    const first = Math.ceil(search.earliestStartSimSec / SLOT_GRID_SEC) * SLOT_GRID_SEC
    for (let t = first; t <= search.latestStartSimSec; t += SLOT_GRID_SEC) {
        const wanted = protectedInterval(t, search.occupancySec)
        for (const runwayId of runways) {
            if (!commitments.some(c => c.runwayId === runwayId && intervalsOverlap(c.interval, wanted)))
                return { runwayId, slotStartSimSec: t }
        }
    }
    return null
}

export type Preemption = SlotChoice & { victim: Commitment }

// Emergency only, after no free slot exists before the deadline. Victims: normal tentative holds or
// normal confirmed reservations at least 120 s out with no clearance. Never occupancy, a clearance,
// or another emergency. Earliest freed slot, then runway ID, then victim ID.
export function findPreemption(airport: AirportState, search: SlotSearch): Preemption | null {
    const victims = runwayCommitments(airport, search.wallNowMs, search.simNowSec).filter(c => c.preemptible)
    let best: Preemption | null = null
    for (const victim of victims) {
        const exclude = new Set(search.excludeIds ?? [])
        exclude.add(victim.id)
        const slot = findFreeSlot(airport, { ...search, excludeIds: exclude, runwayIds: [victim.runwayId] })
        if (!slot) continue
        const candidate: Preemption = { ...slot, victim }
        if (
            !best ||
            candidate.slotStartSimSec < best.slotStartSimSec ||
            (candidate.slotStartSimSec === best.slotStartSimSec &&
                (candidate.runwayId < best.runwayId || (candidate.runwayId === best.runwayId && victim.id < best.victim.id)))
        )
            best = candidate
    }
    return best
}

export type LandingRequestInput = {
    negotiationId: string
    flightId: string
    requestMessageId: string
    facts: FlightFacts
}

export type SchedulingContext = {
    simNowSec: number
    wallNowMs: number
    offerTtlMs: number // RELAY_TIMING[profile].offerTtlMs
    minSlotLeadSimSec: number // minSlotLeadSimSec(speed, profile)
}

export type OfferResult =
    | { kind: "OFFER"; offer: Offer; preempts: Commitment | null }
    | { kind: "REFUSED"; code: DomainCode; explanation: string }

export function offerIdFor(negotiationId: string, airportId: string): string {
    return `${negotiationId}@${airportId}`
}

// Pure decision for one LANDING_REQUEST. It never mutates the airport; the caller stores the
// returned offer as an exclusive tentative hold (and applies the preemption) before emitting it.
export function findLandingOffer(airport: AirportState, request: LandingRequestInput, ctx: SchedulingContext): OfferResult {
    if (airport.restrictions.arrivalsClosed) return { kind: "REFUSED", code: "CLOSED", explanation: `${airport.airportId} is closed to arrivals` }
    if (openRunways(airport).length === 0) return { kind: "REFUSED", code: "CLOSED", explanation: `All ${airport.airportId} runways are closed` }
    const simNowSec = Math.max(ctx.simNowSec, airport.lastAdvancedSimSec)
    const window = arrivalWindow(airport.position, request.facts, simNowSec, ctx.minSlotLeadSimSec)
    const reach = slotFeasibility(window, window.earliestStartSimSec, true)
    if (!reach.ok && reach.code !== "UNREACHABLE") return { kind: "REFUSED", ...reach }
    if (window.earliestStartSimSec > window.latestStartSimSec) {
        const deadlineBinds = window.deadlineSimSec !== null && window.deadlineSimSec < window.fuelLimitSimSec
        return deadlineBinds
            ? { kind: "REFUSED", code: "DEADLINE_EXCEEDED", explanation: "No achievable slot before the emergency deadline" }
            : { kind: "REFUSED", code: "UNREACHABLE", explanation: "No achievable slot within fuel reserve" }
    }
    const occupancySec = airport.restrictions.occupancySec
    const search: SlotSearch = {
        earliestStartSimSec: window.earliestStartSimSec,
        latestStartSimSec: window.latestStartSimSec,
        occupancySec,
        wallNowMs: ctx.wallNowMs,
        simNowSec,
        // A re-request in a new round replaces this flight's own older tentative holds.
        excludeIds: new Set(
            Object.values(airport.offers)
                .filter(o => o.flightId === request.flightId && o.status === "OFFERED")
                .map(o => o.offerId),
        ),
    }
    const free = findFreeSlot(airport, search)
    const pre = free ? null : request.facts.priority === "EMERGENCY" ? findPreemption(airport, search) : null
    const slot = free ?? pre
    if (!slot) {
        const deadlineBinds = window.deadlineSimSec !== null && window.deadlineSimSec < window.fuelLimitSimSec
        return deadlineBinds && request.facts.priority === "EMERGENCY"
            ? { kind: "REFUSED", code: "DEADLINE_EXCEEDED", explanation: "No runway time before the emergency deadline" }
            : { kind: "REFUSED", code: "NO_CAPACITY", explanation: "No free runway slot in the next 30 minutes" }
    }
    const offer: Offer = {
        negotiationId: request.negotiationId,
        offerId: offerIdFor(request.negotiationId, airport.airportId),
        airportId: airport.airportId,
        runwayId: slot.runwayId,
        slotStartSimSec: slot.slotStartSimSec,
        occupancySec,
        expiresAtWallMs: ctx.wallNowMs + ctx.offerTtlMs,
        airportOperationalRevision: airport.operationalRevision,
        flightId: request.flightId,
        status: "OFFERED",
        requestMessageId: request.requestMessageId,
        priority: request.facts.priority,
    }
    return { kind: "OFFER", offer, preempts: pre ? pre.victim : null }
}

// No two live commitments on one runway overlap. Used by tests and as a cheap runtime assertion.
export function findOverlaps(airport: AirportState, wallNowMs: number, simNowSec: number): Array<[Commitment, Commitment]> {
    const list = runwayCommitments(airport, wallNowMs, simNowSec)
    const out: Array<[Commitment, Commitment]> = []
    for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i]!
            const b = list[j]!
            if (a.runwayId === b.runwayId && intervalsOverlap(a.interval, b.interval)) out.push([a, b])
        }
    return out
}
