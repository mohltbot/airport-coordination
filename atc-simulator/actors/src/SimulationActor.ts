import { Actor, Persisted } from "terse-sdk/actor"
import type {
    CommandReceipt,
    ControllerPrincipal,
    EntityId,
    IncidentCommand,
    InitStep,
    PendingTick,
    PublicSnapshot,
    RunConfig,
    RunDescriptor,
    RunPhase,
    SimulationRootState,
    SimulationState,
    WorkerLease,
} from "@ghost-tower/domain/contracts"
import * as sim from "./simulation.ts"

// The stable registry: SimulationActor.get("ghost-tower"). One persisted root aggregate holds
// every run (reset adds a run, never deletes one). All transitions are pure functions in
// simulation.ts; methods only reassign the root, which persists it in one write.
export class SimulationActor extends Actor<null, null> {
    @Persisted root: SimulationRootState = sim.emptyRoot()

    async createRun(requestId: string, config: RunConfig): Promise<RunDescriptor> {
        const out = sim.createRun(this.root, requestId, config, crypto.randomUUID(), Date.now())
        this.root = out.root
        return sim.describe(out.run)
    }

    async activeRun(): Promise<RunDescriptor | null> {
        const id = this.root.activeRunId
        return id ? sim.describe(this.root.runs[id]) : null
    }

    async getRun(runId: string): Promise<RunDescriptor | null> {
        const run = this.root.runs[runId]
        return run ? sim.describe(run) : null
    }

    // Internal: full run aggregate for the server's initialization saga and tests.
    async readRun(runId: string): Promise<SimulationState | null> {
        return this.root.runs[runId] ?? null
    }

    async recordInitStep(runId: string, step: InitStep): Promise<string[]> {
        const out = sim.recordInitStep(this.root, runId, step, Date.now())
        this.root = out.root
        return out.run.initialization.steps
    }

    async setRunPhase(runId: string, phase: RunPhase, operationId: string): Promise<RunDescriptor> {
        const out = sim.setRunPhase(this.root, runId, phase, operationId, Date.now())
        this.root = out.root
        return sim.describe(out.run)
    }

    async setSpeed(runId: string, speed: 1 | 5 | 10, operationId: string): Promise<RunDescriptor> {
        const out = sim.setSpeed(this.root, runId, speed, operationId, Date.now())
        this.root = out.root
        return sim.describe(out.run)
    }

    async resetRun(runId: string, operationId: string): Promise<RunDescriptor> {
        const out = sim.resetRun(this.root, runId, operationId, crypto.randomUUID(), Date.now())
        this.root = out.root
        return sim.describe(out.run)
    }

    async submitCommand(command: IncidentCommand, principal: ControllerPrincipal): Promise<CommandReceipt> {
        const out = sim.submitCommand(this.root, command, principal, crypto.randomUUID(), Date.now())
        this.root = out.root
        return out.receipt
    }

    async readCommand(runId: string, commandId: string): Promise<CommandReceipt> {
        const entry = this.root.runs[runId]?.commands[commandId]
        if (!entry) throw new sim.RunError("NOT_FOUND", `unknown command ${commandId}`)
        return entry.receipt
    }

    async claimWorker(ownerId: string, nowWallMs: number): Promise<WorkerLease> {
        // The actor's own clock decides expiry; a caller's timestamp can only make it stricter.
        const out = sim.claimWorker(this.root, ownerId, Math.max(Date.now(), nowWallMs), crypto.randomUUID())
        this.root = out.root
        return out.lease
    }

    async renewWorker(lease: WorkerLease): Promise<WorkerLease> {
        const out = sim.renewWorker(this.root, lease, Date.now())
        this.root = out.root
        return out.lease
    }

    async beginTick(lease: WorkerLease): Promise<PendingTick | null> {
        const out = sim.beginTick(this.root, lease, Date.now())
        this.root = out.root
        return out.tick
    }

    async ackTickEntity(lease: WorkerLease, tickId: string, entityId: EntityId): Promise<void> {
        this.root = sim.ackTickEntity(this.root, lease, tickId, entityId, Date.now())
    }

    async completeTick(lease: WorkerLease, tickId: string): Promise<void> {
        this.root = sim.completeTick(this.root, lease, tickId, Date.now())
    }

    async publishProjection(lease: WorkerLease, snapshot: PublicSnapshot): Promise<void> {
        this.root = sim.publishProjection(this.root, lease, snapshot, Date.now())
    }

    async readPublic(runId: string): Promise<PublicSnapshot | null> {
        return this.root.runs[runId]?.publicSnapshot ?? null
    }

    async onMessage() {}
}
