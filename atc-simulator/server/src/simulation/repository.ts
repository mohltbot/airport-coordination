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
        initialize: client.initialize ?? missing("initialize"),
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
        async replenishTraffic(lease: WorkerLease, connect) {
            const run = await sim.readRun!(lease.runId) as SimulationState
            if (!run?.config.continuousTraffic || run.phase !== "RUNNING") return false
            if (!sim.prepareTraffic || !sim.activateTraffic || !sim.cancelTraffic) throw new Error("continuous traffic requires regenerated actor clients")
            const flights = await Promise.all(run.entities.filter(e => e.entityId.startsWith("flight:")).map(e => actors.FlightActor!.get(entityActorId(run.runId, e.entityId as `flight:${string}`)).read!() as Promise<FlightState>))
            // Terminal legs are retained in their own actors; a fresh identity replaces them only after their outbox drains.
            const airports = await Promise.all(run.entities.filter(e => e.entityId.startsWith("airport:")).map(e => actors.AirportActor!.get(entityActorId(run.runId, e.entityId as `airport:${string}`)).read!() as Promise<AirportState>))
            const usableOrigins = airports.filter(a => !a.restrictions.arrivalsClosed && a.runways.some(r => !a.restrictions.closedRunways.includes(r.runwayId) && (r.occupiedUntilSimSec === null || r.occupiedUntilSimSec <= run.simNowSec))).map(a => a.airportId)
            const pending = await sim.prepareTraffic(lease, flights.filter(f => (f.phase === "LANDED" || f.phase === "UNRESOLVED") && f.outbox.every(e => e.acknowledged || (e.envelope.type === "DOMAIN_ACK" && e.transportMessageId !== null))).map(f => f.entityId), usableOrigins) as NonNullable<SimulationState["traffic"]>["pending"]
            if (!pending.length) return false
            for (const item of pending) {
                const ctx: MutationContext = { runId: lease.runId, workerEpoch: lease.epoch, leaseToken: lease.token, simNowSec: run.simNowSec, wallNowMs: Date.now(), operationId: item.flight.initializedByOperationId }
                const result = await actors.FlightActor!.get(entityActorId(lease.runId, item.flight.entityId)).initialize!(ctx, item.flight)
                if (result.outcome === "REJECTED") throw new Error(`traffic initialize: ${result.code}`)
            }
            const ids = [...new Set([...run.entities.map(e => e.entityId), ...(run.traffic?.retiredIds ?? []), ...pending.map(p => p.flight.entityId)])]
            await connect(ids)
            // Hosted registration can take seconds; check the selected departure runway again.
            for (const item of pending) {
                if (!item.flight.originAirportId) continue // An inbound aircraft is already airborne.
                const origin = await actors.AirportActor!.get(entityActorId(run.runId, airportEntityId(item.flight.originAirportId!))).read!() as AirportState
                if (origin.restrictions.arrivalsClosed || !origin.runways.some(r => !origin.restrictions.closedRunways.includes(r.runwayId) && (r.occupiedUntilSimSec === null || r.occupiedUntilSimSec <= run.simNowSec))) {
                    await sim.cancelTraffic(lease)
                    await connect([...run.entities.map(e => e.entityId), ...(run.traffic?.retiredIds ?? [])])
                    return false
                }
            }
            await sim.activateTraffic(lease)
            const active = await sim.readRun!(lease.runId) as SimulationState
            return active.entities.some(e => pending.some(p => p.flight.entityId === e.entityId))
        },
        airport: (runId: string, airportId: AirportId) =>
            entity<AirportState>(actors.AirportActor!.get(entityActorId(runId, airportEntityId(airportId))), `airport ${airportId}`) as never,
        flight: (runId: string, flightId: string) => entity<FlightState>(actors.FlightActor!.get(entityActorId(runId, flightEntityId(flightId))), `flight ${flightId}`) as never,
        async entities(runId: string): Promise<EntityId[]> {
            const run = (await sim.readRun!(runId)) as SimulationState | null
            if (!run) throw new Error(`WRONG_RUN: unknown run ${runId}`)
            return run.entities.map(e => e.entityId)
        },
        async messagingEntities(runId: string): Promise<EntityId[]> {
            const run = await sim.readRun!(runId) as SimulationState | null
            if (!run) throw new Error(`WRONG_RUN: unknown run ${runId}`)
            return [...new Set([...run.entities.map(e => e.entityId), ...(run.traffic?.retiredIds ?? [])])]
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
