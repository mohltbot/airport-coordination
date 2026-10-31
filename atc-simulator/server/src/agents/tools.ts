// Permitted proposal-to-domain mapping (design §7, plan Task 6).
// A model output is a proposal. This module parses it, checks it against the job's allowed
// actions and the facts the agent was shown, and formats fallback reasons. Actor commit code
// stays the authority: it rechecks capacity, ranking, feasibility and revisions.
import {
    AtcDecisionSchema,
    PilotDecisionSchema,
    type AgentActionType,
    type AgentDecision,
    type AgentDecisionInput,
    type DomainCode,
} from "@ghost-tower/domain/contracts"
import { AIRPORT_IDS, MAX_REASON_CHARS, SLOT_GRID_SEC } from "@ghost-tower/domain/constants"

export const PILOT_ACTIONS = ["REQUEST_LANDING", "SELECT_OFFER", "HOLD", "REQUEST_CLEARANCE"] as const satisfies readonly AgentActionType[]
export const ATC_ACTIONS = ["PROPOSE_OFFER", "REFUSE"] as const satisfies readonly AgentActionType[]
// Refusal codes an ATC agent may choose. OK and transport/lease codes are not refusals.
export const ATC_REFUSAL_CODES = ["CLOSED", "NO_CAPACITY", "UNREACHABLE", "DEADLINE_EXCEEDED"] as const satisfies readonly DomainCode[]

export type FallbackCode =
    | "RULES_MODE" // AGENT_MODE=rules: no model call was made
    | "TIMEOUT" // model did not answer inside MODEL_TIMEOUT_MS
    | "INVALID_OUTPUT" // not JSON, wrong schema, refusal, or truncated
    | "MODEL_ERROR" // network/API error
    | "RULE_VIOLATION" // parsed, but breaks the allowed actions or the facts shown
    | "INPUT_TOO_LARGE" // required facts exceed MAX_DECISION_INPUT_BYTES; model not called
    | "COMMIT_REJECTED" // actor rejected the model proposal on a domain rule

export class ModelOutputError extends Error {
    constructor(
        readonly code: "INVALID_OUTPUT",
        message: string,
    ) {
        super(message)
        this.name = "ModelOutputError"
    }
}

export function actionsForRole(role: AgentDecisionInput["role"]): readonly AgentActionType[] {
    return role === "PILOT" ? PILOT_ACTIONS : ATC_ACTIONS
}

// Allowed actions for this job, limited to the role's vocabulary.
export function permittedActions(input: Pick<AgentDecisionInput, "role" | "allowedActions">): AgentActionType[] {
    const roleActions = actionsForRole(input.role)
    return input.allowedActions.filter(a => roleActions.includes(a))
}

export function clampReason(reason: string): string {
    const flat = reason.replace(/\s+/g, " ").trim()
    return flat.length <= MAX_REASON_CHARS ? flat : `${flat.slice(0, MAX_REASON_CHARS - 1)}…`
}

// Parse the raw structured-output text: {"decision": {...}}. Throws ModelOutputError.
export function parseModelOutput(input: Pick<AgentDecisionInput, "role">, text: string): AgentDecision {
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch {
        throw new ModelOutputError("INVALID_OUTPUT", "model output is not JSON")
    }
    const decision = raw && typeof raw === "object" && "decision" in raw ? (raw as { decision: unknown }).decision : raw
    return validateDecisionShape(input, decision)
}

// Schema check for any adapter's output, including fakes and the rules policy.
export function validateDecisionShape(input: Pick<AgentDecisionInput, "role">, decision: unknown): AgentDecision {
    const candidate =
        decision && typeof decision === "object" && typeof (decision as { reason?: unknown }).reason === "string"
            ? { ...(decision as object), reason: clampReason((decision as { reason: string }).reason) }
            : decision
    const schema = input.role === "PILOT" ? PilotDecisionSchema : AtcDecisionSchema
    const parsed = schema.safeParse(candidate)
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new ModelOutputError("INVALID_OUTPUT", `decision fails ${input.role} schema at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}`)
    }
    if (!parsed.data.reason) throw new ModelOutputError("INVALID_OUTPUT", "empty reason")
    return parsed.data
}

