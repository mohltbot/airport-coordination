// Controller command ledger: the SimulationActor half of command ordering
// (design §7 "Command ordering and clearing"). Pure functions over one run's
// SimulationState; the actor assigns the returned state once.
//
// - submitCommandToLedger dedups the client commandId (same content returns
//   the stored receipt, changed content conflicts), assigns the next
//   per-target commandSequence and persists the envelope in controllerOutbox
//   before the HTTP 202.
// - At most one unresolved command per target is dispatchable. Later ones sit
//   in the outbox "parked" (nextAttemptAtWallMs = PARKED_AT_WALL_MS) and are
//   released when the head's COMMAND_RESULT arrives. A clear therefore never
//   reaches its target before its create has a result.
// - Expired envelopes are still delivered so the target consumes the sequence
//   with a TIMEOUT result; the ledger never guesses an outcome.
// - Terminal receipts (APPLIED, REJECTED) never regress.
import {
    IncidentCommandSchema,
    entityHandle,
    type AirportEntityId,
    type CommandLedgerEntry,
    type CommandReceipt,
    type ControllerPrincipal,
    type DomainResult,
    type FlightEntityId,
    type IncidentCommand,
    type OutboxEntry,
    type ProtocolEnvelope,
    type ReceivedEnvelope,
    type RunEvent,
    type SimulationState,
} from "./contracts.js"
import { COMMAND_DELAYED_AFTER_MS, COMMAND_EXPIRY_MS } from "./constants.js"
import { stableHashHex, stableStringify, stableUuid } from "./stable-id.js"

/** nextAttemptAtWallMs for a command waiting behind an unresolved predecessor. */
export const PARKED_AT_WALL_MS = Number.MAX_SAFE_INTEGER

const DISPATCHABLE_PHASES: ReadonlySet<SimulationState["phase"]> = new Set(["PAUSED", "RUNNING"])
const TERMINAL: ReadonlySet<CommandReceipt["status"]> = new Set(["APPLIED", "REJECTED"])

export type LedgerError = {
    ok: false
    /** HTTP status the gateway should return. */
    httpStatus: 400 | 404 | 409
    code: "INVALID_PAYLOAD" | "WRONG_RUN" | "WRONG_PHASE" | "UNKNOWN_ENTITY" | "COMMAND_ID_CONFLICT"
    message: string
}
export type LedgerSubmitOk = { ok: true; state: SimulationState; receipt: CommandReceipt; duplicate: boolean; messageId: string }
export type LedgerSubmitResult = LedgerSubmitOk | LedgerError

/** Fields the server-issued proof binds (same shape as server/src/relay/router.ts CommandProofFields). */
export type CommandProofFields = {
    runId: string
    commandId: string
    commandSequence: number
    toEntityId: string
    type: "INCIDENT_CREATE" | "INCIDENT_CLEAR"
    incidentId: string
}

export type LedgerSubmitOptions = {
    wallNowMs: number
    /** Server-issued proof carried in the envelope. Pass a signer, e.g.
     *  `f => commandProof(secret, f)`, because the sequence is assigned here. */
    authorization: string | ((fields: CommandProofFields) => string)
    expiryMs?: number
}

export function commandTarget(command: IncidentCommand): AirportEntityId | FlightEntityId {
    return command.payload.target
}

export function commandContentHash(command: IncidentCommand): string {
    return stableHashHex(stableStringify(command))
}

/** Message ID of a command's envelope: stable per (run, command). */
export function commandMessageId(runId: string, commandId: string): string {
    return stableUuid(runId, "controller", "COMMAND", commandId)
}

export function isTerminalReceipt(receipt: CommandReceipt): boolean {
    return TERMINAL.has(receipt.status)
}

function pushEvent(state: SimulationState, wallMs: number, type: string, summary: string, operationId: string | null): RunEvent[] {
    const last = state.events[state.events.length - 1]
    return [...state.events, { eventIndex: last ? last.eventIndex + 1 : 0, wallMs, simSec: state.simNowSec, type, summary: summary.slice(0, 240), operationId }]
}

