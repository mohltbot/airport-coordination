// Landing negotiation transitions (design §6 "Exact booking sequence", plan Task 4).
// Airport side: holds, offers, acceptance, release, status, clearance, touchdown.
// Flight side: rounds, reply collection, one pending acceptance, reconciliation, single assignment.
// Every function is pure: it returns a new aggregate with outgoing envelopes already in its outbox,
// so the actor persists state and messages in one assignment.
import {
    AIRPORTS,
    FUEL_RESERVE_SEC,
    LANDING_GRACE_SEC,
    MAX_EMERGENCY_CANDIDATES,
    NO_FEASIBLE_RETRY_MS,
    minSlotLeadSimSec,
    type RelayTiming,
} from "./constants.js"
import {
    entityHandle,
    flightEntityId,
    type AgentActionType,
    type AgentDecision,
    type AgentDecisionInput,
    type AirportId,
    type AirportState,
    type Assignment,
    type AtcDecision,
    type Clearance,
    type ClearanceCheck,
    type ClearanceCheckResult,
    type DecisionSource,
    type DomainCode,
    type DomainResult,
    type EntityId,
    type FlightFacts,
    type FlightState,
    type Job,
    type MessageType,
    type NegotiationReply,
    type NegotiationRound,
    type Offer,
    type OutboxEntry,
    type Payload,
    type PilotDecision,
    type Priority,
    type ProtocolEnvelope,
    type Reservation,
    type Tick,
    type TouchdownInput,
    type TouchdownReceipt,
    type Transition,
} from "./contracts.js"
import { distanceNm, travelSeconds } from "./geometry.js"
import {
    chooseAtcAction,
    choosePilotAction,
    isRefusalCode,
    rankOffers,
    type AtcView,
    type PilotOfferView,
    type PilotView,
} from "./policy.js"
import {
    arrivalWindow,
    findLandingOffer,
    isOfferExpired,
    isRunwayOpen,
    offerIdFor,
    slotFeasibility,
    type Commitment,
} from "./scheduling.js"

// ---------------------------------------------------------------- context

export type NegotiationTiming = {
    replyCollectionWindowMs: number
    offerAcceptTimeoutMs: number
    offerTtlMs: number
    minSlotLeadSimSec: number
    noFeasibleRetryMs: number
}

// Wall-clock offer timing from the transport profile (RELAY_TIMING.HOSTED on hosted Relay).
export function negotiationTiming(profile: RelayTiming, speed: number): NegotiationTiming {
    return {
        replyCollectionWindowMs: profile.replyCollectionWindowMs,
        offerAcceptTimeoutMs: profile.offerAcceptTimeoutMs,
        offerTtlMs: profile.offerTtlMs,
        minSlotLeadSimSec: minSlotLeadSimSec(speed, profile),
        noFeasibleRetryMs: NO_FEASIBLE_RETRY_MS,
    }
}

// IMMEDIATE applies the rules policy inside the transition (no agent runner needed).
// JOB queues a PILOT_DECISION / ATC_DECISION job; commitPilotDecision / commitAtcDecision apply it.
export type DecisionMode = "IMMEDIATE" | "JOB"

export type NegotiationContext = {
    simNowSec: number
    wallNowMs: number
    timing: NegotiationTiming
    decisionMode?: DecisionMode
    newId?: () => string
}

type Inbound<E = ProtocolEnvelope> = E extends unknown
    ? Pick<E & ProtocolEnvelope, "messageId" | "fromEntityId" | "type" | "payload" | "correlationId">
    : never
export type InboundMessage = Inbound
type InboundOf<T extends MessageType> = Extract<InboundMessage, { type: T }>

const newId = (ctx: NegotiationContext) => (ctx.newId ? ctx.newId() : crypto.randomUUID())
const modeOf = (ctx: NegotiationContext): DecisionMode => ctx.decisionMode ?? "IMMEDIATE"

// ---------------------------------------------------------------- outbox helpers

type Entity = { runId: string; entityId: EntityId; outbox: OutboxEntry[]; stateRevision: number }

export function buildEnvelope<T extends MessageType>(
    from: { runId: string; entityId: EntityId },
    ctx: NegotiationContext,
    to: EntityId,
    type: T,
    payload: Payload<T>,
    correlationId: string,
    causationId: string | null,
    expiresAtWallMs: number | null = null,
): ProtocolEnvelope {
    return {
        schemaVersion: 1,
        messageId: newId(ctx),
        runId: from.runId,
        fromEntityId: from.entityId,
        toEntityId: to,
        type,
        payload,
        correlationId,
        causationId,
        createdAtWallMs: ctx.wallNowMs,
        expiresAtWallMs,
    } as ProtocolEnvelope
}

export function appendOutbox<S extends Entity>(state: S, envelopes: readonly ProtocolEnvelope[], wallNowMs: number): S {
    if (envelopes.length === 0) return state
    const entries: OutboxEntry[] = envelopes.map(envelope => ({
        envelope,
        recipientHandle: entityHandle(state.runId, envelope.toEntityId),
        attemptCount: 0,
        nextAttemptAtWallMs: wallNowMs,
        transportMessageId: null,
        acknowledged: false,
    }))
    return { ...state, outbox: [...state.outbox, ...entries] }
}

function done<S extends Entity>(state: S, prev: S, code: string, out: ProtocolEnvelope[], ctx: NegotiationContext): Transition<S> {
    const next = appendOutbox({ ...state, stateRevision: prev.stateRevision + 1 }, out, ctx.wallNowMs)
    return { state: next, result: { outcome: "APPLIED", code, stateRevision: next.stateRevision } }
}

function reject<S extends Entity>(state: S, code: DomainCode): Transition<S> {
    return { state, result: { outcome: "REJECTED", code, stateRevision: state.stateRevision } }
}

const flightIdOf = (entityId: EntityId): string | null => (entityId.startsWith("flight:") ? entityId.slice(7) : null)
const airportIdOf = (entityId: EntityId): AirportId | null =>
    entityId.startsWith("airport:") ? (entityId.slice(8) as AirportId) : null

export const reservationIdFor = (offerId: string) => `rsv-${offerId}`
// Timeline threads group by round: every negotiation envelope's correlationId is the roundId
// (= negotiationId). Reservation IDs are `rsv-<roundId>@<airport>`, so the round is recoverable.
export function roundIdOfReservation(reservationId: string): string {
    if (!reservationId.startsWith("rsv-")) return reservationId
    const body = reservationId.slice(4)
    const at = body.lastIndexOf("@")
    return at > 0 ? body.slice(0, at) : body
}
export const clearanceIdFor = (reservationId: string) => `clr-${reservationId}`

function newJob(
    kind: Job["kind"],
    decisionRevision: number,
    trigger: string,
    priority: Priority,
    allowedActions: AgentActionType[],
    relevantMessageIds: string[],
    ctx: NegotiationContext,
): Job {
    return {
        jobId: `job-${newId(ctx)}`,
        kind,
        status: "QUEUED",
        decisionRevision,
        input: { trigger: trigger.slice(0, 64), priority, allowedActions, relevantMessageIds, createdAtWallMs: ctx.wallNowMs },
        leaseToken: null,
        leaseUntilWallMs: null,
        attemptCount: 0,
        outcome: null,
    }
}

function commitJob(job: Job, source: DecisionSource, action: AgentActionType, reason: string, ctx: NegotiationContext): Job {
    return {
        ...job,
        status: "COMMITTED",
        leaseToken: null,
        leaseUntilWallMs: null,
        outcome: { source, action, reason: reason.slice(0, 240), committedAtWallMs: ctx.wallNowMs },
    }
}

const isOpenJob = (j: Job) => j.status === "QUEUED" || j.status === "LEASED"

// ================================================================ AIRPORT SIDE

function schedCtx(airport: AirportState, ctx: NegotiationContext) {
    return {
        simNowSec: Math.max(ctx.simNowSec, airport.lastAdvancedSimSec),
        wallNowMs: ctx.wallNowMs,
        offerTtlMs: ctx.timing.offerTtlMs,
        minSlotLeadSimSec: ctx.timing.minSlotLeadSimSec,
    }
}

function airportNow(airport: AirportState, ctx: NegotiationContext) {
    return Math.max(ctx.simNowSec, airport.lastAdvancedSimSec)
}

// An offer whose ATC decision job has not committed yet: held exclusively, not yet sent.
export function isUnsentHold(airport: AirportState, offer: Offer): boolean {
    return Object.values(airport.jobs).some(
        j => j.kind === "ATC_DECISION" && isOpenJob(j) && j.input.relevantMessageIds[0] === offer.requestMessageId,
    )
}

function offerEnvelope(airport: AirportState, offer: Offer, ctx: NegotiationContext, causation: string | null) {
    return buildEnvelope(
        airport,
        ctx,
        flightEntityId(offer.flightId),
        "LANDING_OFFER",
        {
            negotiationId: offer.negotiationId,
            offerId: offer.offerId,
            airportId: offer.airportId,
            runwayId: offer.runwayId,
            slotStartSimSec: offer.slotStartSimSec,
            occupancySec: offer.occupancySec,
            expiresAtWallMs: offer.expiresAtWallMs,
            airportOperationalRevision: offer.airportOperationalRevision,
        },
        offer.negotiationId,
        causation,
        offer.expiresAtWallMs,
    )
}

function refusalEnvelope(
    airport: AirportState,
    flightId: string,
    negotiationId: string,
    code: DomainCode,
    explanation: string,
    ctx: NegotiationContext,
    causation: string | null,
) {
    return buildEnvelope(
        airport,
        ctx,
        flightEntityId(flightId),
        "LANDING_REFUSED",
        { negotiationId, airportId: airport.airportId, code, explanation: explanation.slice(0, 240) },
        negotiationId,
        causation,
    )
}

