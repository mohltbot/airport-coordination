// Run initialization saga (Task 2). Each step is recorded in SimulationActor before the next
// starts, and every actor call is idempotent, so a crashed initializer resumes where it stopped.
import {
    entityActorId,
    type AirportState,
    type DomainResult,
    type FlightState,
    type InitStep,
    type MutationContext,
    type SimulationState,
} from "@ghost-tower/domain/contracts"
import { createWorld } from "@ghost-tower/domain/world"

export type InitDeps = {
    sim: {
        readRun(runId: string): Promise<SimulationState | null>
        recordInitStep(runId: string, step: InitStep): Promise<string[]>
    }
    airport(actorId: string): { initialize(context: MutationContext, state: AirportState): Promise<DomainResult> }
    flight(actorId: string): { initialize(context: MutationContext, state: FlightState): Promise<DomainResult> }
    // Task 5 hook: provision/reconnect the run's Relay identities before READY.
    registerIdentities?: (run: SimulationState) => Promise<void>
}

export type InitReport = { runId: string; steps: InitStep[]; results: { entityId: string; outcome: DomainResult["outcome"] }[] }

export async function initializeRun(deps: InitDeps, runId: string, wallNowMs = Date.now()): Promise<InitReport> {
    const run = await deps.sim.readRun(runId)
    if (!run) throw new Error(`NOT_FOUND: run ${runId}`)
    if (run.phase !== "STARTING" && !run.initialization.steps.includes("READY")) throw new Error(`WRONG_PHASE: run is ${run.phase}`)
    let steps = [...run.initialization.steps] as InitStep[]
    const results: InitReport["results"] = []
    const record = async (step: InitStep) => {
        if (!steps.includes(step)) steps = (await deps.sim.recordInitStep(runId, step)) as InitStep[]
    }
    // Initialization runs before any worker lease exists; epoch 0 is below every worker epoch.
    const context: MutationContext = { runId, workerEpoch: 0, leaseToken: `init-${runId}`, simNowSec: 0, wallNowMs, operationId: `init-${runId}` }
    const world = createWorld(run.config, { runId, operationId: context.operationId }, run.liveTrafficSeed)
    await record("WORLD_CREATED")
    if (!steps.includes("AIRPORTS_INITIALIZED")) {
        for (const a of world.airports) {
            const r = await deps.airport(entityActorId(runId, a.entityId)).initialize(context, a)
            if (r.outcome === "REJECTED") throw new Error(`${r.code}: ${a.entityId} initialize`)
            results.push({ entityId: a.entityId, outcome: r.outcome })
        }
        await record("AIRPORTS_INITIALIZED")
    }
    if (!steps.includes("FLIGHTS_INITIALIZED")) {
        for (const f of world.flights) {
            const r = await deps.flight(entityActorId(runId, f.entityId)).initialize(context, f)
            if (r.outcome === "REJECTED") throw new Error(`${r.code}: ${f.entityId} initialize`)
            results.push({ entityId: f.entityId, outcome: r.outcome })
        }
        await record("FLIGHTS_INITIALIZED")
    }
    if (deps.registerIdentities && !steps.includes("IDENTITIES_REGISTERED")) {
        await deps.registerIdentities(run)
        await record("IDENTITIES_REGISTERED")
    }
    await record("READY")
    return { runId, steps, results }
}