function describe(command: IncidentCommand): string {
    return command.type === "INCIDENT_CREATE"
        ? `${command.payload.kind}${"runwayId" in command.payload.parameters ? ` ${command.payload.parameters.runwayId}` : ""} for ${command.payload.target}`
        : `clear ${command.payload.incidentId.slice(0, 8)} on ${command.payload.target}`
}

/** Persist a new controller command (or return the stored receipt for a retry). */
export function submitCommandToLedger(
    state: SimulationState,
    rawCommand: unknown,
    principal: ControllerPrincipal,
    opts: LedgerSubmitOptions,
): LedgerSubmitResult {
    const parsed = IncidentCommandSchema.safeParse(rawCommand)
    if (!parsed.success) return { ok: false, httpStatus: 400, code: "INVALID_PAYLOAD", message: parsed.error.issues[0]?.message ?? "invalid command" }
    const command = parsed.data
    if (command.runId !== state.runId || principal.runId !== state.runId) {
        return { ok: false, httpStatus: 409, code: "WRONG_RUN", message: "command is not for this run" }
    }

    const hash = commandContentHash(command)
    const existing = state.commands[command.commandId]
    if (existing) {
        if (existing.contentHash !== hash) return { ok: false, httpStatus: 409, code: "COMMAND_ID_CONFLICT", message: "commandId reused with different contents" }
        return { ok: true, state, receipt: existing.receipt, duplicate: true, messageId: existing.messageId }
    }

    if (state.fencedAtWallMs !== null || !DISPATCHABLE_PHASES.has(state.phase)) {
        return { ok: false, httpStatus: 409, code: "WRONG_PHASE", message: `run is ${state.fencedAtWallMs !== null ? "fenced" : state.phase}` }
    }
    const target = commandTarget(command)
    if (!state.entities.some(e => e.entityId === target)) {
        return { ok: false, httpStatus: 404, code: "UNKNOWN_ENTITY", message: `${target} is not in this run` }
    }

    const commandSequence = (state.targetSequences[target] ?? 0) + 1
    const messageId = commandMessageId(state.runId, command.commandId)
    const base = {
        schemaVersion: 1 as const,
        messageId,
        runId: state.runId,
        fromEntityId: "controller" as const,
        toEntityId: target,
        correlationId: command.commandId,
        causationId: null,
        createdAtWallMs: opts.wallNowMs,
        expiresAtWallMs: opts.wallNowMs + (opts.expiryMs ?? COMMAND_EXPIRY_MS),
        commandId: command.commandId,
        commandSequence,
        authorization:
            typeof opts.authorization === "function"
                ? opts.authorization({ runId: state.runId, commandId: command.commandId, commandSequence, toEntityId: target, type: command.type, incidentId: command.payload.incidentId })
                : opts.authorization,
    }
    const envelope: ProtocolEnvelope =
        command.type === "INCIDENT_CREATE" ? { ...base, type: "INCIDENT_CREATE", payload: command.payload } : { ...base, type: "INCIDENT_CLEAR", payload: command.payload }
    const receipt: CommandReceipt = {
        runId: state.runId,
        commandId: command.commandId,
        status: "QUEUED",
        incidentId: command.payload.incidentId,
        code: null,
        resultingRevision: null,
    }
    const entry: CommandLedgerEntry = {
        command,
        principal,
        commandSequence,
        target,
        contentHash: hash,
        messageId,
        receipt,
        submittedAtWallMs: opts.wallNowMs,
        updatedAtWallMs: opts.wallNowMs,
    }
    const outbox: OutboxEntry = {
        envelope,
        recipientHandle: entityHandle(state.runId, target),
        attemptCount: 0,
        nextAttemptAtWallMs: PARKED_AT_WALL_MS,
        transportMessageId: null,
        acknowledged: false,
    }
    const next = releaseControllerCommands(
        {
            ...state,
            stateRevision: state.stateRevision + 1,
            commands: { ...state.commands, [command.commandId]: entry },
            targetSequences: { ...state.targetSequences, [target]: commandSequence },
            controllerOutbox: [...state.controllerOutbox, outbox],
            events: pushEvent(state, opts.wallNowMs, "COMMAND_QUEUED", `Controller queued ${describe(command)} (#${commandSequence})`, command.commandId),
        },
        opts.wallNowMs,
    )
    return { ok: true, state: next, receipt: next.commands[command.commandId]!.receipt, duplicate: false, messageId }
}

