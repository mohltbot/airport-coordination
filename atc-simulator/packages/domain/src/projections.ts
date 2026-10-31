// Pure, browser-safe projection from durable entity state to the public snapshot
// (docs/coordination/frontend-backend-contract.md, "Public snapshot").
// Every public object is built field by field so no private key (token, inbox, outbox,
// job input, fencing, authorization) can ride along. No node APIs, no process.env.
// Relative imports end in ".js": the actor's NodeNext compiler rejects ".ts" and extensionless.
import { MAX_REASON_CHARS, RUNWAY_IDS, RUNWAY_OCCUPANCY_SEC, TIMELINE_MAX_VISIBLE } from "./constants.js"
import {
    PublicSnapshotSchema,
    type AgentMode,
    type AirportState,
    type CommandReceipt,
    type DependencyHealth,
    type FlightState,
    type Incident,
    type IncidentKind,
    type OutboxEntry,
    type Payload,
    type ProtocolEnvelope,
    type PublicAirport,
    type PublicFlight,
    type PublicIncident,
    type PublicSnapshot,
    type SimulationState,
    type TimelineEvent,
} from "./contracts.js"

export const COMMANDS_MAX_VISIBLE = 100
const QUEUE_STATUSES: ReadonlySet<string> = new Set(["CONFIRMED", "CLEARED", "OCCUPIED"])

// ---------------------------------------------------------------- helpers

function clip(text: string, max = MAX_REASON_CHARS): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function shortId(entityId: string): string {
    const i = entityId.indexOf(":")
    return i >= 0 ? entityId.slice(i + 1) : entityId
}

function runwayOf(parameters: unknown): string | null {
    const r = (parameters as { runwayId?: unknown } | null)?.runwayId
    return typeof r === "string" ? r : null
}

function cmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

