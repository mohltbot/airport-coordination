// Role prompts, the compact model view, and the structured-output schema (design §7).
// The model sees a bounded local view: no inbox/outbox/dedup/fencing internals, no lease
// metadata, no credentials, at most MAX_RELEVANT_MESSAGES summaries of at most
// MAX_MESSAGE_SUMMARY_CHARS each, and at most MAX_DECISION_INPUT_BYTES serialized.
import type { AgentDecisionInput } from "@ghost-tower/domain/contracts"
import {
    airportsForDestination,
    MAX_DECISION_INPUT_BYTES,
    MAX_MESSAGE_SUMMARY_CHARS,
    MAX_REASON_CHARS,
    MAX_RELEVANT_MESSAGES,
    RUNWAY_IDS,
    AIRPORT_IDS,
} from "@ghost-tower/domain/constants"
import { distanceNm, travelSeconds } from "@ghost-tower/domain/geometry"
import { ATC_REFUSAL_CODES, collectFacts, permittedActions } from "./tools.ts"

export const PILOT_INSTRUCTIONS = `You are the pilot agent of one fictional flight in Ghost Tower, an airport coordination simulator. This is not real aviation.
You see only your own flight state, the public airport directory with your distance to each airport, the last airport status you were told, and messages sent to you.
Choose exactly one action from allowedActions and return it in the required JSON shape. Give a short factual reason (at most ${MAX_REASON_CHARS} characters) that a person watching the simulation can read. Do not include private deliberation.
Actions:
- REQUEST_LANDING: ask 1 to 3 airports from the supplied airportDirectory for a landing slot. A NORMAL flight asks its original destination first, and the others only after a refusal or closure. An EMERGENCY flight asks every reachable airport, nearest first.
- SELECT_OFFER: accept one offer you received, using its exact offerId and airportId. EMERGENCY: the closest airport with a feasible offer, ties by earlier slot, then airport ID. NORMAL: the original destination if it offered; otherwise the earliest slot, then shortest distance, then airport ID.
- HOLD: wait, for example while replies are still outstanding or nothing feasible is available.
- REQUEST_CLEARANCE: ask final landing clearance for your active reservation, using its exact reservationId.
Offers carry distanceNm and a feasible flag that code computed from your fuel and deadline; never select an offer with feasible false. When requestCandidates is present, it lists the airports the rules require this round to ask.
Never invent an ID, airport, or slot. Code rechecks every hard constraint and replaces a proposal that breaks one with the rules policy.`

export const ATC_INSTRUCTIONS = `You are the air traffic control agent of one fictional airport in Ghost Tower, an airport coordination simulator. This is not real aviation.
You see your own runways, restrictions, offers, reservations, and the facts a flight sent with its landing request. You cannot change a flight's fuel, incidents, or route.
Choose exactly one action from allowedActions and return it in the required JSON shape. Give a short factual reason (at most ${MAX_REASON_CHARS} characters) that a person watching the simulation can read. Do not include private deliberation.
Actions:
- PROPOSE_OFFER: offer the requesting flight a runway and a slot start in simulated seconds. Slots sit on a 30 second grid, no earlier than ceil((now + travelSeconds + 60) / 30) * 30. The protected interval [slotStart, slotStart + occupancySec + 30) must not overlap another offer, reservation, or occupancy on the same runway. Prefer the earliest slot, then R1. Never offer while arrivals are closed or on a closed runway.
- REFUSE: decline with code CLOSED, NO_CAPACITY, UNREACHABLE, or DEADLINE_EXCEEDED.
When the state has a "held" slot, actor code has already reserved that earliest free runway time for this request; offer exactly that runway and slot, or refuse if you have a stated reason. When "held" is null there is no free slot, so refuse.
EMERGENCY requests come first. Use the exact negotiationId and flightId from the request. Code rechecks every hard constraint and replaces a proposal that breaks one with the rules policy.`

export function instructionsFor(role: AgentDecisionInput["role"]): string {
    return role === "PILOT" ? PILOT_INSTRUCTIONS : ATC_INSTRUCTIONS
}

// ---------------------------------------------------------------- compact view

// Keys never shown to a model, at any depth.
const FORBIDDEN_KEYS = new Set([
    "inbox",
    "outbox",
    "jobs",
    "fencing",
    "bufferedControllerMessages",
    "lastControllerSequence",
    "initializedByOperationId",
    "touchdowns",
    "requestMessageId",
    "messageId",
    "transportMessageId",
    "senderHandle",
    "recipientHandle",
    "authorization",
    "leaseToken",
    "jobLeaseToken",
    "leaseUntilWallMs",
    "workerEpoch",
    "token",
    "apiKey",
    "apiToken",
    "workspaceKey",
    "password",
    "secret",
])
const MAX_STRING_CHARS = MAX_MESSAGE_SUMMARY_CHARS

