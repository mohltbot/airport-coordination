// Deterministic valid-action policy (design §6, §7). This is the RULES_FALLBACK the agent runner
// uses when the model times out, returns malformed output, or proposes something the rules forbid.
// It reads only the compact decision views built by negotiation.ts (buildPilotView / buildAtcView),
// never the raw aggregate.
import type {
    AgentActionType,
    AgentDecision,
    AgentDecisionInput,
    AirportId,
    Assignment,
    AtcDecision,
    DomainCode,
    NegotiationStage,
    PilotDecision,
    Priority,
    RunwayId,
} from "./contracts.js"

export type PilotOfferView = {
    offerId: string
    airportId: AirportId
    runwayId: RunwayId | null
    slotStartSimSec: number
    distanceNm: number
    // Still achievable from the flight's own facts (fuel reserve, deadline, physical reach).
    feasible: boolean
    isOriginalDestination: boolean
}

export type PilotView = {
    role: "PILOT"
    flightId: string
    simNowSec: number
    phase: string
    priority: Priority
    deadlineSimSec: number | null
    fuelRemainingSec: number
    speedKnots: number
    originalDestination: AirportId
    roundId: string | null
    stage: NegotiationStage | null
    // Airports the rules require this round to ask (REQUESTING stage).
    requestCandidates: AirportId[]
    // SEQUENTIAL emergency round: candidates still to ask, nearest first, after the current one refuses.
    sequentialQueue?: AirportId[]
    offers: PilotOfferView[]
    refusals: Array<{ airportId: AirportId; code: string; explanation: string | null }>
    activeAssignment: Assignment | null
    clearanceDue: boolean
}

export type AtcView = {
    role: "ATC"
    airportId: AirportId
    simNowSec: number
    arrivalsClosed: boolean
    closedRunways: RunwayId[]
    occupancySec: number
    request: { negotiationId: string; flightId: string; priority: Priority; deadlineSimSec: number | null }
    // The exclusive tentative hold actor code already placed: earliest feasible slot, then runway ID.
    held: { offerId: string; runwayId: RunwayId; slotStartSimSec: number } | null
    queue: Array<{ flightId: string; runwayId: RunwayId; slotStartSimSec: number; priority: Priority; status: string }>
}

export type DecisionView = PilotView | AtcView

const clip = (s: string) => (s.length > 240 ? `${s.slice(0, 237)}...` : s)

// Mandated ranking (design §6). Emergency: closest feasible, then earlier touchdown, then airport ID.
// Normal: original destination while feasible, then earliest touchdown, then distance, then airport ID.
export function rankOffers(offers: readonly PilotOfferView[], priority: Priority): PilotOfferView[] {
    const feasible = offers.filter(o => o.feasible)
    return [...feasible].sort((a, b) => {
        if (priority === "EMERGENCY") {
            return a.distanceNm - b.distanceNm || a.slotStartSimSec - b.slotStartSimSec || a.airportId.localeCompare(b.airportId)
        }
        if (a.isOriginalDestination !== b.isOriginalDestination) return a.isOriginalDestination ? -1 : 1
        return a.slotStartSimSec - b.slotStartSimSec || a.distanceNm - b.distanceNm || a.airportId.localeCompare(b.airportId)
    })
}

export function bestOffer(view: PilotView): PilotOfferView | null {
    return rankOffers(view.offers, view.priority)[0] ?? null
}

// ---------------------------------------------------------------- pilot

export function choosePilotRequest(view: PilotView): PilotDecision | null {
    if (view.stage !== "REQUESTING" || view.requestCandidates.length === 0) return null
    const why =
        view.priority === "EMERGENCY" && view.sequentialQueue
            ? `Emergency: asking the nearest airport ${view.requestCandidates.join(", ")} first${view.sequentialQueue.length ? `; then ${view.sequentialQueue.join(", ")} one at a time if refused` : ""}`
            : view.priority === "EMERGENCY"
            ? `Emergency: asking every reachable airport, nearest first (${view.requestCandidates.join(", ")})`
            : view.requestCandidates.length === 1 && view.requestCandidates[0] === view.originalDestination
              ? `Requesting a slot at original destination ${view.originalDestination}`
              : `Requesting alternatives ${view.requestCandidates.join(", ")}`
    return { type: "REQUEST_LANDING", airportIds: [...view.requestCandidates], reason: clip(why) }
}