function confirmedEnvelope(airport: AirportState, r: Reservation, ctx: NegotiationContext, causation: string | null) {
    return buildEnvelope(
        airport,
        ctx,
        flightEntityId(r.flightId),
        "LANDING_CONFIRMED",
        {
            negotiationId: r.negotiationId,
            offerId: r.offerId,
            reservationId: r.reservationId,
            runwayId: r.runwayId,
            slotStartSimSec: r.slotStartSimSec,
            occupancySec: r.occupancySec,
        },
        r.negotiationId,
        causation,
    )
}

// Revoke one commitment and notify its flight durably in the same aggregate.
// Offers get LANDING_REFUSED for their negotiation; reservations get RESERVATION_REVOKED.
export function revokeCommitment(
    airport: AirportState,
    c: Pick<Commitment, "kind" | "id">,
    code: DomainCode,
    reason: string,
    ctx: NegotiationContext,
    causation: string | null = null,
): { airport: AirportState; out: ProtocolEnvelope[] } {
    if (c.kind === "OFFER") {
        const offer = airport.offers[c.id]
        if (!offer || offer.status !== "OFFERED") return { airport, out: [] }
        const next = { ...airport, offers: { ...airport.offers, [offer.offerId]: { ...offer, status: "REVOKED" as const } } }
        // An unsent hold has no flight-side offer yet; its pending request still gets an answer.
        return { airport: next, out: [refusalEnvelope(airport, offer.flightId, offer.negotiationId, code, reason, ctx, causation)] }
    }
    if (c.kind === "RESERVATION") {
        const r = airport.reservations[c.id]
        if (!r || (r.status !== "CONFIRMED" && r.status !== "CLEARED")) return { airport, out: [] }
        const clearances: Record<string, Clearance> = { ...airport.clearances }
        for (const cl of Object.values(clearances))
            if (cl.reservationId === r.reservationId && cl.status === "ACTIVE") clearances[cl.clearanceId] = { ...cl, status: "REVOKED" }
        const next = {
            ...airport,
            reservations: { ...airport.reservations, [r.reservationId]: { ...r, status: "REVOKED" as const } },
            clearances,
        }
        const env = buildEnvelope(
            airport,
            ctx,
            flightEntityId(r.flightId),
            "RESERVATION_REVOKED",
            { reservationId: r.reservationId, code, reason: reason.slice(0, 240), airportOperationalRevision: airport.operationalRevision },
            r.negotiationId,
            causation,
        )
        return { airport: next, out: [env] }
    }
    return { airport, out: [] }
}

// For incident code (Task 3): revoke every live offer, reservation and clearance on runways
// matching `affects`, notifying each flight. Occupied/completed runway time is never undone.
export function revokeArrangements(
    airport: AirportState,
    affects: (runwayId: string) => boolean,
    code: DomainCode,
    reason: string,
    ctx: NegotiationContext,
    causation: string | null = null,
): { airport: AirportState; out: ProtocolEnvelope[] } {
    let next = airport
    const out: ProtocolEnvelope[] = []
    for (const o of Object.values(airport.offers)) {
        if (o.status !== "OFFERED" || !affects(o.runwayId)) continue
        if (isOfferExpired(o, ctx.wallNowMs)) {
            next = { ...next, offers: { ...next.offers, [o.offerId]: { ...o, status: "EXPIRED" } } }
            continue
        }
        const r = revokeCommitment(next, { kind: "OFFER", id: o.offerId }, code, reason, ctx, causation)
        next = r.airport
        out.push(...r.out)
    }
    for (const res of Object.values(airport.reservations)) {
        if ((res.status !== "CONFIRMED" && res.status !== "CLEARED") || !affects(res.runwayId)) continue
        const r = revokeCommitment(next, { kind: "RESERVATION", id: res.reservationId }, code, reason, ctx, causation)
        next = r.airport
        out.push(...r.out)
    }
    // Cancel ATC jobs whose hold was just revoked.
    const jobs = { ...next.jobs }
    for (const j of Object.values(jobs)) {
        if (j.kind !== "ATC_DECISION" || !isOpenJob(j)) continue
        const held = Object.values(next.offers).find(o => o.requestMessageId === j.input.relevantMessageIds[0])
        if (held && held.status !== "OFFERED") jobs[j.jobId] = { ...j, status: "CANCELLED" }
    }
    return { airport: { ...next, jobs }, out }
}

// LANDING_REQUEST: hold the earliest feasible slot exclusively, then offer it (or queue the ATC job).
export function handleLandingRequest(airport: AirportState, msg: InboundOf<"LANDING_REQUEST">, ctx: NegotiationContext): Transition<AirportState> {
    const p = msg.payload
    if (msg.fromEntityId !== flightEntityId(p.flightId)) return reject(airport, "UNAUTHORIZED")
    const offerId = offerIdFor(p.negotiationId, airport.airportId)
    const existing = airport.offers[offerId]
    if (existing) {
        // Same round asked twice: reissue the stored outcome, never a second hold.
        const out: ProtocolEnvelope[] = []
        if (existing.status === "OFFERED" && !isUnsentHold(airport, existing)) out.push(offerEnvelope(airport, existing, ctx, msg.messageId))
        else if (existing.status === "CONFIRMED") {
            const r = airport.reservations[reservationIdFor(offerId)]
            if (r) out.push(confirmedEnvelope(airport, r, ctx, msg.messageId))
        } else if (existing.status !== "OFFERED")
            out.push(refusalEnvelope(airport, p.flightId, p.negotiationId, "STALE_STATE", `Offer ${existing.status.toLowerCase()}`, ctx, msg.messageId))
        return done(airport, airport, "OK", out, ctx)
    }
    const facts: FlightFacts = {
        position: p.position,
        speedKnots: p.speedKnots,
        fuelRemainingSec: p.fuelRemainingSec,
        sampledAtSimSec: p.sampledAtSimSec,
        priority: p.priority,
        deadlineSimSec: p.deadlineSimSec,
    }
    const r = findLandingOffer(
        airport,
        { negotiationId: p.negotiationId, flightId: p.flightId, requestMessageId: msg.messageId, facts },
        schedCtx(airport, ctx),
    )
    if (r.kind === "REFUSED")
        return done(airport, airport, r.code, [refusalEnvelope(airport, p.flightId, p.negotiationId, r.code, r.explanation, ctx, msg.messageId)], ctx)

    // One tentative offer per flight/airport: older rounds' holds from this flight lapse.
    const offers: Record<string, Offer> = { ...airport.offers }
    for (const o of Object.values(offers))
        if (o.flightId === p.flightId && o.status === "OFFERED") offers[o.offerId] = { ...o, status: "EXPIRED" }
    offers[r.offer.offerId] = r.offer
    let next: AirportState = { ...airport, offers }
    const out: ProtocolEnvelope[] = []
    if (r.preempts) {
        const rv = revokeCommitment(
            next,
            r.preempts,
            "NO_CAPACITY",
            `Slot reassigned to emergency flight ${p.flightId}; please renegotiate`,
            ctx,
            msg.messageId,
        )
        next = rv.airport
        out.push(...rv.out)
    }
    if (modeOf(ctx) === "JOB") {
        const job = newJob("ATC_DECISION", airport.decisionRevision, "LANDING_REQUEST", p.priority, ["PROPOSE_OFFER", "REFUSE"], [msg.messageId], ctx)
        next = { ...next, jobs: { ...next.jobs, [job.jobId]: job } }
    } else {
        out.push(offerEnvelope(next, r.offer, ctx, msg.messageId))
    }
    return done(next, airport, "OK", out, ctx)
}

// Compact ATC model view for one queued ATC_DECISION job.
export function buildAtcView(airport: AirportState, job: Job, ctx: NegotiationContext): AtcView | null {
    const held = Object.values(airport.offers).find(o => o.requestMessageId === job.input.relevantMessageIds[0])
    if (!held) return null
    const now = airportNow(airport, ctx)
    const queue = [
        ...Object.values(airport.reservations).filter(r => r.status === "CONFIRMED" || r.status === "CLEARED" || r.status === "OCCUPIED"),
        ...Object.values(airport.offers).filter(o => o.status === "OFFERED" && o.offerId !== held.offerId && !isOfferExpired(o, ctx.wallNowMs)),
    ]
        .map(x => ({ flightId: x.flightId, runwayId: x.runwayId, slotStartSimSec: x.slotStartSimSec, priority: x.priority, status: x.status }))
        .sort((a, b) => a.slotStartSimSec - b.slotStartSimSec || a.runwayId.localeCompare(b.runwayId))
    return {
        role: "ATC",
        airportId: airport.airportId,
        simNowSec: now,
        arrivalsClosed: airport.restrictions.arrivalsClosed,
        closedRunways: [...airport.restrictions.closedRunways],
        occupancySec: airport.restrictions.occupancySec,
        request: { negotiationId: held.negotiationId, flightId: held.flightId, priority: held.priority, deadlineSimSec: null },
        held: held.status === "OFFERED" ? { offerId: held.offerId, runwayId: held.runwayId, slotStartSimSec: held.slotStartSimSec } : null,
        queue,
    }
}