/** The lowest-sequence unresolved command for a target, if any. */
export function headCommand(state: SimulationState, target: string): CommandLedgerEntry | null {
    let head: CommandLedgerEntry | null = null
    for (const entry of Object.values(state.commands)) {
        if (entry.target !== target || isTerminalReceipt(entry.receipt)) continue
        if (!head || entry.commandSequence < head.commandSequence) head = entry
    }
    return head
}

/** Unpark the head command of every target. Idempotent. */
export function releaseControllerCommands(state: SimulationState, wallNowMs: number): SimulationState {
    const heads = new Set<string>()
    for (const target of Object.keys(state.targetSequences)) {
        const head = headCommand(state, target)
        if (head) heads.add(head.messageId)
    }
    let changed = false
    const controllerOutbox = state.controllerOutbox.map(e => {
        if (e.acknowledged || e.nextAttemptAtWallMs !== PARKED_AT_WALL_MS || !heads.has(e.envelope.messageId)) return e
        changed = true
        return { ...e, nextAttemptAtWallMs: wallNowMs }
    })
    return changed ? { ...state, controllerOutbox } : state
}

/** Outbox entries the dispatcher may send now (not acknowledged, not parked, due). */
export function dueControllerOutbox(state: SimulationState, wallNowMs: number): OutboxEntry[] {
    return state.controllerOutbox.filter(e => !e.acknowledged && e.nextAttemptAtWallMs !== PARKED_AT_WALL_MS && e.nextAttemptAtWallMs <= wallNowMs)
}

function updateReceipt(state: SimulationState, commandId: string, patch: Partial<CommandReceipt>, wallNowMs: number): SimulationState {
    const entry = state.commands[commandId]
    if (!entry) return state
    return {
        ...state,
        commands: { ...state.commands, [commandId]: { ...entry, receipt: { ...entry.receipt, ...patch }, updatedAtWallMs: wallNowMs } },
    }
}

/** Relay accepted the command envelope: QUEUED becomes SENT. */
export function markControllerCommandSent(state: SimulationState, messageId: string, transportMessageId: string, wallNowMs: number): SimulationState {
    const entry = Object.values(state.commands).find(e => e.messageId === messageId)
    let next: SimulationState = {
        ...state,
        controllerOutbox: state.controllerOutbox.map(e => (e.envelope.messageId === messageId && e.transportMessageId === null ? { ...e, transportMessageId } : e)),
    }
    if (entry && entry.receipt.status === "QUEUED") {
        next = updateReceipt(next, entry.command.commandId, { status: "SENT" }, wallNowMs)
        next = { ...next, stateRevision: state.stateRevision + 1 }
    }
    return next
}

/** Mark in-flight commands DELAYED after the threshold without a result.
 *  Parked successors stay QUEUED. A later result replaces DELAYED. */
export function refreshDelayedCommands(state: SimulationState, wallNowMs: number, delayedAfterMs: number = COMMAND_DELAYED_AFTER_MS): SimulationState {
    let next = state
    for (const entry of Object.values(state.commands)) {
        if (entry.receipt.status !== "QUEUED" && entry.receipt.status !== "SENT") continue
        if (wallNowMs - entry.submittedAtWallMs < delayedAfterMs) continue
        const head = headCommand(state, entry.target)
        if (!head || head.command.commandId !== entry.command.commandId) continue
        next = updateReceipt(next, entry.command.commandId, { status: "DELAYED" }, wallNowMs)
    }
    if (next === state) return state
    return {
        ...next,
        stateRevision: state.stateRevision + 1,
        events: pushEvent(next, wallNowMs, "COMMAND_DELAYED", "Controller command result is taking longer than expected", null),
    }
}

export type CommandResultTransition = { state: SimulationState; result: DomainResult; receipt: CommandReceipt | null }

