// Module-level controller command ledger for SimulationActor (Task 3). Wraps
// packages/domain/src/command-ledger on the root aggregate. Terse 0.14.9:
// sync methods on an actor class throw, so the logic lives here.
import type {
    CommandReceipt,
    ControllerPrincipal,
    DomainResult,
    OutboxEntry,
    ReceivedEnvelope,
    SimulationRootState,
    WorkerLease,
} from "@ghost-tower/domain/contracts"
import {
    listControllerOutbox,
    receiveControllerMessage,
    recordControllerOutboxAttempt,
    refreshDelayedCommands,
    submitCommandToLedger,
    type CommandProofFields,
    type ControllerOutboxAttempt,
} from "@ghost-tower/domain/command-ledger"
import { RunError, activeRun, requireLease } from "./simulation.js"

const withRun = (root: SimulationRootState, run: SimulationRootState["runs"][string]): SimulationRootState => ({ ...root, runs: { ...root.runs, [run.runId]: run } })

/** Same proof as server/src/relay/router.ts commandProof: "v1." + hex HMAC-SHA256 of the joined fields. */
export async function signCommandProof(secret: string, f: CommandProofFields): Promise<string> {
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const input = [f.runId, f.commandId, f.commandSequence, f.toEntityId, f.type, f.incidentId].join("|")
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(input)))
    return `v1.${Array.from(sig, b => b.toString(16).padStart(2, "0")).join("")}`
}

function signingSecret(): string | null {
    const env = typeof process !== "undefined" ? process.env : undefined
    const s = env?.COMMAND_SIGNING_SECRET?.trim()
    return s ? s : null
}

/** submitCommand: dedup, per-target sequence, envelope persisted in the
 *  controller outbox (parked behind any unresolved command for the same target). */
export async function submitLedgerCommand(
    root: SimulationRootState,
    command: unknown,
    principal: ControllerPrincipal,
    nowMs: number,
    secret: string | null = signingSecret(),
): Promise<{ root: SimulationRootState; receipt: CommandReceipt }> {
    const runId = (command as { runId?: unknown } | null)?.runId
    if (typeof runId !== "string") throw new RunError("INVALID_PAYLOAD", "command.runId is required")
    const run = activeRun(root, runId)
    // The sequence the ledger will assign; actor methods are serialized, so it cannot move.
    const c = command as { commandId?: string; type?: string; payload?: { target?: string; incidentId?: string } }
    const target = c.payload?.target ?? ""
    const fields: CommandProofFields = {
        runId,
        commandId: c.commandId ?? "",
        commandSequence: (run.targetSequences[target] ?? 0) + 1,
        toEntityId: target,
        type: c.type === "INCIDENT_CLEAR" ? "INCIDENT_CLEAR" : "INCIDENT_CREATE",
        incidentId: c.payload?.incidentId ?? "",
    }
    const authorization = secret ? await signCommandProof(secret, fields) : `unsigned:${fields.commandId}`.slice(0, 512)
    const out = submitCommandToLedger(run, command, principal, { wallNowMs: nowMs, authorization })
    if (!out.ok) throw new RunError(out.code, out.message)
    return { root: out.duplicate ? root : withRun(root, out.state), receipt: out.receipt }
}

/** Worker receiveController: COMMAND_RESULT and DOMAIN_ACK addressed to the controller. */
export function receiveControllerOnRoot(root: SimulationRootState, lease: WorkerLease, message: ReceivedEnvelope, nowMs: number): { root: SimulationRootState; result: DomainResult } {
    const run = requireLease(root, lease, nowMs)
    const r = receiveControllerMessage(run, message, nowMs)
    return { root: r.state === run ? root : withRun(root, r.state), result: r.result }
}

/** Worker controllerOutbox.list. Also flips long-running commands to DELAYED. */
export function controllerOutboxOnRoot(root: SimulationRootState, lease: WorkerLease, nowMs: number, delayedAfterMs?: number): { root: SimulationRootState; entries: OutboxEntry[] } {
    const run = requireLease(root, lease, nowMs)
    const refreshed = refreshDelayedCommands(run, nowMs, delayedAfterMs)
    return { root: refreshed === run ? root : withRun(root, refreshed), entries: listControllerOutbox(refreshed) }
}

/** Worker controllerOutbox.recordAttempt: transport receipt, QUEUED to SENT. */
export function recordControllerAttemptOnRoot(root: SimulationRootState, lease: WorkerLease, attempt: ControllerOutboxAttempt, nowMs: number): SimulationRootState {
    const run = requireLease(root, lease, nowMs)
    return withRun(root, recordControllerOutboxAttempt(run, attempt, nowMs))
}