function sanitize(node: unknown, depth = 0): unknown {
    if (depth > 8) return undefined
    if (typeof node === "string") return node.length > MAX_STRING_CHARS ? `${node.slice(0, MAX_STRING_CHARS - 1)}…` : node
    if (node === null || typeof node !== "object") return node
    if (Array.isArray(node)) return node.map(v => sanitize(v, depth + 1)).filter(v => v !== undefined)
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.has(key) || /token|secret|password|apikey/i.test(key)) continue
        const clean = sanitize(value, depth + 1)
        if (clean !== undefined) out[key] = clean
    }
    return out
}

const LIVE_OFFER = new Set(["OFFERED"])
const LIVE_RESERVATION = new Set(["CONFIRMED", "CLEARED", "OCCUPIED"])
const LIVE_CLEARANCE = new Set(["ACTIVE"])

// Items without the filtered field (e.g. the policy's PilotOfferView has no status) are kept.
function filterRecord(value: unknown, keep: (item: Record<string, unknown>) => boolean, field?: string): Record<string, unknown>[] | undefined {
    if (!value || typeof value !== "object") return undefined
    const items = (Array.isArray(value) ? value : Object.values(value)) as Record<string, unknown>[]
    return items.filter(i => i && typeof i === "object" && (field !== undefined && !(field in i) ? true : keep(i)))
}

function activeIncidents(value: unknown): unknown[] | undefined {
    return filterRecord(value, i => i.status === "ACTIVE", "status")?.map(i => ({
        incidentId: i.incidentId,
        kind: i.kind,
        parameters: i.parameters,
        createdAtSimSec: i.createdAtSimSec,
    }))
}

// Turns the claimed local state (a raw aggregate or an actor-built view) into the bounded
// model view. Idempotent: compacting a compact view returns the same shape.
export function compactLocalState(role: AgentDecisionInput["role"], localState: Record<string, unknown>): Record<string, unknown> {
    const view = { ...localState }
    if (view.simNowSec === undefined && typeof view.lastAdvancedSimSec === "number") view.simNowSec = view.lastAdvancedSimSec
    delete view.lastAdvancedSimSec
    delete view.lastTickId
    if ("incidents" in view) view.incidents = activeIncidents(view.incidents) ?? []
    if ("offers" in view) view.offers = filterRecord(view.offers, o => LIVE_OFFER.has(String(o.status)), "status") ?? []
    if ("reservations" in view) view.reservations = filterRecord(view.reservations, r => LIVE_RESERVATION.has(String(r.status)), "status") ?? []
    if ("clearances" in view) view.clearances = filterRecord(view.clearances, c => LIVE_CLEARANCE.has(String(c.status)), "status") ?? []
    if ("releaseObligations" in view) view.releaseObligations = filterRecord(view.releaseObligations, r => r.acknowledged !== true, "acknowledged") ?? []
    if (role === "PILOT" && !("airportDirectory" in view)) {
        const pos = view.position as { x?: unknown; y?: unknown } | undefined
        const speed = typeof view.speedKnots === "number" && view.speedKnots > 0 ? view.speedKnots : null
        if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
            const here = { x: pos.x, y: pos.y }
            view.airportDirectory = airportsForDestination(view.originalDestination).map(a => {
                const d = distanceNm(here, a.position)
                return {
                    airportId: a.airportId,
                    name: a.name,
                    distanceNm: Math.round(d * 10) / 10,
                    travelSec: speed ? Math.round(travelSeconds(d, speed)) : null,
                }
            })
        }
    }
    return sanitize(view) as Record<string, unknown>
}

export type ModelMessage = AgentDecisionInput["relevantMessages"][number]

function boundMessages(messages: AgentDecisionInput["relevantMessages"]): ModelMessage[] {
    // Input order is oldest first; keep the latest MAX_RELEVANT_MESSAGES.
    return messages.slice(-MAX_RELEVANT_MESSAGES).map(m => ({
        messageId: m.messageId,
        type: m.type,
        fromEntityId: m.fromEntityId,
        summary: m.summary.length > MAX_MESSAGE_SUMMARY_CHARS ? `${m.summary.slice(0, MAX_MESSAGE_SUMMARY_CHARS - 1)}…` : m.summary,
    }))
}

export class InputTooLargeError extends Error {
    readonly code = "INPUT_TOO_LARGE" as const
    constructor(readonly bytes: number) {
        super(`required facts serialize to ${bytes} bytes, over ${MAX_DECISION_INPUT_BYTES}`)
        this.name = "InputTooLargeError"
    }
}

const utf8 = new TextEncoder()
const byteLength = (s: string) => utf8.encode(s).length

