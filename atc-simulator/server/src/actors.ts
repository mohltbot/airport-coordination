// SimulationBackend: what the gateway needs from the simulation. Two implementations:
// - ActorBackend (this file): typed ActorRepository over the generated Terse clients. Commands are
//   persisted into the SimulationActor ledger/outbox; the worker sends them through Relay. The gateway
//   never calls an airport or flight apply/resolve method.
// - FixtureBackend (fixture.ts): GHOST_TOWER_DEV_FIXTURE=1 development data for early UI work.
import { existsSync } from "node:fs"
import type {
    AirportState,
    CommandReceipt,
    ControllerPrincipal,
    FlightState,
    IncidentCommand,
    PublicSnapshot,
    RunConfig,
    RunDescriptor,
    RunPhase,
} from "@ghost-tower/domain/contracts"
import type { AppConfig } from "./config.ts"
import { fail, toApiFailure } from "./errors.ts"

export type Health = PublicSnapshot["health"]
export type LifecycleAction = "start" | "pause" | "resume"

export interface SimulationBackend {
    readonly mode: "fixture" | "actors"
    activeRun(): Promise<RunDescriptor | null>
    getRun(runId: string): Promise<RunDescriptor | null>
    /** CONFIGURING active run: replace config in place (same runId). No active run: create. Otherwise 409 RUN_ACTIVE. */
    createRun(requestId: string, config: RunConfig): Promise<RunDescriptor>
    lifecycle(runId: string, action: LifecycleAction, operationId: string): Promise<RunDescriptor>
    setSpeed(runId: string, speed: RunConfig["speed"], operationId: string): Promise<RunDescriptor>
    /** Fence the run and return the fresh CONFIGURING run. */
    resetRun(runId: string, operationId: string): Promise<RunDescriptor>
    submitCommand(command: IncidentCommand, principal: ControllerPrincipal): Promise<CommandReceipt>
    readCommand(runId: string, commandId: string): Promise<CommandReceipt | null>
    /** Newest public snapshot for the run; the hub stamps projectionVersion and serverWallTimeMs. */
    readSnapshot(runId: string): Promise<PublicSnapshot | null>
    health(): Promise<Health>
}

// ---------------------------------------------------------------- ActorRepository

/** SimulationActor methods from plan §3, plus the two run reads the gateway needs (see report). */
export interface SimulationActorApi {
    createRun(requestId: string, config: RunConfig): Promise<RunDescriptor>
    setRunPhase(runId: string, phase: RunPhase, operationId: string): Promise<RunDescriptor>
    setSpeed(runId: string, speed: 1 | 5 | 10, operationId: string): Promise<RunDescriptor>
    resetRun(runId: string, operationId: string): Promise<RunDescriptor>
    submitCommand(command: IncidentCommand, principal: ControllerPrincipal): Promise<CommandReceipt>
    readCommand(runId: string, commandId: string): Promise<CommandReceipt | null>
    readPublic(runId: string): Promise<PublicSnapshot | null>
    readActiveRun?(): Promise<RunDescriptor | null>
    readRun?(runId: string): Promise<RunDescriptor | null>
}
export interface EntityActorApi<S> {
    read(): Promise<S>
}

type GeneratedActors = {
    SimulationActor: { get(id: string): SimulationActorApi }
    AirportActor?: { get(id: string): EntityActorApi<AirportState> }
    FlightActor?: { get(id: string): EntityActorApi<FlightState> }
}

export class ActorRepository {
    private constructor(
        private readonly actors: GeneratedActors,
        private readonly simulationActorId: string,
    ) {}

    /** Loads server/generated (run `bun run actors:generate`). Returns null when it is not generated yet. */
    static async load(config: AppConfig): Promise<ActorRepository | null> {
        if (!existsSync(config.generatedClientPath)) return null
        const mod = (await import(config.generatedClientPath)) as { actors?: GeneratedActors }
        if (!mod.actors?.SimulationActor) return null
        return new ActorRepository(mod.actors, config.simulationActorId)
    }