/** Apply a COMMAND_RESULT received through Relay to the ledger. */
export function applyCommandResult(
    state: SimulationState,
    message: Extract<ReceivedEnvelope, { type: "COMMAND_RESULT" }>,
    wallNowMs: number,
): CommandResultTransition {
    const prior = state.controllerInbox[message.messageId]
    if (prior) {
        return {
            state,
            result: { outcome: "DUPLICATE", code: prior.result.code, stateRevision: state.stateRevision, original: prior.result },
            receipt: state.commands[message.payload.commandId]?.receipt ?? null,
        }
    }
    const record = (outcome: "APPLIED" | "REJECTED", code: string, s: SimulationState): CommandResultTransition => {
        const result = { outcome, code, stateRevision: s.stateRevision + 1 }
        const next: SimulationState = {
            ...s,
            stateRevision: result.stateRevision,
            controllerInbox: {
                ...s.controllerInbox,
                [message.messageId]: { messageId: message.messageId, type: message.type, fromEntityId: message.fromEntityId, result, processedAtWallMs: wallNowMs },
            },
        }
        return { state: next, result, receipt: next.commands[message.payload.commandId]?.receipt ?? null }
    }

    if (message.runId !== state.runId) return record("REJECTED", "WRONG_RUN", state)
    const entry = state.commands[message.payload.commandId]
    if (!entry) return record("REJECTED", "INVALID_PAYLOAD", state)
    if (message.fromEntityId !== entry.target || message.toEntityId !== "controller") return record("REJECTED", "UNAUTHORIZED", state)
    if (isTerminalReceipt(entry.receipt)) return record("APPLIED", "OK", state)

    const p = message.payload
    let next = updateReceipt(state, entry.command.commandId, { status: p.outcome, code: p.code, resultingRevision: p.resultingRevision }, wallNowMs)
    // The result proves delivery: stop retrying the command envelope.
    next = {
        ...next,
        controllerOutbox: next.controllerOutbox.map(e => (e.envelope.messageId === entry.messageId && !e.acknowledged ? { ...e, acknowledged: true } : e)),
        events: pushEvent(
            next,
            wallNowMs,
            p.outcome === "APPLIED" ? "COMMAND_APPLIED" : "COMMAND_REJECTED",
            `${entry.target} ${p.outcome === "APPLIED" ? "applied" : `rejected (${p.code})`} ${describe(entry.command)}`,
            entry.command.commandId,
        ),
    }
    next = releaseControllerCommands(next, wallNowMs)
    return record("APPLIED", "OK", next)
}

export function readCommandReceipt(state: SimulationState, commandId: string): CommandReceipt | null {
    return state.commands[commandId]?.receipt ?? null
}

/** Receipts newest first, for the public snapshot. */
export function listCommandReceipts(state: SimulationState, limit = 50): CommandReceipt[] {
    return Object.values(state.commands)
        .sort((a, b) => b.submittedAtWallMs - a.submittedAtWallMs || b.commandSequence - a.commandSequence)
        .slice(0, limit)
        .map(e => e.receipt)
}

// ---------------------------------------------------------------- worker ports

/** Un-acknowledged controller outbox entries (OutboxPort.list). Parked
 *  entries are included; their nextAttemptAtWallMs keeps them from being due. */
export function listControllerOutbox(state: SimulationState): OutboxEntry[] {
    return state.controllerOutbox.filter(e => !e.acknowledged)
}

export type ControllerOutboxAttempt = { messageId: string; transportMessageId: string | null; attemptCount: number; nextAttemptAtWallMs: number }

/** OutboxPort.recordAttempt for the controller outbox. A transport receipt
 *  moves the command receipt from QUEUED to SENT. Never parks or unparks. */