// Apply an ATC proposal (model or rules). The actor's commit code enforces hard constraints:
// the offer must be exactly the held slot; an emergency hold is never refused; a stale hold is answered
// with a refusal instead of an offer.
export function commitAtcDecision(
    airport: AirportState,
    jobId: string,
    decision: AtcDecision,
    source: DecisionSource,
    ctx: NegotiationContext,
): Transition<AirportState> & { appliedSource: DecisionSource } {
    const job = airport.jobs[jobId]
    if (!job || job.kind !== "ATC_DECISION" || !isOpenJob(job)) return { ...reject(airport, "STALE_STATE"), appliedSource: source }
    const held = Object.values(airport.offers).find(o => o.requestMessageId === job.input.relevantMessageIds[0])
    if (!held) return { ...reject(airport, "STALE_STATE"), appliedSource: source }
    const out: ProtocolEnvelope[] = []
    let next: AirportState = airport
    const stale =
        held.status !== "OFFERED" || isOfferExpired(held, ctx.wallNowMs) || !isRunwayOpen(airport, held.runwayId)
    if (stale) {
        const code: DomainCode = !isRunwayOpen(airport, held.runwayId) ? "CLOSED" : "STALE_STATE"
        // A revoked hold already told the flight; otherwise answer the pending request now.
        if (held.status !== "REVOKED")
            out.push(refusalEnvelope(airport, held.flightId, held.negotiationId, code, "Hold lapsed before the decision", ctx, held.requestMessageId))
        if (held.status === "OFFERED")
            next = { ...next, offers: { ...next.offers, [held.offerId]: { ...held, status: code === "CLOSED" ? "REVOKED" : "EXPIRED" } } }
        next = { ...next, jobs: { ...next.jobs, [jobId]: { ...job, status: "CANCELLED" } } }
        return { ...done(next, airport, code, out, ctx), appliedSource: source }
    }
    let applied: AtcDecision = decision
    let appliedSource = source
    const matchesHold =
        decision.type === "PROPOSE_OFFER" &&
        decision.negotiationId === held.negotiationId &&
        decision.flightId === held.flightId &&
        decision.runwayId === held.runwayId &&
        decision.slotStartSimSec === held.slotStartSimSec
    const illegalRefusal =
        decision.type === "REFUSE" &&
        (held.priority === "EMERGENCY" || !isRefusalCode(decision.code) || decision.negotiationId !== held.negotiationId)
    if ((decision.type === "PROPOSE_OFFER" && !matchesHold) || illegalRefusal) {
        applied = chooseAtcAction(buildAtcView(airport, job, ctx)!, ["PROPOSE_OFFER"])
        appliedSource = "RULES_FALLBACK"
    }
    if (applied.type === "REFUSE") {
        next = { ...next, offers: { ...next.offers, [held.offerId]: { ...held, status: "DECLINED" } } }
        out.push(refusalEnvelope(airport, held.flightId, held.negotiationId, applied.code, applied.reason, ctx, held.requestMessageId))
    } else {
        const offer: Offer = { ...held, expiresAtWallMs: ctx.wallNowMs + ctx.timing.offerTtlMs }
        next = { ...next, offers: { ...next.offers, [held.offerId]: offer } }
        out.push(offerEnvelope(next, offer, ctx, held.requestMessageId))
    }
    next = { ...next, jobs: { ...next.jobs, [jobId]: commitJob(job, appliedSource, applied.type, applied.reason, ctx) } }
    return { ...done(next, airport, "OK", out, ctx), appliedSource }
}

// OFFER_ACCEPT: recheck TTL, restrictions, runway conflict and the flight's current reach, then
// atomically convert the hold into a confirmed reservation. A duplicate returns the same reservation.
export function acceptOffer(airport: AirportState, msg: InboundOf<"OFFER_ACCEPT">, ctx: NegotiationContext): Transition<AirportState> {
    const p = msg.payload
    const flightId = flightIdOf(msg.fromEntityId)
    const offer = airport.offers[p.offerId]
    if (!flightId) return reject(airport, "UNAUTHORIZED")
    const refuse = (code: DomainCode, why: string, nextAirport: AirportState = airport) =>
        done(nextAirport, airport, code, [refusalEnvelope(airport, flightId, p.negotiationId, code, why, ctx, msg.messageId)], ctx)
    if (!offer) return refuse("STALE_STATE", "Unknown offer")
    if (offer.flightId !== flightId || offer.negotiationId !== p.negotiationId) return reject(airport, "UNAUTHORIZED")
    if (offer.status === "CONFIRMED") {
        const r = airport.reservations[reservationIdFor(offer.offerId)]
        if (r) return done(airport, airport, "OK", [confirmedEnvelope(airport, r, ctx, msg.messageId)], ctx)
    }
    if (offer.status === "EXPIRED") return refuse("OFFER_EXPIRED", "Offer expired")
    if (offer.status !== "OFFERED") return refuse("STALE_STATE", `Offer ${offer.status.toLowerCase()}`)
    const setOffer = (status: Offer["status"]) => ({ ...airport, offers: { ...airport.offers, [offer.offerId]: { ...offer, status } } })
    if (isOfferExpired(offer, ctx.wallNowMs)) return refuse("OFFER_EXPIRED", "Offer TTL elapsed", setOffer("EXPIRED"))
    if (!isRunwayOpen(airport, offer.runwayId)) return refuse("CLOSED", `${offer.runwayId} is closed to arrivals`, setOffer("REVOKED"))
    // The flight's facts at acceptance time: the slot must still be physically reachable within fuel/deadline.
    const window = arrivalWindow(airport.position, p.facts, airportNow(airport, ctx), 0)
    const feasible = slotFeasibility(window, offer.slotStartSimSec, false)
    if (!feasible.ok) return refuse(feasible.code, feasible.explanation, setOffer("REVOKED"))
    const reservation: Reservation = {
        negotiationId: offer.negotiationId,
        offerId: offer.offerId,
        airportId: offer.airportId,
        runwayId: offer.runwayId,
        slotStartSimSec: offer.slotStartSimSec,
        occupancySec: offer.occupancySec,
        expiresAtWallMs: offer.expiresAtWallMs,
        airportOperationalRevision: airport.operationalRevision,
        flightId: offer.flightId,
        requestMessageId: offer.requestMessageId,
        priority: offer.priority,
        reservationId: reservationIdFor(offer.offerId),
        status: "CONFIRMED",
    }
    const next: AirportState = {
        ...airport,
        offers: { ...airport.offers, [offer.offerId]: { ...offer, status: "CONFIRMED" } },
        reservations: { ...airport.reservations, [reservation.reservationId]: reservation },
    }
    return done(next, airport, "OK", [confirmedEnvelope(next, reservation, ctx, msg.messageId)], ctx)
}

export function handleOfferDecline(airport: AirportState, msg: InboundOf<"OFFER_DECLINE">, ctx: NegotiationContext): Transition<AirportState> {
    const offer = airport.offers[msg.payload.offerId]
    if (!offer) return done(airport, airport, "OK", [], ctx)
    if (flightEntityId(offer.flightId) !== msg.fromEntityId) return reject(airport, "UNAUTHORIZED")
    if (offer.status !== "OFFERED") return done(airport, airport, "OK", [], ctx)
    return done({ ...airport, offers: { ...airport.offers, [offer.offerId]: { ...offer, status: "DECLINED" } } }, airport, "OK", [], ctx)
}

export function handleReservationRelease(airport: AirportState, msg: InboundOf<"RESERVATION_RELEASE">, ctx: NegotiationContext): Transition<AirportState> {
    const r = airport.reservations[msg.payload.reservationId]
    if (msg.fromEntityId !== flightEntityId(msg.payload.flightId)) return reject(airport, "UNAUTHORIZED")
    if (!r) return done(airport, airport, "OK", [], ctx)
    if (r.flightId !== msg.payload.flightId) return reject(airport, "UNAUTHORIZED")
    if (r.status !== "CONFIRMED" && r.status !== "CLEARED") return done(airport, airport, "OK", [], ctx)
    const clearances = { ...airport.clearances }
    for (const c of Object.values(clearances))
        if (c.reservationId === r.reservationId && c.status === "ACTIVE") clearances[c.clearanceId] = { ...c, status: "REVOKED" }
    const next = { ...airport, reservations: { ...airport.reservations, [r.reservationId]: { ...r, status: "RELEASED" as const } }, clearances }
    return done(next, airport, "OK", [], ctx)
}

// RESERVATION_STATUS_REQUEST: the flight's way out of an uncertain acceptance (lost confirmation).
export function handleReservationStatusRequest(
    airport: AirportState,
    msg: InboundOf<"RESERVATION_STATUS_REQUEST">,
    ctx: NegotiationContext,
): Transition<AirportState> {
    const p = msg.payload
    const flightId = flightIdOf(msg.fromEntityId)
    if (!flightId) return reject(airport, "UNAUTHORIZED")
    let next = airport
    const offer = airport.offers[p.offerId]
    let status: Payload<"RESERVATION_STATUS">["status"] = "UNKNOWN"
    let reservation: Payload<"RESERVATION_STATUS">["reservation"] = null
    let reservationId: string | null = p.reservationId
    if (offer && offer.flightId === flightId) {
        if (offer.status === "CONFIRMED") {
            const r = airport.reservations[reservationIdFor(offer.offerId)]
            if (r) {
                status = r.status
                reservationId = r.reservationId
                reservation = { reservationId: r.reservationId, runwayId: r.runwayId, slotStartSimSec: r.slotStartSimSec, occupancySec: r.occupancySec }
            }
        } else if (offer.status === "OFFERED" && isOfferExpired(offer, ctx.wallNowMs)) {
            next = { ...airport, offers: { ...airport.offers, [offer.offerId]: { ...offer, status: "EXPIRED" } } }
            status = "EXPIRED"
        } else status = offer.status
    }
    const env = buildEnvelope(
        airport,
        ctx,
        msg.fromEntityId,
        "RESERVATION_STATUS",
        { negotiationId: p.negotiationId, offerId: p.offerId, reservationId, status, reservation },
        p.negotiationId,
        msg.messageId,
    )
    return done(next, airport, "OK", [env], ctx)
}