    simulation(): SimulationActorApi {
        return this.actors.SimulationActor.get(this.simulationActorId)
    }
    airport(runId: string, airportId: string): EntityActorApi<AirportState> | null {
        return this.actors.AirportActor?.get(`${runId}/airport/${airportId}`) ?? null
    }
    flight(runId: string, flightId: string): EntityActorApi<FlightState> | null {
        return this.actors.FlightActor?.get(`${runId}/flight/${flightId}`) ?? null
    }
}

// ---------------------------------------------------------------- ActorBackend

const LOCKED: ReadonlySet<RunPhase> = new Set(["STARTING", "RUNNING", "PAUSED", "COMPLETED"])
const PHASE_FOR: Record<LifecycleAction, RunPhase> = { start: "STARTING", pause: "PAUSED", resume: "RUNNING" }

export class ActorBackend implements SimulationBackend {
    readonly mode = "actors" as const
    private lastOk = 0
    private lastError: string | null = null

    constructor(
        private readonly repo: ActorRepository | null,
        private readonly config: AppConfig,
    ) {}

    private sim(): SimulationActorApi {
        if (!this.repo) throw fail(503, "ACTORS_UNAVAILABLE", "Actor client not generated yet. Run bun run actors:generate.", true)
        return this.repo.simulation()
    }

    private async call<T>(fn: (sim: SimulationActorApi) => Promise<T>): Promise<T> {
        const sim = this.sim()
        try {
            const out = await fn(sim)
            this.lastOk = Date.now()
            this.lastError = null
            const maybe = out as { ok?: boolean } | null
            if (maybe && typeof maybe === "object" && maybe.ok === false) throw toApiFailure(maybe)
            return out
        } catch (err) {
            const failure = toApiFailure(err)
            if (failure.status >= 500) this.lastError = failure.message
            throw failure
        }
    }

    async activeRun() {
        return this.call(sim => (sim.readActiveRun ? sim.readActiveRun() : Promise.resolve(null)))
    }

    async getRun(runId: string) {
        return this.call(async sim => {
            if (sim.readRun) return sim.readRun(runId)
            const snap = await sim.readPublic(runId)
            return snap ? { runId: snap.runId, phase: snap.phase, config: snap.config } : null
        })
    }

    async createRun(requestId: string, config: RunConfig) {
        const active = await this.activeRun().catch(() => null)
        if (active && LOCKED.has(active.phase)) {
            throw fail(409, "RUN_ACTIVE", `Run ${active.runId.slice(0, 8)} is ${active.phase}. Reset it before configuring a new run.`)
        }
        return this.call(sim => sim.createRun(requestId, config))
    }

    async lifecycle(runId: string, action: LifecycleAction, operationId: string) {
        return this.call(sim => sim.setRunPhase(runId, PHASE_FOR[action], operationId))
    }

    async setSpeed(runId: string, speed: RunConfig["speed"], operationId: string) {
        return this.call(sim => sim.setSpeed(runId, speed, operationId))
    }

    async resetRun(runId: string, operationId: string) {
        return this.call(sim => sim.resetRun(runId, operationId))
    }

    async submitCommand(command: IncidentCommand, principal: ControllerPrincipal) {
        return this.call(sim => sim.submitCommand(command, principal))
    }

    async readCommand(runId: string, commandId: string) {
        return this.call(sim => sim.readCommand(runId, commandId))
    }

    async readSnapshot(runId: string) {
        return this.call(sim => sim.readPublic(runId))
    }

    async health(): Promise<Health> {
        const actors = !this.repo
            ? { status: "UNAVAILABLE" as const, detail: "Actor client not generated" }
            : this.lastError
              ? { status: "UNAVAILABLE" as const, detail: "Simulation actor not answering" }
              : this.lastOk
                ? { status: "READY" as const, detail: null }
                : { status: "DEGRADED" as const, detail: "Not contacted yet" }
        return {
            actors,
            relay: { status: "DEGRADED", detail: "Reported by the worker" },
            model:
                this.config.agentMode === "rules"
                    ? { status: "DEGRADED", detail: "Rules mode" }
                    : this.config.modelConfigured
                      ? { status: "READY", detail: null }
                      : { status: "UNAVAILABLE", detail: "Live mode needs OPENAI_API_KEY and OPENAI_MODEL" },
            worker: { status: "DEGRADED", detail: "Reported by the worker" },
        }
    }
}
