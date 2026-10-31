// DEVELOPMENT DATA ONLY (GHOST_TOWER_DEV_FIXTURE=1). Serves tests/fixtures/public-snapshot.json so the
// UI can integrate before the actors exist. Every health entry says so, and nothing here pretends to be
// agent or Relay activity: accepted commands stay QUEUED, then DELAYED, because no Relay delivery exists.
import { createHash, randomUUID } from "node:crypto"
import { COMMAND_DELAYED_AFTER_MS } from "@ghost-tower/domain/constants"
import type { CommandReceipt, ControllerPrincipal, IncidentCommand, PublicSnapshot, RunConfig, RunDescriptor } from "@ghost-tower/domain/contracts"
import { samplePublicSnapshot } from "../../tests/fixtures.ts"
import type { Health, LifecycleAction, SimulationBackend } from "./actors.ts"
import { fail } from "./errors.ts"

const DEV = "DEV FIXTURE: sample data, not live agents or Relay"

type FixtureCommand = { receipt: CommandReceipt; hash: string; submittedAtWallMs: number }
type FixtureRun = {
    descriptor: RunDescriptor
    commands: Map<string, FixtureCommand>
    fenced: boolean
    createRequestIds: Map<string, string>
    operations: Map<string, RunDescriptor>
}

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex")

export class FixtureBackend implements SimulationBackend {
    readonly mode = "fixture" as const
    private runs = new Map<string, FixtureRun>()
    private activeRunId: string | null
    private createRequests = new Map<string, string>()

    constructor(private readonly now: () => number = Date.now) {
        const base = samplePublicSnapshot
        this.activeRunId = base.runId
        this.runs.set(base.runId, this.newRun({ runId: base.runId, phase: base.phase, config: base.config }))
    }

    private newRun(descriptor: RunDescriptor): FixtureRun {
        return { descriptor, commands: new Map(), fenced: false, createRequestIds: new Map(), operations: new Map() }
    }

    private run(runId: string): FixtureRun {
        const run = this.runs.get(runId)
        if (!run) throw fail(404, "UNKNOWN_RUN", "No run with that ID.")
        return run
    }

    private once(run: FixtureRun, operationId: string, apply: () => RunDescriptor): RunDescriptor {
        const done = run.operations.get(operationId)
        if (done) return done
        const out = apply()
        run.operations.set(operationId, out)
        return out
    }

    async activeRun() {
        return this.activeRunId ? { ...this.run(this.activeRunId).descriptor } : null
    }

    async getRun(runId: string) {
        return this.runs.get(runId)?.descriptor ?? null
    }

    async createRun(requestId: string, config: RunConfig) {
        const replay = this.createRequests.get(requestId)
        if (replay) return { ...this.run(replay).descriptor }
        const active = this.activeRunId ? this.run(this.activeRunId) : null
        if (active && active.descriptor.phase !== "CONFIGURING") {
            throw fail(409, "RUN_ACTIVE", `Run ${active.descriptor.runId.slice(0, 8)} is ${active.descriptor.phase}. Reset it before configuring a new run.`)
        }
        if (active) {
            active.descriptor = { ...active.descriptor, config }
            this.createRequests.set(requestId, active.descriptor.runId)
            return { ...active.descriptor }
        }
        const runId = randomUUID()
        this.runs.set(runId, this.newRun({ runId, phase: "CONFIGURING", config }))
        this.activeRunId = runId
        this.createRequests.set(requestId, runId)
        return { ...this.run(runId).descriptor }
    }

    async lifecycle(runId: string, action: LifecycleAction, operationId: string) {
        const run = this.run(runId)
        return this.once(run, operationId, () => {
            const phase = run.descriptor.phase
            const allowed = { start: ["CONFIGURING", "STARTING"], pause: ["RUNNING"], resume: ["PAUSED"] }[action]
            if (run.fenced || !allowed.includes(phase)) throw fail(409, "WRONG_PHASE", `Cannot ${action} a ${phase} run.`)
            // Fixture start skips identity setup and goes straight to PAUSED, like a finished init saga.
            run.descriptor = { ...run.descriptor, phase: action === "resume" ? "RUNNING" : "PAUSED" }
            return { ...run.descriptor }
        })
    }