export function handleClearanceRequest(airport: AirportState, msg: InboundOf<"CLEARANCE_REQUEST">, ctx: NegotiationContext): Transition<AirportState> {
    const p = msg.payload
    const flightId = flightIdOf(msg.fromEntityId)
    if (!flightId) return reject(airport, "UNAUTHORIZED")
    const r = airport.reservations[p.reservationId]
    const refuse = (code: DomainCode, nextAirport: AirportState = airport) =>
        done(
            nextAirport,
            airport,
            code,
            [buildEnvelope(airport, ctx, msg.fromEntityId, "CLEARANCE_REFUSED", { reservationId: p.reservationId, code }, roundIdOfReservation(p.reservationId), msg.messageId)],
            ctx,
        )
    if (!r || r.flightId !== flightId) return refuse("STALE_STATE")
    const now = airportNow(airport, ctx)
    if (r.status === "CLEARED") {
        const c = airport.clearances[clearanceIdFor(r.reservationId)]
        if (c && c.status === "ACTIVE") return done(airport, airport, "OK", [grantedEnvelope(airport, c, ctx, msg.messageId, msg.fromEntityId)], ctx)
    }
    if (r.status !== "CONFIRMED") return refuse("STALE_STATE")
    if (!isRunwayOpen(airport, r.runwayId)) return refuse("CLOSED")
    const windowEnd = r.slotStartSimSec + LANDING_GRACE_SEC
    const reach = arrivalWindow(airport.position, p.facts, now, 0)
    if (now > windowEnd || reach.physicalEarliestSimSec > windowEnd) {
        const expired = { ...airport, reservations: { ...airport.reservations, [r.reservationId]: { ...r, status: "EXPIRED" as const } } }
        return refuse("DEADLINE_EXCEEDED", expired)
    }
    const clearance: Clearance = {
        clearanceId: clearanceIdFor(r.reservationId),
        reservationId: r.reservationId,
        flightId,
        runwayId: r.runwayId,
        windowStartSimSec: r.slotStartSimSec,
        windowEndSimSec: windowEnd,
        airportOperationalRevision: airport.operationalRevision,
        status: "ACTIVE",
    }
    const next: AirportState = {
        ...airport,
        reservations: { ...airport.reservations, [r.reservationId]: { ...r, status: "CLEARED" } },
        clearances: { ...airport.clearances, [clearance.clearanceId]: clearance },
    }
    return done(next, airport, "OK", [grantedEnvelope(next, clearance, ctx, msg.messageId, msg.fromEntityId)], ctx)
}

function grantedEnvelope(airport: AirportState, c: Clearance, ctx: NegotiationContext, causation: string, to: EntityId) {
    return buildEnvelope(
        airport,
        ctx,
        to,
        "CLEARANCE_GRANTED",
        {
            reservationId: c.reservationId,
            clearanceId: c.clearanceId,
            airportOperationalRevision: c.airportOperationalRevision,
            windowStartSimSec: c.windowStartSimSec,
            windowEndSimSec: c.windowEndSimSec,
        },
        roundIdOfReservation(c.reservationId),
        causation,
    )
}

// Authoritative check used on every approach tick and at touchdown. A clearance is valid only while
// it is ACTIVE, matches the flight and reservation, its runway is open, and its window has not passed.
export function validateClearance(airport: AirportState, check: ClearanceCheck, simNowSec: number): ClearanceCheckResult {
    const base = { reservationId: check.reservationId, clearanceId: check.clearanceId }
    const c = airport.clearances[check.clearanceId]
    const r = airport.reservations[check.reservationId]
    const now = Math.max(simNowSec, airport.lastAdvancedSimSec)
    if (!c || !r) return { valid: false, reason: "UNKNOWN_CLEARANCE", ...base }
    if (c.flightId !== check.flightId || r.flightId !== check.flightId || c.reservationId !== r.reservationId)
        return { valid: false, reason: "MISMATCH", ...base }
    if (c.status !== "ACTIVE" || r.status !== "CLEARED") return { valid: false, reason: `CLEARANCE_${c.status}`, ...base }
    if (!isRunwayOpen(airport, c.runwayId)) return { valid: false, reason: "CLOSED", ...base }
    if (now > c.windowEndSimSec) return { valid: false, reason: "WINDOW_PASSED", ...base }
    return { valid: true, reason: "OK", ...base }
}

// Final authoritative touchdown. Idempotent per clearance: a repeat returns the stored receipt, even if
// the airport closed afterwards. Rejects outside [slotStart, slotStart+30] or on an occupied runway.
export function recordAirportTouchdown(
    airport: AirportState,
    input: TouchdownInput,
    ctx: NegotiationContext,
): { state: AirportState; receipt: TouchdownReceipt | null; reason: string } {
    const existing = airport.touchdowns[input.clearanceId]
    if (existing) return { state: airport, receipt: existing, reason: "DUPLICATE" }
    const now = airportNow(airport, ctx)
    const check = validateClearance(airport, input, now)
    if (!check.valid) return { state: airport, receipt: null, reason: check.reason }
    const c = airport.clearances[input.clearanceId]!
    const r = airport.reservations[input.reservationId]!
    if (now < c.windowStartSimSec) return { state: airport, receipt: null, reason: "WINDOW_NOT_OPEN" }
    const runway = airport.runways.find(rw => rw.runwayId === c.runwayId)
    if (runway?.occupiedUntilSimSec != null && runway.occupiedUntilSimSec > now) return { state: airport, receipt: null, reason: "RUNWAY_OCCUPIED" }
    const receipt: TouchdownReceipt = {
        receiptId: `td-${c.clearanceId}`,
        runId: airport.runId,
        flightId: input.flightId,
        airportId: airport.airportId,
        runwayId: c.runwayId,
        reservationId: r.reservationId,
        clearanceId: c.clearanceId,
        touchdownAtSimSec: now,
        occupiedUntilSimSec: now + r.occupancySec,
    }
    const state: AirportState = {
        ...airport,
        stateRevision: airport.stateRevision + 1,
        runways: airport.runways.map(rw => (rw.runwayId === c.runwayId ? { ...rw, occupiedUntilSimSec: receipt.occupiedUntilSimSec } : rw)),
        reservations: { ...airport.reservations, [r.reservationId]: { ...r, status: "OCCUPIED" } },
        clearances: { ...airport.clearances, [c.clearanceId]: { ...c, status: "USED" } },
        touchdowns: { ...airport.touchdowns, [c.clearanceId]: receipt },
    }
    return { state, receipt, reason: "OK" }
}

// Housekeeping: lapse expired offers (wall clock) and missed windows (sim clock), free finished occupancy.
// Missed reservations notify their flight so it renegotiates.
export function expireAirportArrangements(airport: AirportState, ctx: NegotiationContext): { airport: AirportState; out: ProtocolEnvelope[] } {
    const now = airportNow(airport, ctx)
    const offers = { ...airport.offers }
    let changed = false
    for (const o of Object.values(offers))
        if (o.status === "OFFERED" && isOfferExpired(o, ctx.wallNowMs) && !isUnsentHold(airport, o)) {
            offers[o.offerId] = { ...o, status: "EXPIRED" }
            changed = true
        }
    const reservations = { ...airport.reservations }
    const clearances = { ...airport.clearances }
    const out: ProtocolEnvelope[] = []
    for (const r of Object.values(reservations)) {
        if ((r.status === "CONFIRMED" || r.status === "CLEARED") && now > r.slotStartSimSec + LANDING_GRACE_SEC) {
            reservations[r.reservationId] = { ...r, status: "EXPIRED" }
            for (const c of Object.values(clearances))
                if (c.reservationId === r.reservationId && c.status === "ACTIVE") clearances[c.clearanceId] = { ...c, status: "EXPIRED" }
            out.push(
                buildEnvelope(
                    airport,
                    ctx,
                    flightEntityId(r.flightId),
                    "RESERVATION_REVOKED",
                    { reservationId: r.reservationId, code: "DEADLINE_EXCEEDED", reason: "Landing window missed", airportOperationalRevision: airport.operationalRevision },
                    r.negotiationId,
                    null,
                ),
            )
            changed = true
        }
        if (r.status === "OCCUPIED") {
            const rw = airport.runways.find(x => x.runwayId === r.runwayId)
            if (!rw || rw.occupiedUntilSimSec === null || rw.occupiedUntilSimSec <= now) {
                reservations[r.reservationId] = { ...r, status: "COMPLETED" }
                changed = true
            }
        }
    }
    const runways = airport.runways.map(rw =>
        rw.occupiedUntilSimSec !== null && rw.occupiedUntilSimSec <= now ? ((changed = true), { ...rw, occupiedUntilSimSec: null }) : rw,
    )
    if (!changed) return { airport, out }
    return { airport: { ...airport, offers, reservations, clearances, runways }, out }
}

// Airport tick (simulated time). Applies each tick ID once.
export function advanceAirport(airport: AirportState, tick: Tick, ctx: NegotiationContext): Transition<AirportState> {
    if (airport.lastTickId === tick.tickId)
        return { state: airport, result: { outcome: "DUPLICATE", code: "OK", stateRevision: airport.stateRevision, original: { outcome: "APPLIED", code: "OK", stateRevision: airport.stateRevision } } }
    const moved: AirportState = {
        ...airport,
        lastTickId: tick.tickId,
        lastAdvancedSimSec: Math.max(airport.lastAdvancedSimSec, tick.toSimSec),
    }
    const { airport: next, out } = expireAirportArrangements(moved, { ...ctx, simNowSec: Math.max(ctx.simNowSec, tick.toSimSec) })
    return done(next, airport, "OK", out, ctx)
}

