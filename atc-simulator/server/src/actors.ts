// SimulationBackend: what the gateway needs from the simulation. Two implementations:
// - ActorBackend (this file): typed ActorRepository over the generated Terse clients. Commands are
//   persisted into the SimulationActor ledger/outbox; the worker sends them through Relay. The gateway
//   never calls an airport or flight apply/resolve method.
// - FixtureBackend (fixture.ts): GHOST_TOWER_DEV_FIXTURE=1 development data for early UI work.
import { existsSync } from "node:fs"
import { entityActorId } from "@ghost-tower/domain/contracts"
import { buildPublicSnapshot } from "@ghost-tower/domain/projections"
import { createWorld } from "@ghost-tower/domain/world"
import type {
    AirportEntityId,
    AirportState,
    CommandReceipt,
    FlightEntityId,
    ControllerPrincipal,
    FlightState,
    IncidentCommand,
    InitStep,
    LiveTrafficSeed,
    MutationContext,
    DomainResult,
    PublicSnapshot,
    RunConfig,
    RunDescriptor,
    RunPhase,
    SimulationState,
} from "@ghost-tower/domain/contracts"
import type { AppConfig } from "./config.ts"
import { fail, toApiFailure } from "./errors.ts"
import { createOpenSkySource, prepareLiveRun, type LiveTrafficSource } from "./live/opensky.ts"
import { initializeRun, type InitDeps } from "./simulation/initialize.ts"

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

/** SimulationActor methods the gateway uses (actors/src/SimulationActor.ts). Errors arrive as `CODE: message`. */
export interface SimulationActorApi {
    /** liveTrafficSeed stays on the run server-side; the config carries only the attribution. */
    createRun(requestId: string, config: RunConfig, liveTrafficSeed?: LiveTrafficSeed | null): Promise<RunDescriptor>
    activeRun(): Promise<RunDescriptor | null>
    getRun(runId: string): Promise<RunDescriptor | null>
    /** Internal aggregate: server-side only, projected before anything reaches a browser. */
    readRun(runId: string): Promise<SimulationState | null>
    setRunPhase(runId: string, phase: RunPhase, operationId: string): Promise<RunDescriptor>
    setSpeed(runId: string, speed: 1 | 5 | 10, operationId: string): Promise<RunDescriptor>
    resetRun(runId: string, operationId: string): Promise<RunDescriptor>
    submitCommand(command: IncidentCommand, principal: ControllerPrincipal): Promise<CommandReceipt>
    readCommand(runId: string, commandId: string): Promise<CommandReceipt>
    readPublic(runId: string): Promise<PublicSnapshot | null>
    recordInitStep(runId: string, step: InitStep): Promise<string[]>
}
export interface EntityActorApi<S> {
    read(): Promise<S | null>
    initialize(context: MutationContext, state: S): Promise<DomainResult>
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
    airport(runId: string, entityId: AirportEntityId): EntityActorApi<AirportState> | null {
        return this.actors.AirportActor?.get(entityActorId(runId, entityId)) ?? null
    }
    flight(runId: string, entityId: FlightEntityId): EntityActorApi<FlightState> | null {
        return this.actors.FlightActor?.get(entityActorId(runId, entityId)) ?? null
    }
    /** Ports for the Task 2 initialization saga (server/src/simulation/initialize.ts). */
    initDeps(): InitDeps {
        const { AirportActor, FlightActor } = this.actors
        if (!AirportActor || !FlightActor) throw fail(503, "ACTORS_UNAVAILABLE", "Actor client lacks AirportActor/FlightActor. Run bun run actors:generate.", true)
        return { sim: this.simulation(), airport: id => AirportActor.get(id), flight: id => FlightActor.get(id) }
    }
}

// ---------------------------------------------------------------- ActorBackend

/** Worker projections older than this are stale: the gateway gathers from the actors instead. */
const PUBLISHED_FRESH_MS = 4_000
const ACTOR_PROBE_MS = 5_000

/** The domain projection copies three config fields; the browser also needs airportNetwork and continuousTraffic. */
const withFullConfig = (run: SimulationState, snapshot: PublicSnapshot): PublicSnapshot => ({ ...snapshot, config: { ...run.config } })

