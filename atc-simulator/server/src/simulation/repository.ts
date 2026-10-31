// WorkerRepository over the generated Terse clients (server/generated, from
// `bun run actors:generate`). Actor IDs always come from entityActorId().
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {
    airportEntityId,
    entityActorId,
    flightEntityId,
    type AirportId,
    type AirportState,
    type EntityId,
    type FlightState,
    type MutationContext,
    type OutboxEntry,
    type ReceivedEnvelope,
    type SimulationState,
    type WorkerLease,
} from "@ghost-tower/domain/contracts"
import { SIMULATION_ACTOR_ID } from "@ghost-tower/domain/constants"
import { signControllerEntries } from "@ghost-tower/domain/command-ledger"
import { commandProof } from "../relay/router.ts"
import type { SimulationClockApi } from "./clock.ts"
import type { OutboxAttempt, WorkerRepository } from "./worker.ts"

type AnyFn = (...args: any[]) => Promise<any>
type Client = Record<string, AnyFn>
type Generated = { actors: Record<string, { get(id: string): Client }> }

const missing = (name: string) => async () => {
    throw new Error(`${name} is not on the generated client; regenerate with bun run actors:generate`)
}

function entity<S extends AirportState | FlightState>(client: Client, label: string) {
    return {
        async read(): Promise<S> {
            const s = (await client.read!()) as S | null
            if (!s) throw new Error(`STALE_STATE: ${label} is not initialized`)
            return s
        },
        advance: client.advance ?? missing("advance"),
        receive: client.receive ?? missing("receive"),
        claimWork: client.claimWork ?? missing("claimWork"),
        commitDecision: client.commitDecision ?? missing("commitDecision"),
        validateClearance: client.validateClearance ?? missing("validateClearance"),
        recordTouchdown: client.recordTouchdown ?? missing("recordTouchdown"),
        applyApproachGuard: client.applyApproachGuard ?? missing("applyApproachGuard"),
        configureNegotiation: client.configureNegotiation,
        // Actor signature: (context, messageId, transportMessageId|null, attemptCount, nextAttemptAtWallMs).
        async markTransportAccepted(context: MutationContext, attempt: OutboxAttempt) {
            await client.markTransportAccepted!(context, attempt.messageId, attempt.transportMessageId, attempt.attemptCount, attempt.nextAttemptAtWallMs)
        },
    }
}

// commandSecret signs controller envelopes at dispatch (router rejects unsigned INCIDENT_* as UNAUTHORIZED).
export function workerRepositoryFrom(generated: Generated, simulationActorId = SIMULATION_ACTOR_ID, commandSecret: string | null = null): WorkerRepository {
    const { actors } = generated
    if (!actors.SimulationActor || !actors.AirportActor || !actors.FlightActor) throw new Error("generated client lacks SimulationActor/AirportActor/FlightActor")
    const sim = actors.SimulationActor.get(simulationActorId)
    const pick = (...names: string[]) => names.map(n => sim[n]).find(Boolean)
    const receiveController = pick("receiveController")
    const listController = pick("controllerOutbox", "listControllerOutbox")
    const recordController = pick("recordControllerAttempt", "recordControllerOutboxAttempt")
    return {
        simulation: sim as unknown as SimulationClockApi,
        airport: (runId: string, airportId: AirportId) =>
            entity<AirportState>(actors.AirportActor!.get(entityActorId(runId, airportEntityId(airportId))), `airport ${airportId}`) as never,
        flight: (runId: string, flightId: string) => entity<FlightState>(actors.FlightActor!.get(entityActorId(runId, flightEntityId(flightId))), `flight ${flightId}`) as never,
        async entities(runId: string): Promise<EntityId[]> {
            const run = (await sim.readRun!(runId)) as SimulationState | null
            if (!run) throw new Error(`WRONG_RUN: unknown run ${runId}`)
            return run.entities.map(e => e.entityId)
        },
        async runSpeed(runId: string): Promise<number> {
            const run = (await sim.readRun!(runId)) as SimulationState | null
            return run?.config.speed ?? 5
        },
        receiveController: receiveController ? (lease: WorkerLease, m: ReceivedEnvelope) => receiveController(lease, m) : undefined,
        controllerOutbox:
            listController && recordController
                ? {
                      list: async (lease: WorkerLease) => {
                          const entries = (await listController(lease)) as OutboxEntry[]
                          return commandSecret ? signControllerEntries(entries, f => commandProof(commandSecret, f)) : entries
                      },
                      recordAttempt: (lease: WorkerLease, attempt: OutboxAttempt) => recordController(lease, attempt),
                  }
                : undefined,
    }
}

export async function loadWorkerRepository(env: Record<string, string | undefined> = process.env): Promise<WorkerRepository> {
    const path = resolve(env.GHOST_TOWER_GENERATED_CLIENT ?? resolve(import.meta.dir, "../../generated/index.js"))
    if (!existsSync(path)) throw new Error(`generated actor client not found at ${path}; run bun run actors:generate`)
    const mod = (await import(path)) as Generated
    const secret = env.COMMAND_SIGNING_SECRET?.trim() || null
    if (!secret) console.warn("COMMAND_SIGNING_SECRET is not set; incident commands will be rejected as UNAUTHORIZED")
    return workerRepositoryFrom(mod, env.SIMULATION_ACTOR_ID ?? SIMULATION_ACTOR_ID, secret)
}