// Dispatch for the negotiation message types an airport receives. Returns null for other types
// (incident commands, ACKs) so the actor can route them elsewhere.
export function receiveAirportNegotiation(airport: AirportState, msg: InboundMessage, ctx: NegotiationContext): Transition<AirportState> | null {
    switch (msg.type) {
        case "LANDING_REQUEST":
            return handleLandingRequest(airport, msg, ctx)
        case "OFFER_ACCEPT":
            return acceptOffer(airport, msg, ctx)
        case "OFFER_DECLINE":
            return handleOfferDecline(airport, msg, ctx)
        case "RESERVATION_RELEASE":
            return handleReservationRelease(airport, msg, ctx)
        case "RESERVATION_STATUS_REQUEST":
            return handleReservationStatusRequest(airport, msg, ctx)
        case "CLEARANCE_REQUEST":
            return handleClearanceRequest(airport, msg, ctx)
        default:
            return null
    }
}

// ================================================================ FLIGHT SIDE

const airportById = (id: AirportId) => AIRPORTS.find(a => a.airportId === id)!

export function isTerminalFlight(flight: FlightState): boolean {
    return flight.phase === "LANDED" || flight.phase === "UNRESOLVED"
}

export function flightNow(flight: FlightState, ctx: NegotiationContext): number {
    return Math.max(ctx.simNowSec, flight.lastAdvancedSimSec)
}

export function flightFacts(flight: FlightState, ctx: NegotiationContext): FlightFacts {
    return {
        position: flight.position,
        speedKnots: flight.speedKnots,
        fuelRemainingSec: Math.max(0, flight.fuelRemainingSec),
        sampledAtSimSec: flightNow(flight, ctx),
        priority: flight.priority,
        deadlineSimSec: flight.deadlineSimSec,
    }
}

const knownClosed = (flight: FlightState, id: AirportId) => {
    const s = flight.knownAirportStatus[id]
    return !!s && (s.restrictions.arrivalsClosed || s.restrictions.closedRunways.length >= 2)
}

// Airports the flight can physically reach within fuel reserve (and deadline), nearest first.
export function reachableAirports(flight: FlightState, ctx: NegotiationContext): Array<{ airportId: AirportId; distanceNm: number; travelSec: number }> {
    const now = flightNow(flight, ctx)
    return AIRPORTS.map(a => {
        const d = distanceNm(flight.position, a.position)
        return { airportId: a.airportId as AirportId, distanceNm: d, travelSec: travelSeconds(d, flight.speedKnots) }
    })
        .filter(a => a.travelSec <= flight.fuelRemainingSec - FUEL_RESERVE_SEC)
        .filter(a => flight.deadlineSimSec === null || now + a.travelSec <= flight.deadlineSimSec)
        .filter(a => !knownClosed(flight, a.airportId))
        .sort((a, b) => a.distanceNm - b.distanceNm || a.airportId.localeCompare(b.airportId))
}

// Design §6 step 2: normal initial traffic asks its original airport first; emergencies and
// diversions ask every reachable candidate at once, nearest first.
export function planCandidates(flight: FlightState, trigger: string, ctx: NegotiationContext, exclude: readonly AirportId[] = []): AirportId[] {
    const reachable = reachableAirports(flight, ctx).filter(a => !exclude.includes(a.airportId))
    if (flight.priority === "NORMAL" && trigger === "INITIAL") {
        const orig = reachable.find(a => a.airportId === flight.originalDestination)
        if (orig) return [orig.airportId]
    }
    return reachable.slice(0, MAX_EMERGENCY_CANDIDATES).map(a => a.airportId)
}

function pendingReply(airportId: AirportId): NegotiationReply {
    return { airportId, kind: "PENDING", offerId: null, code: null, slotStartSimSec: null, explanation: null }
}

function cancelPilotJobs(jobs: Record<string, Job>): Record<string, Job> {
    const next = { ...jobs }
    for (const j of Object.values(next)) if (j.kind === "PILOT_DECISION" && isOpenJob(j) && j.input.trigger !== "CLEARANCE") next[j.jobId] = { ...j, status: "CANCELLED" }
    return next
}

function requestEnvelopes(flight: FlightState, round: NegotiationRound, ids: readonly AirportId[], ctx: NegotiationContext): ProtocolEnvelope[] {
    const facts = flightFacts(flight, ctx)
    return ids.map(id =>
        buildEnvelope(
            flight,
            ctx,
            `airport:${id}`,
            "LANDING_REQUEST",
            {
                negotiationId: round.roundId,
                flightId: flight.flightId,
                flightDecisionRevision: flight.decisionRevision,
                position: facts.position,
                speedKnots: facts.speedKnots,
                fuelRemainingSec: facts.fuelRemainingSec,
                sampledAtSimSec: facts.sampledAtSimSec,
                priority: facts.priority,
                deadlineSimSec: facts.deadlineSimSec,
            },
            round.roundId,
            null,
        ),
    )
}

function declineEnvelope(flight: FlightState, airportId: AirportId, negotiationId: string, offerId: string, ctx: NegotiationContext, causation: string | null) {
    return buildEnvelope(flight, ctx, `airport:${airportId}`, "OFFER_DECLINE", { negotiationId, offerId }, negotiationId, causation)
}

function releaseEnvelope(flight: FlightState, airportId: AirportId, reservationId: string, ctx: NegotiationContext, causation: string | null) {
    return buildEnvelope(flight, ctx, `airport:${airportId}`, "RESERVATION_RELEASE", { reservationId, flightId: flight.flightId }, roundIdOfReservation(reservationId), causation)
}

// Release obligations survive in the aggregate until the airport ACKs the release message.
function withRelease(flight: FlightState, airportId: AirportId, reservationId: string, ctx: NegotiationContext, causation: string | null): { flight: FlightState; env: ProtocolEnvelope } | null {
    if (flight.releaseObligations.some(o => o.reservationId === reservationId)) return null
    const env = releaseEnvelope(flight, airportId, reservationId, ctx, causation)
    return {
        flight: { ...flight, releaseObligations: [...flight.releaseObligations, { airportId, reservationId, messageId: env.messageId, acknowledged: false }] },
        env,
    }
}

// Mark a release obligation done when the DOMAIN_ACK for its message arrives (durability layer calls this).
export function acknowledgeRelease(flight: FlightState, processedMessageId: string): FlightState {
    if (!flight.releaseObligations.some(o => o.messageId === processedMessageId && !o.acknowledged)) return flight
    return {
        ...flight,
        releaseObligations: flight.releaseObligations.map(o => (o.messageId === processedMessageId ? { ...o, acknowledged: true } : o)),
    }
}

const ACTIVE_STAGES = new Set(["REQUESTING", "COLLECTING", "ACCEPTING"])
const URGENT_TRIGGERS = new Set(["EMERGENCY", "CLOSURE", "REVOKED"])

// Open a negotiation round. At most one active round and one pending acceptance per flight.
// An urgent trigger supersedes a round that is still collecting; otherwise reasons coalesce.
export function openRound(
    flight: FlightState,
    trigger: string,
    ctx: NegotiationContext,
    opts: { exclude?: AirportId[] } = {},
): Transition<FlightState> {
    if (isTerminalFlight(flight)) return reject(flight, "ALREADY_TERMINAL")
    if (flight.pendingAcceptance) return reject(flight, "WRONG_PHASE") // reconcile the uncertain acceptance first
    const out: ProtocolEnvelope[] = []
    const current = flight.negotiation
    if (current && ACTIVE_STAGES.has(current.stage)) {
        if (!URGENT_TRIGGERS.has(trigger) || current.stage === "ACCEPTING" || current.trigger === trigger)
            return done(flight, flight, "OK", [], ctx) // coalesced into the active round
        for (const r of current.replies)
            if (r.kind === "OFFER" && r.offerId) out.push(declineEnvelope(flight, r.airportId, current.roundId, r.offerId, ctx, null))
    }
    const counter = flight.negotiationCounter + 1
    const candidates = planCandidates(flight, trigger, ctx, opts.exclude)
    const round: NegotiationRound = {
        roundId: `${flight.flightId}-N${counter}`,
        trigger: trigger.slice(0, 64),
        candidateAirports: candidates,
        replies: candidates.map(pendingReply),
        collectUntilWallMs: candidates.length === 0 ? ctx.wallNowMs + ctx.timing.noFeasibleRetryMs : null,
        stage: candidates.length === 0 ? "NO_FEASIBLE_AIRPORT" : "REQUESTING",
    }
    let next: FlightState = {
        ...flight,
        negotiation: round,
        negotiationCounter: counter,
        decisionRevision: flight.decisionRevision + 1,
        jobs: cancelPilotJobs(flight.jobs),
    }
    if (round.stage === "NO_FEASIBLE_AIRPORT") return done(next, flight, "NO_FEASIBLE_AIRPORT", out, ctx)
    if (modeOf(ctx) === "JOB") {
        const job = newJob("PILOT_DECISION", next.decisionRevision, trigger, flight.priority, ["REQUEST_LANDING", "HOLD"], [], ctx)
        next = { ...next, jobs: { ...next.jobs, [job.jobId]: job } }
        return done(next, flight, "OK", out, ctx)
    }
    const sent = sendRoundRequests(next, candidates, ctx)
    return done(sent.flight, flight, "OK", [...out, ...sent.out], ctx)
}