// Simulated seconds since run start as T+M:SS (750 -> T+12:30).
export function simClock(sec: number): string {
    const s = Math.max(0, Math.floor(sec))
    return `T+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function kindLabel(kind: IncidentKind | string, runwayId: string | null): string {
    switch (kind) {
        case "WEATHER_CLOSED":
            return "Weather closure"
        case "RUNWAY_CLOSED":
            return `Runway ${runwayId ?? "?"} closure`
        case "CAPACITY_REDUCED":
            return "Reduced capacity"
        case "SMOKE":
            return "Smoke"
        case "ENGINE_TROUBLE":
            return "Engine trouble"
        case "LOW_FUEL":
            return "Low fuel"
        default:
            return String(kind)
    }
}

function withDetail(head: string, detail: string | null | undefined): string {
    const d = detail?.trim()
    return d ? `${head} ${d}` : head
}

export const unknownHealth = (detail: string | null = null): DependencyHealth => ({ status: "UNAVAILABLE", detail })

// ---------------------------------------------------------------- incidents

export function toPublicIncident(i: Incident): PublicIncident {
    return {
        incidentId: i.incidentId,
        runId: i.runId,
        target: i.target,
        kind: i.kind,
        parameters: { ...i.parameters },
        status: i.status,
        revision: i.revision,
        createdAtSimSec: i.createdAtSimSec,
        createdAtWallMs: i.createdAtWallMs,
        resolvedAtSimSec: i.resolvedAtSimSec,
    }
}
export const projectIncident = toPublicIncident

// ---------------------------------------------------------------- airports

function airportStatusReason(a: AirportState, status: PublicAirport["status"]): string | null {
    const labels: string[] = []
    const push = (label: string) => {
        if (!labels.includes(label)) labels.push(label)
    }
    const active = Object.values(a.incidents)
        .filter(i => i.status === "ACTIVE" && i.target === a.entityId)
        .sort((x, y) => x.createdAtWallMs - y.createdAtWallMs || cmp(x.incidentId, y.incidentId))
    for (const i of active) {
        push(i.kind === "RUNWAY_CLOSED" ? `Runway ${runwayOf(i.parameters) ?? "?"} closed` : kindLabel(i.kind, null))
    }
    // A restriction with no incident text (e.g. mid-propagation) still gets a reason.
    if (labels.length === 0 && status !== "OPEN") {
        if (a.restrictions.arrivalsClosed) push("Arrivals closed")
        for (const r of a.restrictions.closedRunways) push(`Runway ${r} closed`)
        if (a.restrictions.occupancySec > RUNWAY_OCCUPANCY_SEC) push("Reduced capacity")
    }
    return labels.length ? clip(labels.join("; ")) : null
}

export function toPublicAirport(a: AirportState, simNowSec: number): PublicAirport {
    const { arrivalsClosed, closedRunways, occupancySec } = a.restrictions
    const closed = new Set<string>(closedRunways)
    const runwayIds: readonly string[] = a.runways.length ? a.runways.map(r => r.runwayId) : RUNWAY_IDS
    const status: PublicAirport["status"] =
        arrivalsClosed || runwayIds.every(id => closed.has(id))
            ? "CLOSED"
            : closed.size > 0 || occupancySec > RUNWAY_OCCUPANCY_SEC
              ? "RESTRICTED"
              : "OPEN"

    const runways: PublicAirport["runways"] = a.runways.map(r => ({
        runwayId: r.runwayId,
        status:
            arrivalsClosed || closed.has(r.runwayId)
                ? "CLOSED"
                : r.occupiedUntilSimSec !== null && r.occupiedUntilSimSec > simNowSec
                  ? "OCCUPIED"
                  : "OPEN",
        occupiedUntilSimSec: r.occupiedUntilSimSec,
    }))

    const queue: PublicAirport["queue"] = Object.values(a.reservations)
        .filter(r => QUEUE_STATUSES.has(r.status))
        .map(r => ({
            reservationId: r.reservationId,
            flightId: r.flightId,
            runwayId: r.runwayId,
            slotStartSimSec: r.slotStartSimSec,
            status: r.status,
            priority: r.priority,
        }))
        .sort((x, y) => x.slotStartSimSec - y.slotStartSimSec || cmp(x.runwayId, y.runwayId) || cmp(x.reservationId, y.reservationId))

    return {
        entityId: a.entityId,
        airportId: a.airportId,
        name: a.name,
        position: { x: a.position.x, y: a.position.y },
        status,
        statusReason: airportStatusReason(a, status),
        stateRevision: a.stateRevision,
        runways,
        queue,
    }
}
export const projectAirport = toPublicAirport

// ---------------------------------------------------------------- flights

export function toPublicFlight(f: FlightState, airports: AirportState[], wallNowMs: number): PublicFlight {
    let last: { reason: string; source: PublicFlight["lastDecisionSource"]; at: number } | null = null
    for (const job of Object.values(f.jobs)) {
        const o = job.outcome
        if (o && (!last || o.committedAtWallMs > last.at)) last = { reason: o.reason, source: o.source, at: o.committedAtWallMs }
    }

    const proposals: PublicFlight["proposals"] = airports
        .flatMap(a => Object.values(a.offers))
        .filter(o => o.flightId === f.flightId && o.status === "OFFERED" && o.expiresAtWallMs > wallNowMs)
        .map(o => ({
            offerId: o.offerId,
            airportId: o.airportId,
            runwayId: o.runwayId,
            slotStartSimSec: o.slotStartSimSec,
            expiresAtWallMs: o.expiresAtWallMs,
        }))
        .sort((x, y) => x.slotStartSimSec - y.slotStartSimSec || cmp(x.airportId, y.airportId) || cmp(x.offerId, y.offerId))

    const as = f.activeAssignment
    return {
        entityId: f.entityId,
        flightId: f.flightId,
        callsign: f.callsign,
        position: { x: f.position.x, y: f.position.y },
        headingDeg: f.headingDeg,
        speedKnots: f.speedKnots,
        fuelRemainingSec: f.fuelRemainingSec,
        phase: f.phase,
        priority: f.priority,
        deadlineSimSec: f.deadlineSimSec,
        originalDestination: f.originalDestination,
        ...(f.originAirportId ? { originAirportId: f.originAirportId } : {}),
        activeAssignment: as
            ? {
                  airportId: as.airportId,
                  runwayId: as.runwayId,
                  reservationId: as.reservationId,
                  slotStartSimSec: as.slotStartSimSec,
                  occupancySec: as.occupancySec,
                  clearanceId: as.clearanceId,
              }
            : null,
        negotiationStage: f.negotiation?.stage ?? null,
        stateRevision: f.stateRevision,
        lastDecisionReason: last ? clip(last.reason) : null,
        lastDecisionSource: last?.source ?? null,
        unresolvedReason: f.terminalReason,
        proposals,
    }
}

// ---------------------------------------------------------------- timeline

// Short human text for a protocol payload. Never includes private fields.
export function summarizePayload(type: string, payload: unknown): string {
    try {
        return clip(summarize(type, payload))
    } catch {
        return clip(type)
    }
}

const spokenCode = (code: string) => code.toLowerCase().replaceAll("_", " ")

function summarize(type: string, payload: unknown): string {
    switch (type) {
        case "INCIDENT_CREATE": {
            const p = payload as Payload<"INCIDENT_CREATE">
            return `${kindLabel(p.kind, runwayOf(p.parameters))} created at ${shortId(p.target)}`
        }
        case "INCIDENT_CLEAR": {
            const p = payload as Payload<"INCIDENT_CLEAR">
            return `Incident cleared at ${shortId(p.target)}`
        }
        case "COMMAND_RESULT": {
            const p = payload as Payload<"COMMAND_RESULT">
            return p.outcome === "APPLIED" ? "Command APPLIED" : `Command REJECTED: ${p.code}`
        }
        case "AIRPORT_STATUS": {
            const p = payload as Payload<"AIRPORT_STATUS">
            const r = p.restrictions
            const state = r.arrivalsClosed
                ? "closed to arrivals"
                : r.closedRunways.length
                  ? `runway ${r.closedRunways.join(", ")} closed`
                  : r.occupancySec > RUNWAY_OCCUPANCY_SEC
                    ? "reduced capacity"
                    : "open"
            return `${p.airportId} tower. Airport ${state}.`
        }
        case "LANDING_REQUEST": {
            const p = payload as Payload<"LANDING_REQUEST">
            return `${p.priority === "EMERGENCY" ? "Mayday, declaring an emergency. Request priority landing." : "Tower, requesting landing."} We have ${Math.max(0, Math.floor(p.fuelRemainingSec / 60))} minutes of fuel remaining.`
        }
        case "LANDING_OFFER": {
            const p = payload as Payload<"LANDING_OFFER">
            return `We can offer runway ${p.runwayId} at ${simClock(p.slotStartSimSec)}. Can you accept?`
        }
        case "LANDING_REFUSED": {
            const p = payload as Payload<"LANDING_REFUSED">
            return withDetail(`Unable to accept your landing request: ${spokenCode(p.code)}.`, p.explanation)
        }
        case "OFFER_ACCEPT":
            return "Roger, we accept that landing slot. Awaiting confirmation."
        case "OFFER_DECLINE":
            return "Unable to accept that slot. We decline the offer."
        case "LANDING_CONFIRMED": {
            const p = payload as Payload<"LANDING_CONFIRMED">
            return `Your slot is confirmed: runway ${p.runwayId} at ${simClock(p.slotStartSimSec)}. Landing clearance is still required.`
        }
        case "RESERVATION_RELEASE":
            return "Tower, releasing our reserved landing slot."
        case "RESERVATION_REVOKED": {
            const p = payload as Payload<"RESERVATION_REVOKED">
            return withDetail(`Your landing reservation is cancelled: ${spokenCode(p.code)}.`, p.reason)
        }
        case "RESERVATION_STATUS_REQUEST":
            return "Tower, can you confirm the status of our landing slot?"
        case "RESERVATION_STATUS":
            return `Your landing slot status is ${spokenCode((payload as Payload<"RESERVATION_STATUS">).status)}.`
        case "CLEARANCE_REQUEST":
            return "Tower, requesting landing clearance for our confirmed slot."
        case "CLEARANCE_GRANTED": {
            const p = payload as Payload<"CLEARANCE_GRANTED">
            return `Cleared to land within your assigned window, ${simClock(p.windowStartSimSec)} to ${simClock(p.windowEndSimSec)}.`
        }
        case "CLEARANCE_REFUSED":
            return `Unable to clear you to land: ${spokenCode((payload as Payload<"CLEARANCE_REFUSED">).code)}.`
        case "DOMAIN_ACK":
            return `Ack ${(payload as Payload<"DOMAIN_ACK">).resultCode}`
        default:
            return type
    }
}

// Stable thread key for TimelineEvent.correlationId (agreed with the UI):
// negotiation messages -> negotiation round (payload.negotiationId, else envelope.correlationId);
// incident commands and COMMAND_RESULT -> payload.incidentId; AIRPORT_STATUS and DOMAIN_ACK -> null.
export function threadKey(env: ProtocolEnvelope): string | null {
    switch (env.type) {
        case "AIRPORT_STATUS":
        case "DOMAIN_ACK":
            return null
        case "INCIDENT_CREATE":
        case "INCIDENT_CLEAR":
        case "COMMAND_RESULT":
            return env.payload.incidentId
        default: {
            const n = (env.payload as { negotiationId?: unknown }).negotiationId
            return typeof n === "string" && n.length > 0 ? n : env.correlationId
        }
    }
}

function payloadSimSec(type: string, payload: unknown): number | null {
    const p = payload as { sampledAtSimSec?: unknown; facts?: { sampledAtSimSec?: unknown } } | null
    const v =
        type === "LANDING_REQUEST"
            ? p?.sampledAtSimSec
            : type === "OFFER_ACCEPT" || type === "CLEARANCE_REQUEST"
              ? p?.facts?.sampledAtSimSec
              : undefined
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
}

// Best-effort sim time for a wall-clock instant: extrapolate from the latest run event at or
// before it, clamped to [0, simNowSec]; run.simNowSec when there is no anchor.
function simSecAt(run: SimulationState, wallMs: number): number {
    let anchor: { wallMs: number; simSec: number } | null = null
    for (const e of run.events) if (e.wallMs <= wallMs && (!anchor || e.wallMs >= anchor.wallMs)) anchor = e
    if (!anchor) return run.simNowSec
    const est = anchor.simSec + ((wallMs - anchor.wallMs) / 1000) * run.config.speed
    return Math.min(run.simNowSec, Math.max(0, est))
}

function outboxEvent(entry: OutboxEntry, run: SimulationState): TimelineEvent | null {
    const env = entry.envelope
    if (env.type === "DOMAIN_ACK") return null
    const refused =
        env.type === "LANDING_REFUSED" ||
        env.type === "CLEARANCE_REFUSED" ||
        (env.type === "COMMAND_RESULT" && env.payload.outcome === "REJECTED")
    return {
        eventId: env.messageId,
        simTimeSec: payloadSimSec(env.type, env.payload) ?? simSecAt(run, env.createdAtWallMs),
        wallTimeMs: env.createdAtWallMs,
        fromEntityId: env.fromEntityId,
        toEntityId: env.toEntityId,
        type: env.type,
        summary: summarizePayload(env.type, env.payload),
        status: refused ? "REFUSED" : entry.acknowledged ? "APPLIED" : "PENDING",
        source: "SYSTEM",
        correlationId: threadKey(env),
    }
}

const NEGOTIATION_TYPES: ReadonlySet<string> = new Set([
    "LANDING_REQUEST",
    "LANDING_OFFER",
    "LANDING_REFUSED",
    "OFFER_ACCEPT",
    "OFFER_DECLINE",
    "LANDING_CONFIRMED",
    "RESERVATION_RELEASE",
    "RESERVATION_REVOKED",
    "RESERVATION_STATUS_REQUEST",
    "RESERVATION_STATUS",
    "CLEARANCE_REQUEST",
    "CLEARANCE_GRANTED",
    "CLEARANCE_REFUSED",
])

export function timelineFromEntities(airports: AirportState[], flights: FlightState[], run: SimulationState): TimelineEvent[] {
    const events = new Map<string, TimelineEvent>()
    const add = (e: TimelineEvent | null) => {
        if (e && !events.has(e.eventId)) events.set(e.eventId, e)
    }
    const entities: Array<AirportState | FlightState> = [...airports, ...flights]
    const allOutbox = [...entities.flatMap(e => e.outbox), ...run.controllerOutbox]

    // messageId -> negotiation round, so a job is threaded through the messages it decided on.
    const roundByMessage = new Map<string, string>()
    for (const entry of allOutbox) {
        const key = NEGOTIATION_TYPES.has(entry.envelope.type) ? threadKey(entry.envelope) : null
        if (key) roundByMessage.set(entry.envelope.messageId, key)
    }

    for (const entry of allOutbox) add(outboxEvent(entry, run))

    for (const entity of entities) {
        for (const job of Object.values(entity.jobs)) {
            const o = job.outcome
            if (!o) continue
            let round: string | null = null
            for (const id of job.input.relevantMessageIds) round = roundByMessage.get(id) ?? round
            add({
                eventId: `${entity.entityId}:${job.jobId}`,
                simTimeSec: simSecAt(run, o.committedAtWallMs),
                wallTimeMs: o.committedAtWallMs,
                fromEntityId: entity.entityId,
                toEntityId: null,
                type: o.action,
                summary: clip(o.reason),
                status: "INFO",
                source: o.source,
                correlationId: round,
            })
        }
    }

    const commandIds = new Set(Object.values(run.commands).map(c => c.command.commandId))
    for (const e of run.events) {
        add({
            eventId: `${run.runId}:event:${e.eventIndex}`,
            simTimeSec: e.simSec,
            wallTimeMs: e.wallMs,
            fromEntityId: "system",
            toEntityId: null,
            type: e.type,
            summary: clip(e.summary),
            status: "INFO",
            source: "SYSTEM",
            correlationId: e.operationId !== null && commandIds.has(e.operationId) ? e.operationId : null,
        })
    }

    return [...events.values()]
        .sort((a, b) => a.wallTimeMs - b.wallTimeMs || cmp(a.eventId, b.eventId))
        .slice(-TIMELINE_MAX_VISIBLE)
}

// ---------------------------------------------------------------- snapshot

export type BuildPublicSnapshotInput = {
    run: SimulationState
    airports: AirportState[]
    flights: FlightState[]
    wallNowMs: number
    projectionVersion: number
    health: PublicSnapshot["health"]
    agentMode: AgentMode
}

export function buildPublicSnapshot(input: BuildPublicSnapshotInput): PublicSnapshot {
    const { run, wallNowMs, projectionVersion, health, agentMode } = input
    const airports = [...input.airports].sort((a, b) => cmp(a.airportId, b.airportId))
    const flights = [...input.flights].sort((a, b) => cmp(a.flightId, b.flightId))

    const incidentsById = new Map<string, Incident>()
    for (const entity of [...airports, ...flights]) {
        for (const i of Object.values(entity.incidents)) {
            const seen = incidentsById.get(i.incidentId)
            if (!seen || i.revision > seen.revision) incidentsById.set(i.incidentId, i)
        }
    }
    const incidents = [...incidentsById.values()]
        .sort((a, b) => a.createdAtWallMs - b.createdAtWallMs || cmp(a.incidentId, b.incidentId))
        .map(toPublicIncident)

    const commands: CommandReceipt[] = Object.values(run.commands)
        .sort((a, b) => a.submittedAtWallMs - b.submittedAtWallMs || cmp(a.receipt.commandId, b.receipt.commandId))
        .slice(-COMMANDS_MAX_VISIBLE)
        .map(({ receipt: r }) => ({
            runId: r.runId,
            commandId: r.commandId,
            status: r.status,
            incidentId: r.incidentId,
            code: r.code,
            resultingRevision: r.resultingRevision,
        }))

    const snapshot: PublicSnapshot = {
        schemaVersion: 1,
        runId: run.runId,
        projectionVersion,
        phase: run.phase,
        simTimeSec: run.simNowSec,
        serverWallTimeMs: wallNowMs,
        config: { flightCount: run.config.flightCount, seed: run.config.seed, speed: run.config.speed },
        airports: airports.map(a => toPublicAirport(a, run.simNowSec)),
        flights: flights.map(f => toPublicFlight(f, airports, wallNowMs)),
        incidents,
        commands,
        timeline: timelineFromEntities(airports, flights, run),
        health,
        agentMode,
    }
    return PublicSnapshotSchema.parse(snapshot)
}

// ---------------------------------------------------------------- leak guard

export const PRIVATE_FIELD_NAMES: ReadonlySet<string> = new Set([
    "token",
    "leaseToken",
    "jobLeaseToken",
    "workspaceKey",
    "apiKey",
    "inbox",
    "outbox",
    "controllerOutbox",
    "controllerInbox",
    "authorization",
    "fencing",
    "input",
])

// Throws when the JSON form of `value` has an object key on the private list (keys only, at any depth).
export function assertNoPrivateFields(value: unknown): void {
    const json = JSON.stringify(value)
    if (json === undefined) return
    const walk = (node: unknown, path: string): void => {
        if (Array.isArray(node)) {
            node.forEach((v, i) => walk(v, `${path}[${i}]`))
        } else if (node !== null && typeof node === "object") {
            for (const [k, v] of Object.entries(node)) {
                if (PRIVATE_FIELD_NAMES.has(k)) throw new Error(`private field "${k}" at ${path}`)
                walk(v, `${path}.${k}`)
            }
        }
    }
    walk(JSON.parse(json), "$")
}