const LOCKED: ReadonlySet<RunPhase> = new Set(["STARTING", "RUNNING", "PAUSED"])
const PHASE_FOR: Record<LifecycleAction, RunPhase> = { start: "STARTING", pause: "PAUSED", resume: "RUNNING" }

export class ActorBackend implements SimulationBackend {
    readonly mode = "actors" as const
    private lastOk = 0
    private lastError: string | null = null
    private starting = new Map<string, Promise<RunDescriptor>>()

    constructor(
        private readonly repo: ActorRepository | null,
        private readonly config: AppConfig,
        private readonly liveTraffic: LiveTrafficSource | null = createOpenSkySource({ dataDir: config.dataDir }),
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
        return this.call(sim => sim.activeRun())
    }

    async getRun(runId: string) {
        return this.call(sim => sim.getRun(runId))
    }

    async createRun(requestId: string, config: RunConfig) {
        const active = await this.activeRun().catch(() => null)
        if (active && LOCKED.has(active.phase)) {
            throw fail(409, "RUN_ACTIVE", `Run ${active.runId.slice(0, 8)} is ${active.phase}. Reset it before configuring a new run.`)
        }
        // US runs: one OpenSky fetch (or the .data cache), at most 5 s; any failure keeps the seeded world.
        const live = await prepareLiveRun(config, this.liveTraffic)
        return this.call(sim => sim.createRun(requestId, live.config, live.seed))
    }

    async lifecycle(runId: string, action: LifecycleAction, operationId: string) {
        if (action !== "start") return this.call(sim => sim.setRunPhase(runId, PHASE_FOR[action], operationId))
        // One start per run in this process; a retry with the same operationId joins it.
        let pending = this.starting.get(runId)
        if (!pending) {
            pending = this.start(runId, operationId).finally(() => this.starting.delete(runId))
            this.starting.set(runId, pending)
        }
        return pending
    }

    /**
     * Design §8 "Finish initialization and start simulation": CONFIGURING -> STARTING, run the
     * resumable init saga (every actor initialize is idempotent), then STARTING -> PAUSED like the
     * fixture. Retrying Start on a half-initialized run resumes the saga instead of making new flights.
     */
    private async start(runId: string, operationId: string): Promise<RunDescriptor> {
        let run = await this.call(sim => sim.getRun(runId))
        if (!run) throw fail(404, "UNKNOWN_RUN", "No run with that ID.")
        if (run.phase === "CONFIGURING") run = await this.call(sim => sim.setRunPhase(runId, "STARTING", operationId))
        if (run.phase !== "STARTING") return run
        const deps = this.repo?.initDeps()
        if (!deps) throw fail(503, "ACTORS_UNAVAILABLE", "Actor client not generated yet. Run bun run actors:generate.", true)
        await this.call(() => initializeRun(deps, runId))
        return this.call(sim => sim.setRunPhase(runId, "PAUSED", `${operationId}:ready`))
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
        try {
            return await this.call(sim => sim.readCommand(runId, commandId))
        } catch (err) {
            if ((err as { status?: number }).status === 404) return null
            throw err
        }
    }

    /**
     * Worker-published snapshot with fresh run phase/config and ledger receipts merged in, so command
     * updates show while paused. Before the worker publishes (CONFIGURING, worker down), gather a
     * projection straight from the actors with the domain redaction functions.
     */
    async readSnapshot(runId: string): Promise<PublicSnapshot | null> {
        // Fast path, one SimulationActor read: a fresh worker projection already carries phase,
        // config and receipts (publishProjection stamps them from the run at publish time).
        const published = await this.call(sim => sim.readPublic(runId))
        if (published && published.phase !== "CONFIGURING" && Date.now() - published.serverWallTimeMs <= PUBLISHED_FRESH_MS) {
            const actors = (await this.health(published)).actors
            return { ...published, health: { ...published.health, actors } }
        }
        const run = await this.call(sim => sim.readRun(runId))
        if (!run) return published
        const receipts = Object.values(run.commands)
            .sort((a, b) => a.submittedAtWallMs - b.submittedAtWallMs)
            .slice(-100)
            .map(e => e.receipt)
        const health = await this.health(published)
        const fresh = published && Date.now() - published.serverWallTimeMs <= PUBLISHED_FRESH_MS
        if (published && fresh && run.phase !== "CONFIGURING") {
            return { ...published, phase: run.phase, config: run.config, commands: receipts, health: { ...published.health, actors: health.actors } }
        }
        return this.gather(run, health)
    }