function sendRoundRequests(flight: FlightState, ids: readonly AirportId[], ctx: NegotiationContext): { flight: FlightState; out: ProtocolEnvelope[] } {
    const round = flight.negotiation!
    const out = requestEnvelopes(flight, round, ids, ctx)
    return {
        flight: {
            ...flight,
            negotiation: { ...round, stage: "COLLECTING", collectUntilWallMs: ctx.wallNowMs + ctx.timing.replyCollectionWindowMs },
        },
        out,
    }
}

// Offers in the round, judged against the flight's own current facts.
export function offerViews(flight: FlightState, ctx: NegotiationContext): PilotOfferView[] {
    const round = flight.negotiation
    if (!round) return []
    const facts = flightFacts(flight, ctx)
    return round.replies
        .filter(r => r.kind === "OFFER" && r.offerId !== null && r.slotStartSimSec !== null)
        .map(r => {
            const a = airportById(r.airportId)
            const window = arrivalWindow(a.position, facts, facts.sampledAtSimSec, 0)
            return {
                offerId: r.offerId!,
                airportId: r.airportId,
                runwayId: null,
                slotStartSimSec: r.slotStartSimSec!,
                distanceNm: window.distanceNm,
                feasible: slotFeasibility(window, r.slotStartSimSec!, false).ok,
                isOriginalDestination: r.airportId === flight.originalDestination,
            }
        })
}

export function buildPilotView(flight: FlightState, ctx: NegotiationContext): PilotView {
    const round = flight.negotiation
    const now = flightNow(flight, ctx)
    const a = flight.activeAssignment
    let clearanceDue = false
    if (a && !a.clearanceId) {
        const ap = airportById(a.airportId)
        const travel = travelSeconds(distanceNm(flight.position, ap.position), flight.speedKnots)
        clearanceDue = a.slotStartSimSec - now <= travel + 120
    }
    return {
        role: "PILOT",
        flightId: flight.flightId,
        simNowSec: now,
        phase: flight.phase,
        priority: flight.priority,
        deadlineSimSec: flight.deadlineSimSec,
        fuelRemainingSec: flight.fuelRemainingSec,
        speedKnots: flight.speedKnots,
        originalDestination: flight.originalDestination,
        roundId: round?.roundId ?? null,
        stage: round?.stage ?? null,
        requestCandidates: round && round.stage === "REQUESTING" ? [...round.candidateAirports] : [],
        offers: offerViews(flight, ctx),
        refusals: (round?.replies ?? [])
            .filter(r => r.kind === "REFUSED" || r.kind === "TIMEOUT")
            .map(r => ({ airportId: r.airportId, code: r.code ?? r.kind, explanation: r.explanation })),
        activeAssignment: a,
        clearanceDue,
    }
}

// Compact AgentDecisionInput for claimWork. Lease metadata stays with the caller.
export function buildDecisionInput(
    state: FlightState | AirportState,
    job: Job,
    ctx: NegotiationContext,
): AgentDecisionInput | null {
    if ("flightId" in state) {
        return {
            jobId: job.jobId,
            entityId: state.entityId,
            role: "PILOT",
            decisionRevision: job.decisionRevision,
            allowedActions: job.input.allowedActions,
            localState: buildPilotView(state, ctx) as unknown as Record<string, unknown>,
            relevantMessages: [],
        }
    }
    const view = buildAtcView(state, job, ctx)
    if (!view) return null
    return {
        jobId: job.jobId,
        entityId: state.entityId,
        role: "ATC",
        decisionRevision: job.decisionRevision,
        allowedActions: job.input.allowedActions,
        localState: view as unknown as Record<string, unknown>,
        relevantMessages: [],
    }
}

// Design §6 step 5: decide once every candidate answered, or once no unanswered candidate could
// outrank the best offer, or at the collection deadline (unanswered become TIMEOUT).
function collectionDecidable(flight: FlightState, ctx: NegotiationContext): boolean {
    const round = flight.negotiation!
    if (round.replies.every(r => r.kind !== "PENDING")) return true
    if (round.collectUntilWallMs !== null && ctx.wallNowMs >= round.collectUntilWallMs) return true
    const best = rankOffers(offerViews(flight, ctx), flight.priority)[0]
    if (!best) return false
    const pending = round.replies.filter(r => r.kind === "PENDING")
    if (flight.priority === "EMERGENCY") {
        return pending.every(p => distanceNm(flight.position, airportById(p.airportId).position) > best.distanceNm)
    }
    return best.isOriginalDestination
}

function completeCollection(flight: FlightState, ctx: NegotiationContext): { flight: FlightState; out: ProtocolEnvelope[]; code: string } {
    let round = flight.negotiation!
    if (round.collectUntilWallMs !== null && ctx.wallNowMs >= round.collectUntilWallMs)
        round = { ...round, replies: round.replies.map(r => (r.kind === "PENDING" ? { ...r, kind: "TIMEOUT" as const, code: "TIMEOUT" as const } : r)) }
    let next: FlightState = { ...flight, negotiation: round }
    const ranked = rankOffers(offerViews(next, ctx), next.priority)
    if (ranked.length === 0) {
        if (round.replies.some(r => r.kind === "PENDING")) return { flight: next, out: [], code: "OK" }
        // Initial normal round only asked the original airport: ask the others now.
        const asked = round.candidateAirports
        const others = planCandidates(next, "REFUSED", ctx, asked)
        const out: ProtocolEnvelope[] = []
        for (const r of round.replies)
            if (r.kind === "OFFER" && r.offerId) out.push(declineEnvelope(next, r.airportId, round.roundId, r.offerId, ctx, null))
        if (others.length > 0) {
            next = { ...next, negotiation: { ...round, stage: "NO_FEASIBLE_AIRPORT", collectUntilWallMs: ctx.wallNowMs } }
            const opened = openRound(next, "REFUSED", ctx, { exclude: [...asked] })
            const added = opened.state.outbox.slice(next.outbox.length).map(e => e.envelope)
            return { flight: { ...opened.state, outbox: next.outbox, stateRevision: next.stateRevision }, out: [...out, ...added], code: "OK" }
        }
        next = {
            ...next,
            negotiation: { ...round, stage: "NO_FEASIBLE_AIRPORT", collectUntilWallMs: ctx.wallNowMs + ctx.timing.noFeasibleRetryMs },
            decisionRevision: next.decisionRevision + 1,
        }
        return { flight: next, out, code: "NO_FEASIBLE_AIRPORT" }
    }
    // Close collection: a later reply in this round is declined, never chosen.
    next = { ...next, negotiation: { ...round, collectUntilWallMs: null }, decisionRevision: next.decisionRevision + 1 }
    if (modeOf(ctx) === "JOB") {
        const job = newJob("PILOT_DECISION", next.decisionRevision, "SELECT_OFFER", next.priority, ["SELECT_OFFER", "HOLD"], [], ctx)
        return { flight: { ...next, jobs: { ...cancelPilotJobs(next.jobs), [job.jobId]: job } }, out: [], code: "OK" }
    }
    return sendAcceptance(next, ranked[0]!, ctx)
}

function sendAcceptance(flight: FlightState, choice: PilotOfferView, ctx: NegotiationContext): { flight: FlightState; out: ProtocolEnvelope[]; code: string } {
    const round = flight.negotiation!
    const env = buildEnvelope(
        flight,
        ctx,
        `airport:${choice.airportId}`,
        "OFFER_ACCEPT",
        { negotiationId: round.roundId, offerId: choice.offerId, flightDecisionRevision: flight.decisionRevision, facts: flightFacts(flight, ctx) },
        round.roundId,
        null,
    )
    return {
        flight: {
            ...flight,
            negotiation: { ...round, stage: "ACCEPTING", collectUntilWallMs: null },
            pendingAcceptance: {
                negotiationId: round.roundId,
                offerId: choice.offerId,
                airportId: choice.airportId,
                messageId: env.messageId,
                sentAtWallMs: ctx.wallNowMs,
                statusRequestedAtWallMs: null,
            },
        },
        out: [env],
        code: "OK",
    }
}

function setReply(flight: FlightState, reply: NegotiationReply): FlightState {
    const round = flight.negotiation!
    return { ...flight, negotiation: { ...round, replies: round.replies.map(r => (r.airportId === reply.airportId ? reply : r)) } }
}