// ---------------------------------------------------------------- facts the agent was shown

export type KnownOffer = { offerId: string; airportId: string | null }
export type ProposalFacts = {
    simNowSec: number | null
    offers: KnownOffer[] // offers a pilot may select
    reservationIds: string[]
    activeReservationId: string | null
    negotiationIds: string[]
    flightIds: string[]
    arrivalsClosed: boolean
    closedRunways: string[]
}

const ID_KEY_PATTERN = /\b(offerId|reservationId|negotiationId|flightId)\b["']?\s*[:=]\s*["']?([A-Za-z0-9:_\-.]{1,128})/g

// Collects identifiers by key name from the compact view and from message summaries, so the
// check works whether the actor put request facts in localState or only in a message.
export function collectFacts(input: Pick<AgentDecisionInput, "localState" | "relevantMessages">): ProposalFacts {
    const offers = new Map<string, string | null>()
    const reservationIds = new Set<string>()
    const negotiationIds = new Set<string>()
    const flightIds = new Set<string>()
    const add = (key: string, value: string, airportId: string | null) => {
        if (key === "offerId") offers.set(value, offers.get(value) ?? airportId)
        else if (key === "reservationId") reservationIds.add(value)
        else if (key === "negotiationId") negotiationIds.add(value)
        else if (key === "flightId") flightIds.add(value)
    }
    const walk = (node: unknown, depth: number) => {
        if (depth > 8 || node === null || typeof node !== "object") return
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1)
            return
        }
        const rec = node as Record<string, unknown>
        const airportId = typeof rec.airportId === "string" ? rec.airportId : null
        for (const [key, value] of Object.entries(rec)) {
            if (typeof value === "string" && (key === "offerId" || key === "reservationId" || key === "negotiationId" || key === "flightId")) {
                add(key, value, airportId)
            } else if (typeof value === "string" && key === "roundId") {
                negotiationIds.add(value)
            } else {
                walk(value, depth + 1)
            }
        }
    }
    walk(input.localState, 0)
    for (const m of input.relevantMessages) {
        for (const match of m.summary.matchAll(ID_KEY_PATTERN)) add(match[1]!, match[2]!, null)
    }
    const ls = input.localState as Record<string, unknown>
    const restrictions = (ls.restrictions ?? {}) as { arrivalsClosed?: unknown; closedRunways?: unknown }
    const assignment = ls.activeAssignment as { reservationId?: unknown } | null | undefined
    const simNow = typeof ls.simNowSec === "number" ? ls.simNowSec : typeof ls.lastAdvancedSimSec === "number" ? ls.lastAdvancedSimSec : null
    return {
        simNowSec: simNow,
        offers: [...offers].map(([offerId, airportId]) => ({ offerId, airportId })),
        reservationIds: [...reservationIds],
        activeReservationId: typeof assignment?.reservationId === "string" ? assignment.reservationId : null,
        negotiationIds: [...negotiationIds],
        flightIds: [...flightIds],
        arrivalsClosed: restrictions.arrivalsClosed === true,
        closedRunways: Array.isArray(restrictions.closedRunways) ? restrictions.closedRunways.filter((r): r is string => typeof r === "string") : [],
    }
}

export type ProposalCheck = { ok: true } | { ok: false; code: "RULE_VIOLATION"; detail: string }

const violation = (detail: string): ProposalCheck => ({ ok: false, code: "RULE_VIOLATION", detail })