    private async gather(run: SimulationState, health: Health): Promise<PublicSnapshot> {
        const repo = this.repo!
        const airports: AirportState[] = []
        const flights: FlightState[] = []
        if (run.phase === "CONFIGURING") {
            // Nothing is initialized before Start; show the deterministic seeded world it will create.
            const world = createWorld(run.config, { runId: run.runId, operationId: `init-${run.runId}` }, run.liveTrafficSeed)
            return withFullConfig(run, buildPublicSnapshot({
                run,
                airports: world.airports,
                flights: world.flights,
                wallNowMs: Date.now(),
                projectionVersion: run.projectionVersion,
                health,
                agentMode: this.config.agentMode,
            }))
        }
        await Promise.all(
            run.entities.map(async e => {
                if (e.entityId === "controller") return
                if (e.entityId.startsWith("airport:")) {
                    const a = await repo.airport(run.runId, e.entityId as AirportEntityId)?.read().catch(() => null)
                    if (a) airports.push(a)
                } else {
                    const f = await repo.flight(run.runId, e.entityId as FlightEntityId)?.read().catch(() => null)
                    if (f) flights.push(f)
                }
            }),
        )
        return withFullConfig(run, buildPublicSnapshot({
            run,
            airports,
            flights,
            wallNowMs: Date.now(),
            projectionVersion: run.projectionVersion,
            health,
            agentMode: this.config.agentMode,
        }))
    }

    /**
     * Real dependency status. Actors: probed when not contacted in the last few seconds. Worker,
     * Relay and model: taken from the worker's newest published projection, which goes stale (and
     * reads UNAVAILABLE) when the worker stops publishing.
     */
    async health(published?: PublicSnapshot | null): Promise<Health> {
        if (this.repo && Date.now() - this.lastOk > ACTOR_PROBE_MS) {
            await this.call(sim => sim.activeRun()).catch(() => {})
        }
        const actors = !this.repo
            ? { status: "UNAVAILABLE" as const, detail: "Actor client not generated" }
            : this.lastError
              ? { status: "UNAVAILABLE" as const, detail: "Simulation actor not answering" }
              : { status: "READY" as const, detail: null }
        if (published === undefined && this.repo && !this.lastError) {
            const active = await this.simOrNull()?.activeRun().catch(() => null)
            published = active ? await this.simOrNull()!.readPublic(active.runId).catch(() => null) : null
        }
        const model: Health["model"] =
            this.config.agentMode === "rules"
                ? { status: "DEGRADED", detail: "Rules mode" }
                : this.config.modelConfigured
                  ? { status: "READY", detail: null }
                  : { status: "UNAVAILABLE", detail: "Live mode needs OPENAI_API_KEY and OPENAI_MODEL" }
        if (!published) {
            return {
                actors,
                relay: { status: "UNAVAILABLE", detail: "No worker connected" },
                model,
                worker: { status: "UNAVAILABLE", detail: "No worker projection published yet" },
            }
        }
        const ageSec = Math.round((Date.now() - published.serverWallTimeMs) / 1000)
        if (ageSec * 1000 > PUBLISHED_FRESH_MS) {
            return {
                actors,
                relay: { status: "DEGRADED", detail: `Worker last reported ${ageSec}s ago` },
                model: published.health.model ?? model,
                worker: { status: "UNAVAILABLE", detail: `RECOVERING: no worker projection for ${ageSec}s` },
            }
        }
        return { ...published.health, actors }
    }

    private simOrNull(): SimulationActorApi | null {
        return this.repo?.simulation() ?? null
    }
}