// Adopt a confirmed reservation as the single active assignment, after local revalidation.
// The previous reservation and unused offers become cleanup obligations in the same transition.
function adoptConfirmation(
    flight: FlightState,
    airportId: AirportId,
    c: { negotiationId: string; offerId: string; reservationId: string; runwayId: Assignment["runwayId"]; slotStartSimSec: number; occupancySec: number },
    ctx: NegotiationContext,
    causation: string,
): Transition<FlightState> {
    let next: FlightState = flight
    const out: ProtocolEnvelope[] = []
    const ap = airportById(airportId)
    const window = arrivalWindow(ap.position, flightFacts(flight, ctx), flightNow(flight, ctx), 0)
    const feasible = slotFeasibility(window, c.slotStartSimSec, false)
    next = { ...next, pendingAcceptance: null }
    if (!feasible.ok) {
        // Confirmed but no longer achievable from here: release it and renegotiate. Never land it.
        const rel = withRelease(next, airportId, c.reservationId, ctx, causation)
        if (rel) {
            next = rel.flight
            out.push(rel.env)
        }
        next = { ...next, negotiation: next.negotiation ? { ...next.negotiation, stage: "NO_FEASIBLE_AIRPORT", collectUntilWallMs: ctx.wallNowMs } : null }
        const reopened = openRound(next, "INFEASIBLE_CONFIRMATION", ctx, { exclude: [] })
        const added = reopened.state.outbox.slice(next.outbox.length).map(e => e.envelope)
        return done({ ...reopened.state, outbox: next.outbox }, flight, feasible.code, [...out, ...added], ctx)
    }
    const prev = flight.activeAssignment
    if (prev && prev.reservationId !== c.reservationId) {
        const rel = withRelease(next, prev.airportId, prev.reservationId, ctx, causation)
        if (rel) {
            next = rel.flight
            out.push(rel.env)
        }
    }
    const round = next.negotiation
    if (round && round.roundId === c.negotiationId) {
        for (const r of round.replies)
            if (r.kind === "OFFER" && r.offerId && r.offerId !== c.offerId) out.push(declineEnvelope(next, r.airportId, round.roundId, r.offerId, ctx, causation))
        next = { ...next, negotiation: { ...round, stage: "CONFIRMED", collectUntilWallMs: null } }
    }
    next = {
        ...next,
        activeAssignment: {
            airportId,
            runwayId: c.runwayId,
            reservationId: c.reservationId,
            slotStartSimSec: c.slotStartSimSec,
            occupancySec: c.occupancySec,
            clearanceId: null,
        },
        decisionRevision: next.decisionRevision + 1,
        jobs: cancelPilotJobs(next.jobs),
    }
    return done(next, flight, "OK", out, ctx)
}

function failAcceptance(flight: FlightState, ctx: NegotiationContext, airportId: AirportId, code: DomainCode, explanation: string | null): Transition<FlightState> {
    const pending = flight.pendingAcceptance!
    let next: FlightState = { ...flight, pendingAcceptance: null }
    const round = next.negotiation
    if (round && round.roundId === pending.negotiationId) {
        next = setReply(next, { airportId, kind: "REFUSED", offerId: pending.offerId, code, slotStartSimSec: null, explanation })
        // Try the next best offer still standing in this round before opening a new one.
        const remaining = rankOffers(offerViews(next, ctx), next.priority)
        if (remaining.length > 0) {
            const s = sendAcceptance(next, remaining[0]!, ctx)
            return done(s.flight, flight, code, s.out, ctx)
        }
        next = { ...next, negotiation: { ...next.negotiation!, stage: "NO_FEASIBLE_AIRPORT", collectUntilWallMs: ctx.wallNowMs } }
    }
    if (next.activeAssignment) return done(next, flight, code, [], ctx) // keep the confirmed route we already hold
    const reopened = openRound(next, "ACCEPT_FAILED", ctx, { exclude: [] })
    const added = reopened.state.outbox.slice(next.outbox.length).map(e => e.envelope)
    return done({ ...reopened.state, outbox: next.outbox }, flight, code, added, ctx)
}

// All negotiation messages a flight receives (design §6 steps 3 to 10).
export function advanceNegotiation(flight: FlightState, msg: InboundMessage, ctx: NegotiationContext): Transition<FlightState> {
    const fromAirport = airportIdOf(msg.fromEntityId)
    if (!fromAirport) return reject(flight, "UNAUTHORIZED")
    const terminal = isTerminalFlight(flight)
    switch (msg.type) {
        case "LANDING_OFFER": {
            const p = msg.payload
            if (p.airportId !== fromAirport) return reject(flight, "UNAUTHORIZED")
            const round = flight.negotiation
            const reply = round?.replies.find(r => r.airportId === fromAirport)
            const live =
                !terminal &&
                round &&
                round.roundId === p.negotiationId &&
                round.stage === "COLLECTING" &&
                round.collectUntilWallMs !== null &&
                reply?.kind === "PENDING"
            if (!live) {
                if (reply?.kind === "OFFER" && reply.offerId === p.offerId && round?.roundId === p.negotiationId) return done(flight, flight, "OK", [], ctx) // duplicate
                // Stale round, late reply, or terminal flight: free the airport's hold.
                return done(flight, flight, terminal ? "ALREADY_TERMINAL" : "STALE_STATE", [declineEnvelope(flight, fromAirport, p.negotiationId, p.offerId, ctx, msg.messageId)], ctx)
            }
            let next = setReply(flight, { airportId: fromAirport, kind: "OFFER", offerId: p.offerId, code: null, slotStartSimSec: p.slotStartSimSec, explanation: null })
            if (!collectionDecidable(next, ctx)) return done(next, flight, "OK", [], ctx)
            const c = completeCollection(next, ctx)
            return done(c.flight, flight, "OK", c.out, ctx)
        }
        case "LANDING_REFUSED": {
            const p = msg.payload
            if (p.airportId !== fromAirport) return reject(flight, "UNAUTHORIZED")
            if (terminal) return done(flight, flight, "ALREADY_TERMINAL", [], ctx)
            const pend = flight.pendingAcceptance
            if (pend && pend.negotiationId === p.negotiationId && pend.airportId === fromAirport)
                return failAcceptance(flight, ctx, fromAirport, p.code, p.explanation)
            const round = flight.negotiation
            const reply = round?.replies.find(r => r.airportId === fromAirport)
            if (!round || round.roundId !== p.negotiationId || !reply) return done(flight, flight, "STALE_STATE", [], ctx)
            // A withdrawn offer (emergency preemption, closure) or a plain refusal.
            const next = setReply(flight, { airportId: fromAirport, kind: "REFUSED", offerId: reply.offerId, code: p.code, slotStartSimSec: null, explanation: p.explanation })
            if (round.stage !== "COLLECTING" || round.collectUntilWallMs === null) {
                if (round.stage === "COLLECTING") {
                    // Selection pending (JOB mode): re-evaluate with the remaining offers.
                    const c = completeCollection({ ...next, negotiation: { ...next.negotiation!, collectUntilWallMs: ctx.wallNowMs + 1 } }, ctx)
                    return done(c.flight, flight, "OK", c.out, ctx)
                }
                return done(next, flight, "OK", [], ctx)
            }
            if (!collectionDecidable(next, ctx)) return done(next, flight, "OK", [], ctx)
            const c = completeCollection(next, ctx)
            return done(c.flight, flight, "OK", c.out, ctx)
        }
        case "LANDING_CONFIRMED": {
            const p = msg.payload
            if (flight.activeAssignment?.reservationId === p.reservationId) return done(flight, flight, "OK", [], ctx) // duplicate
            const pend = flight.pendingAcceptance
            if (!terminal && pend && pend.offerId === p.offerId && pend.airportId === fromAirport)
                return adoptConfirmation(flight, fromAirport, p, ctx, msg.messageId)
            // Late or stale confirmation: schedule its release; never overwrite the current assignment.
            const rel = withRelease(flight, fromAirport, p.reservationId, ctx, msg.messageId)
            return done(rel ? rel.flight : flight, flight, terminal ? "ALREADY_TERMINAL" : "STALE_STATE", rel ? [rel.env] : [], ctx)
        }
        case "RESERVATION_STATUS": {
            const p = msg.payload
            const pend = flight.pendingAcceptance
            const matches = pend && pend.offerId === p.offerId && pend.airportId === fromAirport
            if (!matches || terminal) {
                if (p.reservation && (p.status === "CONFIRMED" || p.status === "CLEARED") && flight.activeAssignment?.reservationId !== p.reservation.reservationId) {
                    const rel = withRelease(flight, fromAirport, p.reservation.reservationId, ctx, msg.messageId)
                    return done(rel ? rel.flight : flight, flight, "STALE_STATE", rel ? [rel.env] : [], ctx)
                }
                return done(flight, flight, "STALE_STATE", [], ctx)
            }
            if ((p.status === "CONFIRMED" || p.status === "CLEARED") && p.reservation) {
                // Lost confirmation: adopt the same reservation the airport already holds for us.
                return adoptConfirmation(flight, fromAirport, { negotiationId: p.negotiationId, offerId: p.offerId, ...p.reservation }, ctx, msg.messageId)
            }
            if (p.status === "OFFERED") return done(flight, flight, "OK", [], ctx) // acceptance still in flight; ask again later
            return failAcceptance(flight, ctx, fromAirport, p.status === "EXPIRED" ? "OFFER_EXPIRED" : "STALE_STATE", `Reservation status ${p.status}`)
        }
        case "RESERVATION_REVOKED": {
            const p = msg.payload
            const obligations = flight.releaseObligations.some(o => o.reservationId === p.reservationId)
            if (flight.activeAssignment?.reservationId !== p.reservationId || flight.activeAssignment.airportId !== fromAirport)
                return done(flight, flight, obligations ? "OK" : "STALE_STATE", [], ctx)
            const next: FlightState = { ...flight, activeAssignment: null, decisionRevision: flight.decisionRevision + 1 }
            if (terminal) return done(next, flight, "ALREADY_TERMINAL", [], ctx)
            if (next.pendingAcceptance) return done(next, flight, "OK", [], ctx)
            const reopened = openRound(next, "REVOKED", ctx)
            return done({ ...reopened.state, stateRevision: flight.stateRevision }, flight, "OK", [], ctx)
        }
        case "CLEARANCE_GRANTED": {
            const p = msg.payload
            const a = flight.activeAssignment
            if (!a || a.reservationId !== p.reservationId || a.airportId !== fromAirport || terminal) return done(flight, flight, "STALE_STATE", [], ctx)
            if (a.clearanceId === p.clearanceId) return done(flight, flight, "OK", [], ctx)
            return done({ ...flight, activeAssignment: { ...a, clearanceId: p.clearanceId } }, flight, "OK", [], ctx)
        }
        case "CLEARANCE_REFUSED": {
            const p = msg.payload
            const a = flight.activeAssignment
            if (!a || a.reservationId !== p.reservationId || a.airportId !== fromAirport || terminal) return done(flight, flight, "STALE_STATE", [], ctx)
            let next: FlightState = { ...flight, activeAssignment: null, decisionRevision: flight.decisionRevision + 1 }
            const out: ProtocolEnvelope[] = []
            const rel = withRelease(next, a.airportId, a.reservationId, ctx, msg.messageId)
            if (rel) {
                next = rel.flight
                out.push(rel.env)
            }
            const reopened = openRound(next, "CLEARANCE_REFUSED", ctx)
            const added = reopened.state.outbox.slice(next.outbox.length).map(e => e.envelope)
            return done({ ...reopened.state, outbox: next.outbox }, flight, p.code, [...out, ...added], ctx)
        }
        case "AIRPORT_STATUS": {
            const p = msg.payload
            if (p.airportId !== fromAirport) return reject(flight, "UNAUTHORIZED")
            const known = flight.knownAirportStatus[p.airportId]
            if (known && known.statusRevision >= p.statusRevision) return done(flight, flight, "STALE_STATE", [], ctx)
            const next: FlightState = { ...flight, knownAirportStatus: { ...flight.knownAirportStatus, [p.airportId]: p } }
            // A material change retries a flight that had no feasible airport.
            if (!terminal && next.negotiation?.stage === "NO_FEASIBLE_AIRPORT" && !next.activeAssignment && !p.restrictions.arrivalsClosed) {
                const reopened = openRound(next, "STATUS_CHANGE", ctx)
                return done({ ...reopened.state, stateRevision: flight.stateRevision }, flight, "OK", [], ctx)
            }
            return done(next, flight, "OK", [], ctx)
        }
        default:
            return reject(flight, "INVALID_PAYLOAD")
    }
}