export function recordControllerOutboxAttempt(state: SimulationState, attempt: ControllerOutboxAttempt, wallNowMs: number): SimulationState {
    const idx = state.controllerOutbox.findIndex(e => e.envelope.messageId === attempt.messageId)
    if (idx < 0) return state
    const entry = state.controllerOutbox[idx]!
    const updated: OutboxEntry = {
        ...entry,
        attemptCount: Math.max(entry.attemptCount, attempt.attemptCount),
        nextAttemptAtWallMs: entry.nextAttemptAtWallMs === PARKED_AT_WALL_MS ? entry.nextAttemptAtWallMs : attempt.nextAttemptAtWallMs,
        transportMessageId: attempt.transportMessageId ?? entry.transportMessageId,
    }
    let next: SimulationState = { ...state, controllerOutbox: state.controllerOutbox.map((e, i) => (i === idx ? updated : e)) }
    const ledger = Object.values(state.commands).find(e => e.messageId === attempt.messageId)
    if (ledger && attempt.transportMessageId && ledger.receipt.status === "QUEUED") next = updateReceipt(next, ledger.command.commandId, { status: "SENT" }, wallNowMs)
    return { ...next, stateRevision: state.stateRevision + 1 }
}

/** Entry point for messages addressed to the controller (worker receiveController):
 *  COMMAND_RESULT updates the ledger; DOMAIN_ACK marks the acknowledged outbox
 *  entry. Both dedup on messageId via controllerInbox. */
export function receiveControllerMessage(state: SimulationState, message: ReceivedEnvelope, wallNowMs: number): { state: SimulationState; result: DomainResult } {
    if (message.type === "COMMAND_RESULT") {
        const r = applyCommandResult(state, message, wallNowMs)
        return { state: r.state, result: r.result }
    }
    const prior = state.controllerInbox[message.messageId]
    if (prior) return { state, result: { outcome: "DUPLICATE", code: prior.result.code, stateRevision: state.stateRevision, original: prior.result } }
    let outcome: "APPLIED" | "REJECTED" = "REJECTED"
    let code = "INVALID_PAYLOAD"
    let next = state
    if (message.runId !== state.runId) code = "WRONG_RUN"
    else if (message.toEntityId !== "controller") code = "UNAUTHORIZED"
    else if (message.type === "DOMAIN_ACK") {
        const target = state.controllerOutbox.find(e => e.envelope.messageId === message.payload.processedMessageId)
        if (!target) code = "UNKNOWN_INCIDENT"
        else if (target.envelope.toEntityId !== message.fromEntityId) code = "UNAUTHORIZED"
        else {
            outcome = "APPLIED"
            code = "OK"
            if (!target.acknowledged)
                next = { ...state, controllerOutbox: state.controllerOutbox.map(e => (e === target ? { ...e, acknowledged: true } : e)) }
        }
    }
    const result = { outcome, code, stateRevision: next.stateRevision + 1 }
    return {
        state: {
            ...next,
            stateRevision: result.stateRevision,
            controllerInbox: {
                ...next.controllerInbox,
                [message.messageId]: { messageId: message.messageId, type: message.type, fromEntityId: message.fromEntityId, result, processedAtWallMs: wallNowMs },
            },
        },
        result,
    }
}

/** Proof fields of a controller command envelope (null for other types). */
export function commandProofFields(envelope: ProtocolEnvelope): CommandProofFields | null {
    if (envelope.type !== "INCIDENT_CREATE" && envelope.type !== "INCIDENT_CLEAR") return null
    return {
        runId: envelope.runId,
        commandId: envelope.commandId,
        commandSequence: envelope.commandSequence,
        toEntityId: envelope.toEntityId,
        type: envelope.type,
        incidentId: envelope.payload.incidentId,
    }
}

/** Server-side signing at dispatch: the worker holds COMMAND_SIGNING_SECRET,
 *  the actor runtime may not. Wrap the controller outbox list with
 *  `signControllerEntries(entries, f => commandProof(secret, f))`. */
export function signControllerEntries(entries: OutboxEntry[], sign: (fields: CommandProofFields) => string): OutboxEntry[] {
    return entries.map(e => {
        const fields = commandProofFields(e.envelope)
        if (!fields) return e
        const authorization = sign(fields)
        return authorization === (e.envelope as { authorization: string }).authorization ? e : { ...e, envelope: { ...e.envelope, authorization } as ProtocolEnvelope }
    })
}