    async setSpeed(runId: string, speed: RunConfig["speed"], operationId: string) {
        const run = this.run(runId)
        return this.once(run, operationId, () => {
            if (run.fenced) throw fail(409, "WRONG_PHASE", "Run was reset.")
            run.descriptor = { ...run.descriptor, config: { ...run.descriptor.config, speed } }
            return { ...run.descriptor }
        })
    }

    async resetRun(runId: string, operationId: string) {
        const run = this.run(runId)
        return this.once(run, operationId, () => {
            if (run.fenced || this.activeRunId !== runId) throw fail(409, "WRONG_PHASE", "Run was already reset.")
            run.fenced = true
            const next = randomUUID()
            this.runs.set(next, this.newRun({ runId: next, phase: "CONFIGURING", config: run.descriptor.config }))
            this.activeRunId = next
            return { ...this.run(next).descriptor }
        })
    }

    async submitCommand(command: IncidentCommand, _principal: ControllerPrincipal) {
        const run = this.run(command.runId)
        const h = hash(command)
        const existing = run.commands.get(command.commandId)
        if (existing) {
            if (existing.hash !== h) throw fail(409, "COMMAND_ID_CONFLICT", "commandId reused with different contents.")
            return existing.receipt
        }
        if (run.fenced || (run.descriptor.phase !== "RUNNING" && run.descriptor.phase !== "PAUSED")) {
            throw fail(409, "WRONG_PHASE", `Run is ${run.fenced ? "reset" : run.descriptor.phase}.`)
        }
        const snapshot = this.base(run)
        const target = command.payload.target
        const known = [...snapshot.airports.map(a => a.entityId), ...snapshot.flights.map(f => f.entityId)] as string[]
        if (!known.includes(target)) throw fail(404, "UNKNOWN_ENTITY", `${target} is not in this run.`)
        const receipt: CommandReceipt = {
            runId: run.descriptor.runId,
            commandId: command.commandId,
            status: "QUEUED",
            incidentId: command.payload.incidentId,
            code: null,
            resultingRevision: null,
        }
        run.commands.set(command.commandId, { receipt, hash: h, submittedAtWallMs: this.now() })
        return receipt
    }

    private receipt(c: FixtureCommand): CommandReceipt {
        // No Relay in fixture mode, so an accepted command can only become DELAYED, never APPLIED.
        if (c.receipt.status === "QUEUED" && this.now() - c.submittedAtWallMs >= COMMAND_DELAYED_AFTER_MS) {
            c.receipt = { ...c.receipt, status: "DELAYED" }
        }
        return c.receipt
    }

    async readCommand(runId: string, commandId: string) {
        const c = this.runs.get(runId)?.commands.get(commandId)
        if (c) return this.receipt(c)
        return samplePublicSnapshot.runId === runId ? (samplePublicSnapshot.commands.find(r => r.commandId === commandId) ?? null) : null
    }

    private base(run: FixtureRun): PublicSnapshot {
        const s = samplePublicSnapshot
        const { runId, phase, config } = run.descriptor
        if (runId === s.runId) return { ...s, phase, config }
        const configuring = phase === "CONFIGURING"
        return {
            ...s,
            runId,
            phase,
            config,
            simTimeSec: 0,
            airports: s.airports.map(a => ({ ...a, status: "OPEN", statusReason: null, queue: [], runways: a.runways.map(r => ({ ...r, status: "OPEN", occupiedUntilSimSec: null })) })),
            flights: configuring ? [] : s.flights.slice(0, config.flightCount),
            incidents: [],
            commands: [],
            timeline: [],
        }
    }

    async readSnapshot(runId: string): Promise<PublicSnapshot | null> {
        const run = this.runs.get(runId)
        if (!run) return null
        const base = this.base(run)
        const extra = [...run.commands.values()].sort((a, b) => a.submittedAtWallMs - b.submittedAtWallMs).map(c => this.receipt(c))
        return { ...base, commands: [...base.commands, ...extra].slice(-100), health: await this.health(), serverWallTimeMs: this.now() }
    }

    async health(): Promise<Health> {
        return {
            actors: { status: "DEGRADED", detail: DEV },
            relay: { status: "UNAVAILABLE", detail: `${DEV}; commands are not delivered` },
            model: { status: "DEGRADED", detail: DEV },
            worker: { status: "DEGRADED", detail: DEV },
        }
    }
}