// Wall-clock timers (call from the actor alarm or the worker loop): collection deadline,
// acceptance timeout (status reconciliation), and no-feasible retry.
export function flightWallTimers(flight: FlightState, ctx: NegotiationContext): Transition<FlightState> {
    if (isTerminalFlight(flight)) return done(flight, flight, "OK", [], ctx)
    const pend = flight.pendingAcceptance
    if (pend) {
        const since = pend.statusRequestedAtWallMs ?? pend.sentAtWallMs
        if (ctx.wallNowMs - since < ctx.timing.offerAcceptTimeoutMs) return { state: flight, result: { outcome: "APPLIED", code: "OK", stateRevision: flight.stateRevision } }
        // Uncertain outcome: ask the same airport about the same IDs. Never accept elsewhere meanwhile.
        const env = buildEnvelope(
            flight,
            ctx,
            `airport:${pend.airportId}`,
            "RESERVATION_STATUS_REQUEST",
            { negotiationId: pend.negotiationId, offerId: pend.offerId, reservationId: reservationIdFor(pend.offerId) },
            pend.negotiationId,
            pend.messageId,
        )
        return done({ ...flight, pendingAcceptance: { ...pend, statusRequestedAtWallMs: ctx.wallNowMs } }, flight, "OK", [env], ctx)
    }
    const round = flight.negotiation
    if (!round) return { state: flight, result: { outcome: "APPLIED", code: "OK", stateRevision: flight.stateRevision } }
    if (round.stage === "COLLECTING" && round.collectUntilWallMs !== null && ctx.wallNowMs >= round.collectUntilWallMs) {
        const c = completeCollection(flight, ctx)
        return done(c.flight, flight, c.code, c.out, ctx)
    }
    if (round.stage === "NO_FEASIBLE_AIRPORT" && !flight.activeAssignment && round.collectUntilWallMs !== null && ctx.wallNowMs >= round.collectUntilWallMs)
        return openRound(flight, "RETRY", ctx)
    return { state: flight, result: { outcome: "APPLIED", code: "OK", stateRevision: flight.stateRevision } }
}

// Next wall time a timer matters, so the actor can arm one alarm. null = nothing pending.
export function nextFlightWallDeadline(flight: FlightState, timing: NegotiationTiming): number | null {
    if (isTerminalFlight(flight)) return null
    const pend = flight.pendingAcceptance
    if (pend) return (pend.statusRequestedAtWallMs ?? pend.sentAtWallMs) + timing.offerAcceptTimeoutMs
    const round = flight.negotiation
    if (!round || round.collectUntilWallMs === null) return null
    if (round.stage === "COLLECTING" || (round.stage === "NO_FEASIBLE_AIRPORT" && !flight.activeAssignment)) return round.collectUntilWallMs
    return null
}

// Apply a pilot proposal (model or rules). Hard rules win: requests go to the rule-computed
// candidates; a selection must be the mandated best offer; HOLD is accepted only when nothing
// feasible exists. A rule override is recorded as RULES_FALLBACK.
export function commitPilotDecision(
    flight: FlightState,
    jobId: string,
    decision: PilotDecision,
    source: DecisionSource,
    ctx: NegotiationContext,
): Transition<FlightState> & { appliedSource: DecisionSource } {
    const job = flight.jobs[jobId]
    if (!job || job.kind !== "PILOT_DECISION" || !isOpenJob(job)) return { ...reject(flight, "STALE_STATE"), appliedSource: source }
    if (job.decisionRevision !== flight.decisionRevision) {
        const cancelled = { ...flight, jobs: { ...flight.jobs, [jobId]: { ...job, status: "CANCELLED" as const } } }
        return { state: cancelled, result: { outcome: "REJECTED", code: "STALE_STATE", stateRevision: flight.stateRevision }, appliedSource: source }
    }
    if (isTerminalFlight(flight)) return { ...reject(flight, "ALREADY_TERMINAL"), appliedSource: source }
    const view = buildPilotView(flight, ctx)
    const rules = choosePilotAction(view, job.input.allowedActions)
    let applied: PilotDecision = decision
    let appliedSource = source
    const valid = (() => {
        if (!job.input.allowedActions.includes(decision.type)) return false
        switch (decision.type) {
            case "REQUEST_LANDING":
                return (
                    view.stage === "REQUESTING" &&
                    decision.airportIds.length === view.requestCandidates.length &&
                    view.requestCandidates.every(id => decision.airportIds.includes(id))
                )
            case "SELECT_OFFER":
                return rules.type === "SELECT_OFFER" && rules.offerId === decision.offerId && rules.airportId === decision.airportId
            case "HOLD":
                return rules.type === "HOLD"
            case "REQUEST_CLEARANCE":
                return rules.type === "REQUEST_CLEARANCE" && rules.reservationId === decision.reservationId
        }
    })()
    if (!valid) {
        applied = rules
        appliedSource = "RULES_FALLBACK"
    }
    let next: FlightState = flight
    let out: ProtocolEnvelope[] = []
    if (applied.type === "REQUEST_LANDING") {
        const s = sendRoundRequests(next, view.requestCandidates, ctx)
        next = s.flight
        out = s.out
    } else if (applied.type === "SELECT_OFFER") {
        const choice = view.offers.find(o => o.offerId === applied.offerId)!
        const s = sendAcceptance(next, choice, ctx)
        next = s.flight
        out = s.out
    } else if (applied.type === "REQUEST_CLEARANCE") {
        const s = requestClearance(next, ctx)
        next = s.state
        out = s.state.outbox.slice(flight.outbox.length).map(e => e.envelope)
        next = { ...next, outbox: flight.outbox, stateRevision: flight.stateRevision }
    }
    next = { ...next, jobs: { ...next.jobs, [jobId]: commitJob(job, appliedSource, applied.type, applied.reason, ctx) } }
    return { ...done(next, flight, "OK", out, ctx), appliedSource }
}

// Ask the assigned airport for final clearance (Task 8 calls this, or queues a CLEARANCE job).
export function requestClearance(flight: FlightState, ctx: NegotiationContext): Transition<FlightState> {
    const a = flight.activeAssignment
    if (isTerminalFlight(flight)) return reject(flight, "ALREADY_TERMINAL")
    if (!a || a.clearanceId) return reject(flight, "WRONG_PHASE")
    const env = buildEnvelope(
        flight,
        ctx,
        `airport:${a.airportId}`,
        "CLEARANCE_REQUEST",
        { reservationId: a.reservationId, facts: flightFacts(flight, ctx) },
        roundIdOfReservation(a.reservationId),
        null,
    )
    return done(flight, flight, "OK", [env], ctx)
}

// Terminal flight (landed elsewhere or unresolved): release every offer and reservation it still holds.
export function releaseAllForTerminal(flight: FlightState, ctx: NegotiationContext): Transition<FlightState> {
    let next: FlightState = flight
    const out: ProtocolEnvelope[] = []
    const round = flight.negotiation
    if (round)
        for (const r of round.replies)
            if (r.kind === "OFFER" && r.offerId) out.push(declineEnvelope(flight, r.airportId, round.roundId, r.offerId, ctx, null))
    const a = flight.activeAssignment
    if (a && flight.phase !== "LANDED") {
        const rel = withRelease(next, a.airportId, a.reservationId, ctx, null)
        if (rel) {
            next = rel.flight
            out.push(rel.env)
        }
    }
    next = {
        ...next,
        pendingAcceptance: null,
        negotiation: round && ACTIVE_STAGES.has(round.stage) ? { ...round, stage: "NO_FEASIBLE_AIRPORT", collectUntilWallMs: null } : round,
        jobs: cancelPilotJobs(next.jobs),
    }
    return done(next, flight, "OK", out, ctx)
}

// Exported for policy/agent wiring.
export type { AgentDecision }
