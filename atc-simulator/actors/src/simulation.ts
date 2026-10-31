// Pure run-registry transitions for SimulationActor. Each returns a new root or throws `CODE: message`.
import { AIRPORTS, SCHEDULER_INTERVAL_MS, WORKER_LEASE_MS } from "@ghost-tower/domain/constants"
import {
    RunConfigSchema,
    airportEntityId,
    entityHandle,
    entityRole,
    flightEntityId,
    type CommandReceipt,
    type ControllerPrincipal,
    type EntityId,
    type EntityRegistration,
    type IncidentCommand,
    type InitStep,
    type PendingTick,
    type PublicSnapshot,
    type RunConfig,
    type RunDescriptor,
    type RunPhase,
    type SimulationRootState,
    type SimulationState,
    type WorkerLease,
} from "@ghost-tower/domain/contracts"

export const emptyRoot = (): SimulationRootState => ({ activeRunId: null, runs: {}, createRequests: {}, relayEventCursor: 0 })

export class RunError extends Error {
    constructor(readonly code: string, message: string) {
        super(`${code}: ${message}`)
    }
}

export const describe = (run: SimulationState): RunDescriptor => ({ runId: run.runId, phase: run.phase, config: { ...run.config } })

export function registrations(runId: string, flightCount: number): EntityRegistration[] {
    const ids: EntityId[] = [
        "controller",
        ...AIRPORTS.map(a => airportEntityId(a.airportId)),
        ...Array.from({ length: flightCount }, (_, i) => flightEntityId(`F${String(i + 1).padStart(3, "0")}`)),
    ]
    return ids.map(entityId => ({ entityId, handle: entityHandle(runId, entityId), role: entityRole(entityId) }))
}

export function newRun(runId: string, requestId: string, config: RunConfig, nowMs: number, workerEpoch = 0): SimulationState {
    return {
        runId,
        stateRevision: 1,
        createRequestId: requestId,
        config: { ...config },
        phase: "CONFIGURING",
        entities: registrations(runId, config.flightCount),
        simNowSec: 0,
        tickCounter: 0,
        pendingTick: null,
        lastCompletedTickId: null,
        commands: {},
        targetSequences: {},
        controllerOutbox: [],
        controllerInbox: {},
        initialization: { steps: [], completedAtWallMs: null },
        workerLease: null,
        workerEpoch,
        projectionVersion: 0,
        publicSnapshot: null,
        events: [{ eventIndex: 0, wallMs: nowMs, simSec: 0, type: "RUN_CREATED", summary: `Run created with ${config.flightCount} flights`, operationId: requestId }],
        operations: {},
        createdAtWallMs: nowMs,
        fencedAtWallMs: null,
    }
}

const withRun = (root: SimulationRootState, run: SimulationState): SimulationRootState => ({ ...root, runs: { ...root.runs, [run.runId]: run } })

function logEvent(run: SimulationState, nowMs: number, type: string, summary: string, operationId: string | null): SimulationState {
    const event = { eventIndex: run.events.length, wallMs: nowMs, simSec: run.simNowSec, type, summary: summary.slice(0, 240), operationId }
    return { ...run, events: [...run.events, event], stateRevision: run.stateRevision + 1 }
}

// The active, unfenced run. An old run ID is rejected before any mutation.
export function activeRun(root: SimulationRootState, runId: string): SimulationState {
    const run = root.runs[runId]
    if (!run) throw new RunError("NOT_FOUND", `unknown run ${runId}`)
    if (root.activeRunId !== runId || run.fencedAtWallMs !== null) throw new RunError("WRONG_RUN", `run ${runId} is not active`)
    return run
}

export function createRun(root: SimulationRootState, requestId: string, config: RunConfig, runId: string, nowMs: number): { root: SimulationRootState; run: SimulationState } {
    const cfg = RunConfigSchema.parse(config)
    const existingId = root.createRequests[requestId]
    if (existingId) {
        const existing = root.runs[existingId]
        if (JSON.stringify(existing.config) !== JSON.stringify(cfg)) throw new RunError("REVISION_CONFLICT", "requestId reused with a different config")
        return { root, run: existing }
    }
    let next = root
    const current = root.activeRunId ? root.runs[root.activeRunId] : null
    if (current && current.phase !== "CONFIGURING" && current.phase !== "COMPLETED") {
        throw new RunError("WRONG_PHASE", `active run is ${current.phase}; reset it first`)
    }
    // Agreed API rule: configuring again while CONFIGURING edits that run in place (same runId).
    if (current && current.phase === "CONFIGURING") {
        const edited = logEvent(
            { ...current, config: cfg, entities: registrations(current.runId, cfg.flightCount) },
            nowMs,
            "CONFIG_UPDATED",
            `Configured ${cfg.flightCount} flights, seed ${cfg.seed}, ${cfg.speed}x`,
            requestId,
        )
        next = withRun({ ...next, createRequests: { ...next.createRequests, [requestId]: current.runId } }, edited)
        return { root: next, run: edited }
    }
    const run = newRun(runId, requestId, cfg, nowMs, current?.workerEpoch ?? 0)
    next = withRun({ ...next, activeRunId: runId, createRequests: { ...next.createRequests, [requestId]: runId } }, run)
    return { root: next, run }
}