// Hard checks the worker can make before commit. No invented IDs, no action outside the job,
// no offer at a closed airport or runway, slots on the 30 s grid and not in the past.
export function checkProposal(input: AgentDecisionInput, decision: AgentDecision, facts: ProposalFacts = collectFacts(input)): ProposalCheck {
    if (!permittedActions(input).includes(decision.type)) return violation(`${decision.type} is not allowed for this job`)
    switch (decision.type) {
        case "HOLD":
            return { ok: true }
        case "REQUEST_LANDING": {
            if (new Set(decision.airportIds).size !== decision.airportIds.length) return violation("duplicate airport in request")
            if (!decision.airportIds.every(id => (AIRPORT_IDS as readonly string[]).includes(id))) return violation("unknown airport")
            return { ok: true }
        }
        case "SELECT_OFFER": {
            const offer = facts.offers.find(o => o.offerId === decision.offerId)
            if (!offer) return violation(`offer ${decision.offerId} was never received`)
            if (offer.airportId && offer.airportId !== decision.airportId) return violation(`offer ${decision.offerId} belongs to ${offer.airportId}`)
            return { ok: true }
        }
        case "REQUEST_CLEARANCE": {
            const known = facts.activeReservationId ? decision.reservationId === facts.activeReservationId : facts.reservationIds.includes(decision.reservationId)
            return known ? { ok: true } : violation(`reservation ${decision.reservationId} is not the active assignment`)
        }
        case "PROPOSE_OFFER": {
            if (facts.arrivalsClosed) return violation("airport arrivals are closed")
            if (facts.closedRunways.includes(decision.runwayId)) return violation(`runway ${decision.runwayId} is closed`)
            if (decision.slotStartSimSec % SLOT_GRID_SEC !== 0) return violation(`slot ${decision.slotStartSimSec} is off the ${SLOT_GRID_SEC} s grid`)
            if (facts.simNowSec !== null && decision.slotStartSimSec <= facts.simNowSec) return violation(`slot ${decision.slotStartSimSec} is not in the future`)
            return knownRequest(facts, decision.negotiationId, decision.flightId)
        }
        case "REFUSE": {
            if (decision.code === "OK") return violation("refusal cannot use code OK")
            return knownRequest(facts, decision.negotiationId, decision.flightId)
        }
    }
}

function knownRequest(facts: ProposalFacts, negotiationId: string, flightId: string): ProposalCheck {
    if (facts.negotiationIds.length > 0 && !facts.negotiationIds.includes(negotiationId)) return violation(`negotiation ${negotiationId} was never requested`)
    if (facts.flightIds.length > 0 && !facts.flightIds.includes(flightId)) return violation(`flight ${flightId} did not request`)
    return { ok: true }
}

// Actor rejection codes that mean the job itself is stale or fenced: drop the result, do not
// substitute a fallback (the actor will requeue fresh work). Anything else is a domain rule
// the model broke, so the runner commits the deterministic policy instead.
export const STALE_COMMIT_CODES = new Set<string>([
    "REVISION_CONFLICT",
    "STALE_STATE",
    "INVALID_LEASE",
    "WRONG_RUN",
    "WRONG_PHASE",
    "ALREADY_TERMINAL",
])

export function fallbackReason(code: FallbackCode, policyReason: string): string {
    const prefix = code === "RULES_MODE" ? "Rules" : `Rules fallback (${code})`
    return clampReason(`${prefix}: ${policyReason}`)
}

// One-line timeline summary of a committed decision. Never chain-of-thought.
export function describeDecision(decision: AgentDecision): string {
    switch (decision.type) {
        case "REQUEST_LANDING":
            return `Request landing at ${decision.airportIds.join(", ")}`
        case "SELECT_OFFER":
            return `Accept offer ${decision.offerId} at ${decision.airportId}`
        case "HOLD":
            return "Hold"
        case "REQUEST_CLEARANCE":
            return `Request clearance for ${decision.reservationId}`
        case "PROPOSE_OFFER":
            return `Offer ${decision.flightId} ${decision.runwayId} at T+${decision.slotStartSimSec}s`
        case "REFUSE":
            return `Refuse ${decision.flightId}: ${decision.code}`
    }
}
