// Restartable simulation worker (design §3 Worker, §4 clock, §7 recovery; plan Task 8).
//
// The worker keeps no authoritative state. Everything it needs to resume lives in
// actors: the run's pendingTick and worker lease in SimulationActor, jobs and
// outboxes in each entity actor, touchdown receipts in AirportActor.
//
// Startup (and after any fence or run reset):
//   1. claimWorker -> a new fencing epoch for the active run. SimulationActor grants
//      it only after the previous lease expired, so two live epochs never advance
//      one run. Every later mutation carries (runId, epoch, token).
//   2. reconcileLandings: finish any flight whose airport receipt exists.
//   3. connect Relay identities and attach the verified router.
//   4. loops: tick every 250 ms (resumes the exact pending tick first), renew the
//      lease every 3 s, agent jobs, outbox dispatch, projection publish.
// A fenced or reset run ends the lease loop; nothing from the old lease is applied
// to the new run because every call is checked against the lease by the actors.
import os from "node:os"
import type {
    AirportId,
    AirportState,
    FlightState,
    ClaimedJob,
    DecisionCommit,
    DependencyHealth,
    DomainResult,
    EntityId,
    MutationContext,
    OutboxEntry,
    ReceivedEnvelope,
    RelayTransport,
    WorkerLease,
} from "@ghost-tower/domain/contracts"
import { SCHEDULER_INTERVAL_MS, WORKER_RENEW_MS } from "@ghost-tower/domain/constants"
import { AgentRunner, pendingWorkFromJobs, type AgentEntityId, type AgentRunnerOptions, type PendingWork } from "../agents/runner.ts"
import type { AgentModel, FallbackPolicy } from "../agents/model.ts"
import { attachRouter, type RouteEvent } from "../relay/router.ts"
import { registrationsFor } from "../relay/transport.ts"
import { FencedError, runTick, type AirportSimApi, type FlightSimApi, type SimulationRepository, type TickOutcome } from "./clock.ts"
import { reconcileLandings } from "./landing.ts"

// ------------------------------------------------------------ ports

export interface EntityWorkApi {
    receive(context: MutationContext, message: ReceivedEnvelope): Promise<DomainResult>
    claimWork(context: MutationContext): Promise<ClaimedJob | null>
    commitDecision(context: MutationContext, commit: DecisionCommit): Promise<DomainResult>
    /** Persist a transport receipt and the next retry time (OutboxPort.recordAttempt). */
    markTransportAccepted(context: MutationContext, attempt: OutboxAttempt): Promise<void>
}

export type OutboxAttempt = { messageId: string; transportMessageId: string | null; attemptCount: number; nextAttemptAtWallMs: number }

export interface WorkerRepository extends SimulationRepository {
    airport(runId: string, airportId: AirportId): AirportSimApi & EntityWorkApi
    flight(runId: string, flightId: string): FlightSimApi & EntityWorkApi
    /** Registered entity IDs of the run (airports, flights, controller). */
    entities(runId: string): Promise<EntityId[]>
    /** Controller ledger inbox (COMMAND_RESULT, DOMAIN_ACK addressed to the controller). */
    receiveController?(lease: WorkerLease, message: ReceivedEnvelope): Promise<DomainResult>
    /** Controller ledger outbox in SimulationActor (INCIDENT_* commands). */
    controllerOutbox?: {
        list(lease: WorkerLease): Promise<OutboxEntry[]>
        recordAttempt(lease: WorkerLease, attempt: OutboxAttempt): Promise<void>
    }
}

export type WorkerStatus = { state: "STARTING" | "WAITING_FOR_LEASE" | "RECOVERING" | "RUNNING" | "STOPPED"; detail: string | null; lease: WorkerLease | null; simNowSec: number }