const TRANSITIONS: Record<RunPhase, RunPhase[]> = {
    CONFIGURING: ["STARTING"],
    STARTING: ["PAUSED", "RUNNING"],
    PAUSED: ["RUNNING", "COMPLETED"],
    RUNNING: ["PAUSED", "COMPLETED"],
    COMPLETED: [],
    RESETTING: [],
}

export function setRunPhase(root: SimulationRootState, runId: string, phase: RunPhase, operationId: string, nowMs: number): { root: SimulationRootState; run: SimulationState } {
    const run = activeRun(root, runId)
    if (run.operations[operationId] !== undefined || run.phase === phase) return { root, run }
    if (!TRANSITIONS[run.phase].includes(phase)) throw new RunError("WRONG_PHASE", `cannot move from ${run.phase} to ${phase}`)
    if (run.phase === "STARTING" && run.initialization.completedAtWallMs === null) throw new RunError("WRONG_PHASE", "initialization is not complete")
    const next = logEvent({ ...run, phase, operations: { ...run.operations, [operationId]: phase } }, nowMs, "PHASE", `${run.phase} to ${phase}`, operationId)
    return { root: withRun(root, next), run: next }
}

export function setSpeed(root: SimulationRootState, runId: string, speed: 1 | 5 | 10, operationId: string, nowMs: number): { root: SimulationRootState; run: SimulationState } {
    const run = activeRun(root, runId)
    if (![1, 5, 10].includes(speed)) throw new RunError("INVALID_PAYLOAD", "speed must be 1, 5 or 10")
    if (run.operations[operationId] !== undefined || run.config.speed === speed) return { root, run }
    if (run.phase === "COMPLETED" || run.phase === "RESETTING") throw new RunError("WRONG_PHASE", `cannot change speed while ${run.phase}`)
    const next = logEvent({ ...run, config: { ...run.config, speed }, operations: { ...run.operations, [operationId]: `speed:${speed}` } }, nowMs, "SPEED", `Speed ${speed}x`, operationId)
    return { root: withRun(root, next), run: next }
}

// Fence the old run and activate a fresh one in one aggregate write. Old data is kept.
export function resetRun(root: SimulationRootState, runId: string, operationId: string, newRunId: string, nowMs: number): { root: SimulationRootState; run: SimulationState } {
    const key = `reset:${operationId}`
    const done = root.createRequests[key]
    if (done) return { root, run: root.runs[done] }
    const old = activeRun(root, runId)
    const fenced = logEvent({ ...old, phase: "RESETTING", fencedAtWallMs: nowMs, workerLease: null, pendingTick: null }, nowMs, "RUN_RESET", "Run fenced by reset", operationId)
    const run = newRun(newRunId, key, old.config, nowMs, old.workerEpoch)
    const next = withRun(withRun({ ...root, activeRunId: newRunId, createRequests: { ...root.createRequests, [key]: newRunId } }, fenced), run)
    return { root: next, run }
}

export function recordInitStep(root: SimulationRootState, runId: string, step: InitStep, nowMs: number): { root: SimulationRootState; run: SimulationState } {
    const run = activeRun(root, runId)
    if (run.initialization.steps.includes(step)) return { root, run }
    if (run.phase !== "STARTING") throw new RunError("WRONG_PHASE", `initialization requires STARTING, run is ${run.phase}`)
    const initialization = { steps: [...run.initialization.steps, step], completedAtWallMs: step === "READY" ? nowMs : run.initialization.completedAtWallMs }
    const next = logEvent({ ...run, initialization }, nowMs, "INIT_STEP", step, null)
    return { root: withRun(root, next), run: next }
}

// Leases: a new epoch only after the old lease expired by this actor's own clock.
export function claimWorker(root: SimulationRootState, ownerId: string, nowMs: number, token: string): { root: SimulationRootState; lease: WorkerLease } {
    if (!root.activeRunId) throw new RunError("NOT_FOUND", "no active run")
    const run = activeRun(root, root.activeRunId)
    if (run.workerLease && run.workerLease.expiresAtWallMs > nowMs) throw new RunError("INVALID_LEASE", "another worker holds an unexpired lease")
    const lease: WorkerLease = { runId: run.runId, ownerId, epoch: run.workerEpoch + 1, token, expiresAtWallMs: nowMs + WORKER_LEASE_MS }
    const next = logEvent({ ...run, workerLease: lease, workerEpoch: lease.epoch }, nowMs, "WORKER_LEASE", `Worker epoch ${lease.epoch}`, null)
    return { root: withRun(root, next), lease }
}

export function requireLease(root: SimulationRootState, lease: WorkerLease, nowMs: number): SimulationState {
    const run = activeRun(root, lease.runId)
    const held = run.workerLease
    if (!held || held.epoch !== lease.epoch || held.token !== lease.token || held.ownerId !== lease.ownerId) throw new RunError("INVALID_LEASE", "stale worker lease")
    if (held.expiresAtWallMs <= nowMs) throw new RunError("INVALID_LEASE", "worker lease expired")
    return run
}