// The user turn the model reads. Message IDs stay out of the text: the model never needs them
// and the actor resolves relevance itself.
export function renderUserContent(input: AgentDecisionInput): string {
    return JSON.stringify({
        role: input.role,
        entityId: input.entityId,
        decisionRevision: input.decisionRevision,
        allowedActions: permittedActions(input),
        state: input.localState,
        messages: input.relevantMessages.map(m => ({ type: m.type, from: m.fromEntityId, summary: m.summary })),
    })
}

export type PreparedInput = { input: AgentDecisionInput; bytes: number; droppedMessages: number }

// Builds the bounded model input. Drops the oldest summaries first, never required facts.
// Throws InputTooLargeError when the local view alone is over the cap.
export function prepareModelInput(input: AgentDecisionInput): PreparedInput {
    const localState = compactLocalState(input.role, input.localState)
    const all = boundMessages(input.relevantMessages)
    let dropped = input.relevantMessages.length - all.length
    let messages = all
    for (;;) {
        const candidate: AgentDecisionInput = {
            jobId: input.jobId,
            entityId: input.entityId,
            role: input.role,
            decisionRevision: input.decisionRevision,
            allowedActions: input.allowedActions,
            localState,
            relevantMessages: messages,
        }
        const bytes = byteLength(renderUserContent(candidate))
        if (bytes <= MAX_DECISION_INPUT_BYTES) return { input: candidate, bytes, droppedMessages: dropped }
        if (messages.length === 0) throw new InputTooLargeError(bytes)
        messages = messages.slice(1)
        dropped++
    }
}

// ---------------------------------------------------------------- structured-output schema

const str = (description?: string) => (description ? { type: "string", description } : { type: "string" })
const enumOf = (values: readonly string[], description?: string) =>
    description ? { type: "string", enum: [...values], description } : { type: "string", enum: [...values] }
const idField = (known: string[], description: string) => (known.length > 0 ? enumOf(known, description) : str(description))
const reasonField = { type: "string", maxLength: MAX_REASON_CHARS, description: "Short factual reason shown to people watching" }
const variant = (type: string, fields: Record<string, unknown>) => ({
    type: "object",
    additionalProperties: false,
    required: ["type", ...Object.keys(fields), "reason"],
    properties: { type: enumOf([type]), ...fields, reason: reasonField },
})

// Strict JSON schema for OpenAI structured outputs. Root is an object with one `decision`
// whose variants are only the actions this job allows; IDs are enumerated from the facts shown.
export function decisionJsonSchema(input: AgentDecisionInput): Record<string, unknown> {
    const facts = collectFacts(input)
    const offerIds = facts.offers.map(o => o.offerId)
    const reservationIds = facts.activeReservationId ? [facts.activeReservationId] : facts.reservationIds
    const variants: Record<string, unknown>[] = []
    for (const action of permittedActions(input)) {
        switch (action) {
            case "REQUEST_LANDING":
                variants.push(variant(action, { airportIds: { type: "array", items: enumOf(AIRPORT_IDS), description: "1 to 3 distinct airports, in request order" } }))
                break
            case "SELECT_OFFER":
                variants.push(variant(action, { offerId: idField(offerIds, "offerId of a received offer"), airportId: enumOf(AIRPORT_IDS) }))
                break
            case "HOLD":
                variants.push(variant(action, {}))
                break
            case "REQUEST_CLEARANCE":
                variants.push(variant(action, { reservationId: idField(reservationIds, "active reservationId") }))
                break
            case "PROPOSE_OFFER":
                variants.push(
                    variant(action, {
                        negotiationId: idField(facts.negotiationIds, "negotiationId from the request"),
                        flightId: idField(facts.flightIds, "requesting flightId"),
                        runwayId: enumOf(RUNWAY_IDS),
                        slotStartSimSec: { type: "number", description: "slot start, simulated seconds, multiple of 30" },
                    }),
                )
                break
            case "REFUSE":
                variants.push(
                    variant(action, {
                        negotiationId: idField(facts.negotiationIds, "negotiationId from the request"),
                        flightId: idField(facts.flightIds, "requesting flightId"),
                        code: enumOf(ATC_REFUSAL_CODES),
                    }),
                )
                break
        }
    }
    return {
        type: "object",
        additionalProperties: false,
        required: ["decision"],
        properties: { decision: variants.length === 1 ? variants[0] : { anyOf: variants } },
    }
}

export type ModelRequest = { instructions: string; userContent: string; schemaName: string; schema: Record<string, unknown> }

export function buildModelRequest(input: AgentDecisionInput): ModelRequest {
    const prepared = prepareModelInput(input)
    return {
        instructions: instructionsFor(input.role),
        userContent: renderUserContent(prepared.input),
        schemaName: input.role === "PILOT" ? "pilot_decision" : "atc_decision",
        schema: decisionJsonSchema(prepared.input),
    }
}