export type WorkerDeps = {
    repo: WorkerRepository
    model: AgentModel
    fallback: FallbackPolicy
    transport?: RelayTransport | null
    commandSecret?: string | null
    /** Task 5 outbox dispatcher: send due entries of this run with the lease's context. */
    dispatchOutboxes?: (lease: WorkerLease, context: (operationId: string) => MutationContext) => Promise<void>
    /** Task 7 projection: gather, redact and publishProjection. outcome is null while paused. */
    publish?: (lease: WorkerLease, outcome: TickOutcome | null, status: WorkerStatus) => Promise<void>
    onStatus?: (status: WorkerStatus) => void
    onDecision?: AgentRunnerOptions["onDecision"]
    onRoute?: (event: RouteEvent) => void
    log?: (line: string) => void
    now?: () => number
    ownerId?: string
    tickIntervalMs?: number
    renewIntervalMs?: number
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

// SimulationActor errors that mean "this lease is no longer the owner of this run".
const FENCE_PATTERN = /INVALID_LEASE|WRONG_RUN|WRONG_PHASE|fenced|expired lease|stale epoch/i

export class SimulationWorker {
    readonly ownerId: string
    private stopped = false
    private status: WorkerStatus = { state: "STARTING", detail: null, lease: null, simNowSec: 0 }
    private stopLease: (() => void) | null = null
    private supervisor: Promise<void> | null = null
    private readonly now: () => number

    constructor(private readonly deps: WorkerDeps) {
        this.now = deps.now ?? Date.now
        this.ownerId = deps.ownerId ?? `worker-${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
    }

    current(): WorkerStatus {
        return this.status
    }

    start(): Promise<void> {
        this.supervisor ??= this.supervise()
        return Promise.resolve()
    }

    async stop(): Promise<void> {
        this.stopped = true
        this.stopLease?.()
        await this.supervisor
        this.setStatus({ state: "STOPPED", detail: null })
    }

    private setStatus(patch: Partial<WorkerStatus>) {
        this.status = { ...this.status, ...patch }
        this.deps.onStatus?.(this.status)
    }

    private log(line: string) {
        this.deps.log?.(`[worker ${this.ownerId}] ${line}`)
    }

    private async supervise(): Promise<void> {
        while (!this.stopped) {
            let lease: WorkerLease
            try {
                this.setStatus({ state: "WAITING_FOR_LEASE", detail: null, lease: null })
                lease = await this.deps.repo.simulation.claimWorker(this.ownerId, this.now())
            } catch (err) {
                // No active run yet, or the previous worker's lease has not expired.
                this.setStatus({ state: "WAITING_FOR_LEASE", detail: errText(err) })
                await sleep(1_000)
                continue
            }
            try {
                await this.runLease(lease)
            } catch (err) {
                this.log(`lease ${lease.epoch} ended: ${errText(err)}`)
                await sleep(500)
            }
        }
    }

    // Mutation context for non-tick calls under this lease.
    private context(lease: WorkerLease, operationId: string): MutationContext {
        return {
            runId: lease.runId,
            workerEpoch: lease.epoch,
            leaseToken: lease.token,
            simNowSec: this.status.simNowSec,
            wallNowMs: this.now(),
            operationId: operationId.slice(0, 128),
        }
    }

    private async runLease(initial: WorkerLease): Promise<void> {
        const { repo } = this.deps
        let lease = initial
        const runId = lease.runId
        this.setStatus({ state: "RECOVERING", detail: `epoch ${lease.epoch}: resuming run ${runId.slice(0, 8)}`, lease })
        this.log(`claimed run ${runId} epoch ${lease.epoch}`)

        const entityIds = await repo.entities(runId)
        const airportIds = entityIds.flatMap(e => (e.startsWith("airport:") ? [e.slice(8) as AirportId] : []))
        const agentIds = entityIds.filter((e): e is AgentEntityId => e !== "controller")

        // Recovery before the first tick: a touchdown the airport recorded is final.
        const recovered = await reconcileLandings(repo, this.context(lease, `recover:${lease.epoch}`), airportIds)
        if (recovered.length) this.log(`recovered ${recovered.length} landing(s) from airport receipts`)
        // Resume sim time from the newest flight sample; beginTick owns the real clock.
        const firstFlight = agentIds.find(e => e.startsWith("flight:"))
        if (firstFlight) {
            const f = await repo.flight(runId, firstFlight.slice(7)).read()
            this.setStatus({ simNowSec: f.lastAdvancedSimSec })
        }

        // Relay: reconnect saved identities and route verified messages to actor inboxes.
        let detachRouter: (() => void) | null = null
        const transport = this.deps.transport ?? null
        if (transport) {
            await transport.connect(runId, registrationsFor(runId, entityIds))
            detachRouter = attachRouter(transport, {
                runId,
                registry: registrationsFor(runId, entityIds),
                commandSecret: this.deps.commandSecret ?? null,
                log: this.deps.onRoute,
                inbox: {
                    receive: async (entityId, message) => {
                        const ctx = this.context(lease, `recv:${message.messageId}`)
                        if (entityId === "controller") {
                            if (!repo.receiveController) throw new Error("controller inbox not wired")
                            return repo.receiveController(lease, message)
                        }
                        if (entityId.startsWith("airport:")) return repo.airport(runId, entityId.slice(8) as AirportId).receive(ctx, message)
                        return repo.flight(runId, entityId.slice(7)).receive(ctx, message)
                    },
                },
            })
        }

        const runner = new AgentRunner({
            model: this.deps.model,
            fallback: this.deps.fallback,
            context: op => this.context(lease, op),
            onDecision: this.deps.onDecision,
            onError: e => this.log(`agent ${e.entityId} ${e.stage}: ${e.message}`),
            source: {
                pendingWork: async () => {
                    const now = this.now()
                    const states = await readAll(repo, runId, agentIds)
                    return states.map(s => pendingWorkFromJobs(s.entityId, s.jobs, now)).filter((w): w is PendingWork => w !== null)
                },
                claimWork: (id, ctx) => (id.startsWith("airport:") ? repo.airport(runId, id.slice(8) as AirportId) : repo.flight(runId, id.slice(7))).claimWork(ctx),
                commitDecision: (id, ctx, commit) =>
                    (id.startsWith("airport:") ? repo.airport(runId, id.slice(8) as AirportId) : repo.flight(runId, id.slice(7))).commitDecision(ctx, commit),
            },
        })

        await new Promise<void>(resolve => {
            const timers: ReturnType<typeof setInterval>[] = []
            let ended = false
            const end = (why: string) => {
                if (ended) return
                ended = true
                for (const t of timers) clearInterval(t)
                detachRouter?.()
                this.stopLease = null
                this.log(`leaving lease ${lease.epoch}: ${why}`)
                resolve()
            }
            this.stopLease = () => end("stopping")
            const fenced = (err: unknown) => err instanceof FencedError || FENCE_PATTERN.test(errText(err))

            // Clock. One tick in flight at a time; an error leaves the tick pending
            // and the next interval retries the same tick ID.
            let tickBusy = false
            let idlePublishAt = 0
            timers.push(
                setInterval(async () => {
                    if (tickBusy || ended) return
                    tickBusy = true
                    try {
                        const outcome = await runTick(repo, lease)
                        if (ended) return
                        if (outcome) {
                            this.setStatus({ state: "RUNNING", detail: null, simNowSec: outcome.tick.toSimSec })
                            await this.deps.publish?.(lease, outcome, this.status)
                        } else {
                            if (this.status.state === "RECOVERING") this.setStatus({ state: "RUNNING", detail: "paused" })
                            if (this.now() >= idlePublishAt) {
                                idlePublishAt = this.now() + 1_000
                                await this.deps.publish?.(lease, null, this.status)
                            }
                        }
                    } catch (err) {
                        if (fenced(err)) return end(`tick fenced: ${errText(err)}`)
                        this.setStatus({ state: "RECOVERING", detail: `tick pending: ${errText(err)}` })
                    } finally {
                        tickBusy = false
                    }
                }, this.deps.tickIntervalMs ?? SCHEDULER_INTERVAL_MS),
            )

            // Lease renewal. Losing it (expiry, newer epoch, reset run) ends this loop.
            timers.push(
                setInterval(async () => {
                    if (ended) return
                    try {
                        lease = await repo.simulation.renewWorker(lease)
                        this.setStatus({ lease })
                    } catch (err) {
                        end(`renew failed: ${errText(err)}`)
                    }
                }, this.deps.renewIntervalMs ?? WORKER_RENEW_MS),
            )

            // Agent jobs: claim only after a model slot is free (runner enforces 4 global, 1 per entity).
            let agentsBusy = false
            timers.push(
                setInterval(async () => {
                    if (agentsBusy || ended) return
                    agentsBusy = true
                    try {
                        await runner.pump()
                    } catch (err) {
                        if (fenced(err)) return end(`agents fenced: ${errText(err)}`)
                        this.log(`agents: ${errText(err)}`)
                    } finally {
                        agentsBusy = false
                    }
                }, SCHEDULER_INTERVAL_MS),
            )

            // Outbox dispatch through Relay (Task 5). Messaging continues while paused.
            if (this.deps.dispatchOutboxes) {
                let outboxBusy = false
                timers.push(
                    setInterval(async () => {
                        if (outboxBusy || ended) return
                        outboxBusy = true
                        try {
                            await this.deps.dispatchOutboxes!(lease, op => this.context(lease, op))
                        } catch (err) {
                            if (fenced(err)) return end(`outbox fenced: ${errText(err)}`)
                            this.log(`outbox: ${errText(err)}`)
                        } finally {
                            outboxBusy = false
                        }
                    }, SCHEDULER_INTERVAL_MS),
                )
            }
        })
        // Let in-flight agent work finish against the old lease; actors reject it anyway.
        await runner.drain().catch(() => {})
    }
}

// One read of every entity per 200 ms, shared by the agent and outbox loops.
const readCache = new Map<string, { at: number; value: Promise<Array<AirportState | FlightState>> }>()
export function readAll(repo: WorkerRepository, runId: string, ids: readonly AgentEntityId[], maxAgeMs = 200): Promise<Array<AirportState | FlightState>> {
    const key = runId
    const hit = readCache.get(key)
    const now = Date.now()
    if (hit && now - hit.at < maxAgeMs) return hit.value
    const value = Promise.all(ids.map(id => (id.startsWith("airport:") ? repo.airport(runId, id.slice(8) as AirportId).read() : repo.flight(runId, id.slice(7)).read())))
    value.catch(() => readCache.delete(key))
    readCache.set(key, { at: now, value })
    return value
}

export function entityApi(repo: WorkerRepository, runId: string, id: AgentEntityId): AirportSimApi & EntityWorkApi | FlightSimApi & EntityWorkApi {
    return id.startsWith("airport:") ? repo.airport(runId, id.slice(8) as AirportId) : repo.flight(runId, id.slice(7))
}

// ------------------------------------------------------------ health helper

export function workerHealth(status: WorkerStatus): DependencyHealth {
    switch (status.state) {
        case "RUNNING":
            return { status: "READY", detail: status.detail }
        case "RECOVERING":
            return { status: "DEGRADED", detail: `RECOVERING${status.detail ? `: ${status.detail}` : ""}` }
        case "WAITING_FOR_LEASE":
        case "STARTING":
            return { status: "DEGRADED", detail: `RECOVERING: waiting for worker lease${status.detail ? ` (${status.detail})` : ""}` }
        default:
            return { status: "UNAVAILABLE", detail: "worker stopped" }
    }
}

// ------------------------------------------------------------ process entry

// `bun server/src/simulation/worker.ts` (from atc-simulator/). Wires the real
// Terse repository (server/src/actors.ts), Relay adapter and model from env.
// Modules owned by other tasks are loaded by URL so this file typechecks before they land.
const load = (rel: string): Promise<Record<string, unknown>> => import(new URL(rel, import.meta.url).href)

async function main() {
    const env = process.env
    const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

    const actorsModule: Record<string, unknown> = await load("../actors.ts").catch(err => {
        throw new Error(`server/src/actors.ts (Task 2 ActorRepository) is not available yet: ${errText(err)}`)
    })
    const createRepo = (actorsModule.createWorkerRepository ?? actorsModule.createActorRepository) as ((e: typeof env) => WorkerRepository) | undefined
    if (typeof createRepo !== "function") throw new Error("server/src/actors.ts must export createWorkerRepository(env) returning a WorkerRepository")
    const repo = createRepo(env)

    const { chooseValidAction } = await import("../../../packages/domain/src/policy.ts")
    const { createAgentModel } = await import("../agents/model.ts")
    const model = createAgentModel(env, chooseValidAction)

    // Relay adapter and outbox dispatcher (Task 5). Optional so the clock can run
    // and be verified while the hosted adapter is being finished.
    let transport: RelayTransport | null = null
    let dispatchOutboxes: WorkerDeps["dispatchOutboxes"]
    try {
        const relay = await load("../relay/agent-relay.ts")
        const outbox = await load("../relay/outbox.ts")
        const { resolveRelayTiming } = await import("@ghost-tower/domain/constants")
        transport = (relay.hostedRelayFromEnv as (e: typeof env) => RelayTransport)(env)
        const timing = resolveRelayTiming("HOSTED", env)
        const dispatch = outbox.dispatchDueOutboxes as (ctx: { transport: RelayTransport; outbox: unknown; timing: unknown }) => Promise<unknown>
        const relayTransport = transport
        dispatchOutboxes = async (lease, context) => {
            await dispatch({
                transport: relayTransport,
                timing,
                outbox: {
                    entities: () => repo.entities(lease.runId),
                    list: async (id: EntityId) => {
                        if (id === "controller") return repo.controllerOutbox ? repo.controllerOutbox.list(lease) : []
                        const state = await entityApi(repo, lease.runId, id).read()
                        return state.outbox.filter(e => !e.acknowledged)
                    },
                    recordAttempt: async (id: EntityId, attempt: OutboxAttempt) => {
                        if (id === "controller") return repo.controllerOutbox?.recordAttempt(lease, attempt)
                        await entityApi(repo, lease.runId, id).markTransportAccepted(context(`sent:${attempt.messageId}:${attempt.attemptCount}`), attempt)
                    },
                },
            })
        }
    } catch (err) {
        log(`relay unavailable, running without messaging: ${errText(err)}`)
    }
    let publish: WorkerDeps["publish"]
    try {
        const projection: Record<string, unknown> = await load("../projection.ts")
        const make = projection.createWorkerPublisher as ((deps: { repo: WorkerRepository; env: typeof env }) => WorkerDeps["publish"]) | undefined
        if (make) publish = make({ repo, env })
    } catch (err) {
        log(`projection publisher unavailable: ${errText(err)}`)
    }

    const worker = new SimulationWorker({
        repo,
        model,
        fallback: chooseValidAction,
        transport,
        commandSecret: env.COMMAND_SIGNING_SECRET ?? null,
        dispatchOutboxes,
        publish,
        log,
        onStatus: s => {
            if (s.state !== "RUNNING") log(`status ${s.state}${s.detail ? `: ${s.detail}` : ""}`)
        },
    })
    const shutdown = async (signal: string) => {
        log(`${signal}: stopping; the lease expires on its own and the next worker resumes the pending tick`)
        await worker.stop()
        await transport?.disconnect().catch(() => {})
        process.exit(0)
    }
    process.on("SIGINT", () => void shutdown("SIGINT"))
    process.on("SIGTERM", () => void shutdown("SIGTERM"))
    await worker.start()
    log(`worker ${worker.ownerId} started`)
}

if (import.meta.main) {
    main().catch(err => {
        console.error(errText(err))
        process.exit(1)
    })
}