export function renewWorker(root: SimulationRootState, lease: WorkerLease, nowMs: number): { root: SimulationRootState; lease: WorkerLease } {
    const run = requireLease(root, lease, nowMs)
    const renewed = { ...lease, expiresAtWallMs: nowMs + WORKER_LEASE_MS }
    return { root: withRun(root, { ...run, workerLease: renewed }), lease: renewed }
}

// Persist the pending tick before dispatch; a retry returns the same tick ID and target time.
export function beginTick(root: SimulationRootState, lease: WorkerLease, nowMs: number): { root: SimulationRootState; tick: PendingTick | null } {
    const run = requireLease(root, lease, nowMs)
    if (run.pendingTick) return { root, tick: run.pendingTick }
    if (run.phase !== "RUNNING") return { root, tick: null }
    const counter = run.tickCounter + 1
    const tick: PendingTick = {
        tickId: `${run.runId}:${counter}`,
        fromSimSec: run.simNowSec,
        toSimSec: run.simNowSec + (SCHEDULER_INTERVAL_MS / 1000) * run.config.speed,
        entityIds: run.entities.filter(e => e.entityId !== "controller").map(e => e.entityId),
        acknowledgedEntityIds: [],
    }
    return { root: withRun(root, { ...run, pendingTick: tick, tickCounter: counter }), tick }
}

export function ackTickEntity(root: SimulationRootState, lease: WorkerLease, tickId: string, entityId: EntityId, nowMs: number): SimulationRootState {
    const run = requireLease(root, lease, nowMs)
    const tick = run.pendingTick
    if (!tick || tick.tickId !== tickId) throw new RunError("STALE_STATE", `tick ${tickId} is not pending`)
    if (!tick.entityIds.includes(entityId)) throw new RunError("INVALID_PAYLOAD", `${entityId} is not part of ${tickId}`)
    if (tick.acknowledgedEntityIds.includes(entityId)) return root
    return withRun(root, { ...run, pendingTick: { ...tick, acknowledgedEntityIds: [...tick.acknowledgedEntityIds, entityId] } })
}

export function completeTick(root: SimulationRootState, lease: WorkerLease, tickId: string, nowMs: number): SimulationRootState {
    const run = requireLease(root, lease, nowMs)
    if (run.lastCompletedTickId === tickId) return root
    const tick = run.pendingTick
    if (!tick || tick.tickId !== tickId) throw new RunError("STALE_STATE", `tick ${tickId} is not pending`)
    const missing = tick.entityIds.filter(e => !tick.acknowledgedEntityIds.includes(e))
    if (missing.length) throw new RunError("STALE_STATE", `${missing.length} entities have not acknowledged ${tickId}`)
    return withRun(root, { ...run, simNowSec: tick.toSimSec, pendingTick: null, lastCompletedTickId: tickId, stateRevision: run.stateRevision + 1 })
}

export function publishProjection(root: SimulationRootState, lease: WorkerLease, snapshot: PublicSnapshot, nowMs: number): SimulationRootState {
    const run = requireLease(root, lease, nowMs)
    if (snapshot.runId !== run.runId) throw new RunError("WRONG_RUN", "snapshot for another run")
    const projectionVersion = run.projectionVersion + 1
    const publicSnapshot = { ...snapshot, projectionVersion, phase: run.phase, simTimeSec: run.simNowSec, config: { ...run.config } }
    return withRun(root, { ...run, projectionVersion, publicSnapshot })
}

// Command ledger (Task 7 extends: proof signing and the controller outbox envelope).
function contentHash(command: IncidentCommand): string {
    return JSON.stringify(command)
}

export function submitCommand(root: SimulationRootState, command: IncidentCommand, principal: ControllerPrincipal, messageId: string, nowMs: number): { root: SimulationRootState; receipt: CommandReceipt } {
    const run = activeRun(root, command.runId)
    if (principal.runId !== run.runId) throw new RunError("UNAUTHORIZED", "principal is scoped to another run")
    const existing = run.commands[command.commandId]
    if (existing) {
        if (existing.contentHash !== contentHash(command)) throw new RunError("REVISION_CONFLICT", "commandId reused with different contents")
        return { root, receipt: existing.receipt }
    }
    const target = command.payload.target
    const commandSequence = (run.targetSequences[target] ?? 0) + 1
    const receipt: CommandReceipt = { runId: run.runId, commandId: command.commandId, status: "QUEUED", incidentId: command.payload.incidentId, code: null, resultingRevision: null }
    const entry = { command, principal, commandSequence, target, contentHash: contentHash(command), messageId, receipt, submittedAtWallMs: nowMs, updatedAtWallMs: nowMs }
    const next = logEvent(
        { ...run, commands: { ...run.commands, [command.commandId]: entry }, targetSequences: { ...run.targetSequences, [target]: commandSequence } },
        nowMs,
        command.type,
        `${command.type} ${target} #${commandSequence}`,
        command.commandId,
    )
    return { root: withRun(root, next), receipt }
}