export function choosePilotSelection(view: PilotView): PilotDecision | null {
    const best = bestOffer(view)
    if (!best) return null
    const why =
        view.priority === "EMERGENCY"
            ? `Closest feasible offer: ${best.airportId} ${best.runwayId ?? ""} at T+${Math.round(best.slotStartSimSec - view.simNowSec)} s, ${best.distanceNm.toFixed(1)} NM`
            : best.isOriginalDestination
              ? `Original destination ${best.airportId} offered a feasible slot`
              : `Earliest feasible touchdown: ${best.airportId} at T+${Math.round(best.slotStartSimSec - view.simNowSec)} s`
    return { type: "SELECT_OFFER", offerId: best.offerId, airportId: best.airportId, reason: clip(why.replace(/\s+/g, " ")) }
}

export function choosePilotClearance(view: PilotView): PilotDecision | null {
    if (!view.clearanceDue || !view.activeAssignment || view.activeAssignment.clearanceId) return null
    return {
        type: "REQUEST_CLEARANCE",
        reservationId: view.activeAssignment.reservationId,
        reason: `Within approach range of ${view.activeAssignment.airportId}; requesting final clearance`,
    }
}

export function choosePilotAction(view: PilotView, allowed: readonly AgentActionType[]): PilotDecision {
    const tries: Array<[AgentActionType, () => PilotDecision | null]> = [
        ["REQUEST_LANDING", () => choosePilotRequest(view)],
        ["SELECT_OFFER", () => choosePilotSelection(view)],
        ["REQUEST_CLEARANCE", () => choosePilotClearance(view)],
    ]
    for (const [action, pick] of tries) {
        if (!allowed.includes(action)) continue
        const d = pick()
        if (d) return d
    }
    const why =
        view.stage === "NO_FEASIBLE_AIRPORT"
            ? "No feasible airport; holding and retrying"
            : view.offers.length > 0
              ? "No offer is feasible against fuel or deadline; holding"
              : "Holding until replies arrive"
    return { type: "HOLD", reason: why }
}

// ---------------------------------------------------------------- ATC

const REFUSAL_CODES: readonly DomainCode[] = ["CLOSED", "NO_CAPACITY", "UNREACHABLE", "DEADLINE_EXCEEDED"]

export function isRefusalCode(code: string): code is DomainCode {
    return (REFUSAL_CODES as readonly string[]).includes(code)
}

export function chooseAtcAction(view: AtcView, allowed: readonly AgentActionType[]): AtcDecision {
    const { request, held } = view
    if (held && allowed.includes("PROPOSE_OFFER")) {
        const why =
            request.priority === "EMERGENCY"
                ? `Emergency ${request.flightId}: earliest runway time ${held.runwayId} at T+${Math.round(held.slotStartSimSec - view.simNowSec)} s`
                : `Earliest free slot ${held.runwayId} at T+${Math.round(held.slotStartSimSec - view.simNowSec)} s`
        return {
            type: "PROPOSE_OFFER",
            negotiationId: request.negotiationId,
            flightId: request.flightId,
            runwayId: held.runwayId,
            slotStartSimSec: held.slotStartSimSec,
            reason: clip(why),
        }
    }
    const code: DomainCode = view.arrivalsClosed ? "CLOSED" : "NO_CAPACITY"
    return {
        type: "REFUSE",
        negotiationId: request.negotiationId,
        flightId: request.flightId,
        code,
        reason: code === "CLOSED" ? `${view.airportId} is closed to arrivals` : "No free runway slot",
    }
}

// ---------------------------------------------------------------- runner entry point

// The one function the agent runner calls on fallback. Input is exactly what the model saw.
export function chooseValidAction(input: AgentDecisionInput): AgentDecision {
    const view = input.localState as unknown as DecisionView
    if (input.role === "ATC") {
        if (view.role !== "ATC") throw new Error("ATC job without an ATC view")
        return chooseAtcAction(view, input.allowedActions)
    }
    if (view.role !== "PILOT") throw new Error("Pilot job without a pilot view")
    return choosePilotAction(view, input.allowedActions)
}
