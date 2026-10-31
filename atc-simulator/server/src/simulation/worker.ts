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
    /** Negotiation timing for the transport profile and run speed, plus IMMEDIATE/JOB decisions. */
    configureNegotiation?(context: MutationContext, options: NegotiationSettings): Promise<DomainResult>
}

export type NegotiationSettings = { profile: "HOSTED" | "LOCAL"; speed: 1 | 5 | 10; decisionMode: "IMMEDIATE" | "JOB" }

export type OutboxAttempt = { messageId: string; transportMessageId: string | null; attemptCount: number; nextAttemptAtWallMs: number }

export interface WorkerRepository extends SimulationRepository {
    airport(runId: string, airportId: AirportId): AirportSimApi & EntityWorkApi
    flight(runId: string, flightId: string): FlightSimApi & EntityWorkApi
    /** Registered entity IDs of the run (airports, flights, controller). */
    replenishTraffic?(lease: WorkerLease, connect: (ids: EntityId[]) => Promise<void>): Promise<boolean>
    messagingEntities?(runId: string): Promise<EntityId[]>
    entities(runId: string): Promise<EntityId[]>
    /** Current run speed (1, 5 or 10), for negotiation timing. */
    runSpeed?(runId: string): Promise<number>
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
    /** Transport profile and decision mode pushed to every entity with the run speed. */
    negotiation?: Omit<NegotiationSettings, "speed">
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
    private setupEpoch: number | null = null
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
                this.setupEpoch = null
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

        // Keep the lease alive during setup: hosted Relay registration of 3+N identities took
        // 55 s on first connect, past the 10 s lease, so the run never reached its first tick.
        // The supervisor clears setupEpoch when this lease ends, so the loop cannot outlive it.
        this.setupEpoch = lease.epoch
        void (async () => {
            while (this.setupEpoch === initial.epoch && !this.stopped) {
                await sleep(WORKER_RENEW_MS)
                if (this.setupEpoch !== initial.epoch) return
                try {
                    lease = await repo.simulation.renewWorker(lease)
                } catch (err) {
                    this.log(`setup lease renewal failed: ${errText(err)}`)
                    return
                }
            }
        })()

        const entityIds = await repo.entities(runId)
        const initialMessagingIds = await repo.messagingEntities?.(runId) ?? entityIds
        const registry = registrationsFor(runId, initialMessagingIds)
        const airportIds = entityIds.flatMap(e => (e.startsWith("airport:") ? [e.slice(8) as AirportId] : []))
        const agentIds = entityIds.filter((e): e is AgentEntityId => e !== "controller")

        // Recovery before the first tick: a touchdown the airport recorded is final.
        // Best effort: entities of a run still initializing are not readable yet, and
        // the tick loop retries (and reconcileLandings is idempotent) once they are.
        let recoveredLandings = false
        const recover = async () => {
            if (recoveredLandings) return
            const recovered = await reconcileLandings(repo, this.context(lease, `recover:${lease.epoch}`), airportIds)
            if (recovered.length) this.log(`recovered ${recovered.length} landing(s) from airport receipts`)
            // Resume sim time from the newest flight sample; beginTick owns the real clock.
            const firstFlight = agentIds.find(e => e.startsWith("flight:"))
            if (firstFlight) this.setStatus({ simNowSec: (await repo.flight(runId, firstFlight.slice(7)).read()).lastAdvancedSimSec })
            recoveredLandings = true
        }
        try {
            await recover()
        } catch (err) {
            this.setStatus({ state: "RECOVERING", detail: `entities not ready: ${errText(err)}` })
        }

        // Relay: reconnect saved identities and route verified messages to actor inboxes.
        let detachRouter: (() => void) | null = null
        const transport = this.deps.transport ?? null
        if (transport) {
            await transport.connect(runId, registry)
            detachRouter = attachRouter(transport, {
                runId,
                registry,
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

        // Push timing/decision mode to every entity at lease start and on speed changes.
        let configuredSpeed: number | null = null
        const configure = async (speed: number) => {
            const negotiation = this.deps.negotiation
            if (!negotiation || speed === configuredSpeed || (speed !== 1 && speed !== 5 && speed !== 10)) return
            const ctx = this.context(lease, `configure:${lease.epoch}:${speed}`)
            await Promise.all(agentIds.map(id => entityApi(repo, runId, id).configureNegotiation?.(ctx, { ...negotiation, speed })))
            configuredSpeed = speed
            this.log(`negotiation configured: ${negotiation.profile} ${negotiation.decisionMode} speed ${speed}`)
        }
        if (repo.runSpeed) await configure(await repo.runSpeed(runId))

        this.setupEpoch = null
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
            let trafficCheckAt = 0
            timers.push(
                setInterval(async () => {
                    if (tickBusy || ended) return
                    tickBusy = true
                    try {
                        // Landing recovery must finish before any flight advances again.
                        await recover()
                        const checkTraffic = this.now() >= trafficCheckAt
                        if (checkTraffic) {
                            trafficCheckAt = this.now() + 1_000
                            try {
                                await repo.replenishTraffic?.(lease, async ids => {
                                    if (ended || this.stopped) throw new FencedError("WRONG_RUN", "lease ended during traffic initialization")
                                    await repo.simulation.renewWorker(lease)
                                    if (ended || this.stopped) throw new FencedError("WRONG_RUN", "lease ended before traffic registration")
                                    if (transport) await transport.connect(runId, registrationsFor(runId, ids))
                                    if (ended || this.stopped) throw new FencedError("WRONG_RUN", "lease ended during traffic registration")
                                })
                            } finally {
                                // Activation may have committed even when its RPC response was lost.
                                // Authoritative membership, rather than a success flag, owns routing.
                                const changed = !ended && await reconcileWorkerMembership(repo, runId, entityIds, agentIds, registry, transport, () => !ended && !this.stopped)
                                if (changed) {
                                    configuredSpeed = null
                                    if (repo.runSpeed) await configure(await repo.runSpeed(runId))
                                }
                            }
                        }
                        const outcome = await runTick(repo, lease)
                        if (ended) return
                        if (outcome) {
                            await configure(Math.round((outcome.tick.toSimSec - outcome.tick.fromSimSec) / (SCHEDULER_INTERVAL_MS / 1000)))
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
    const key = `${runId}:${ids.join(",")}`
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

// ------------------------------------------------------------ Relay health

/**
 * Truthful Relay status from the last 60 s of real traffic: outbox send results and delivered
 * hop latency (envelope creation to actor receipt). READY only while sends succeed and hops are
 * short; hosted Relay answered 503 database_overloaded / 429 workspace_busy for minutes at a time.
 */
export function relayHealthTracker(label = "hosted Relay", now: () => number = Date.now) {
    const WINDOW_MS = 60_000
    const sends: Array<{ at: number; ok: boolean; code: string | null }> = []
    const hops: Array<{ at: number; ms: number }> = []
    const trim = () => {
        const cut = now() - WINDOW_MS
        while (sends.length && sends[0]!.at < cut) sends.shift()
        while (hops.length && hops[0]!.at < cut) hops.shift()
    }
    return {
        send(ok: boolean, code: string | null) {
            sends.push({ at: now(), ok, code })
            trim()
        },
        hop(ms: number) {
            hops.push({ at: now(), ms })
            trim()
        },
        health(): DependencyHealth {
            trim()
            const failed = sends.filter(s => !s.ok)
            const sorted = hops.map(h => h.ms).sort((a, b) => a - b)
            const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null
            const hop = p50 === null ? "no deliveries" : `p50 hop ${Math.round(p50 / 1000)} s`
            const codes = [...new Set(failed.map(f => f.code).filter(Boolean))].slice(0, 2).join(", ")
            if (sends.length >= 5 && failed.length === sends.length)
                return { status: "UNAVAILABLE", detail: `${label} failing: all ${sends.length} sends in last 60 s failed${codes ? ` (${codes})` : ""}` }
            if (failed.length >= 3 || (p50 !== null && p50 > 15_000))
                return { status: "DEGRADED", detail: `${label} overloaded: ${failed.length} send failures in last 60 s${codes ? ` (${codes})` : ""}, ${hop}` }
            return { status: "READY", detail: p50 === null ? label : `${label}, ${hop}` }
        },
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
    // LOCAL for Agent Relay's local engine (spec timings), HOSTED for cast.agentrelay.com.
    const relayProfile = (env.RELAY_TRANSPORT_PROFILE ?? env.RELAY_PROFILE)?.trim().toUpperCase() === "LOCAL" ? ("LOCAL" as const) : ("HOSTED" as const)
    const relayBase = env.RELAY_BASE_URL || env.RELAY_BASE || ""
    const relayLabel = env.RELAY_LABEL?.trim() || (/\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(relayBase) ? "Agent Relay (local engine)" : "hosted Relay")
    const relayStats = relayHealthTracker(relayLabel)
    log(`relay: ${relayLabel}, profile ${relayProfile}`)

    const { loadWorkerRepository } = await import("./repository.ts")
    const repo = await loadWorkerRepository(env)

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
        const timing = resolveRelayTiming(relayProfile, env)
        const dispatch = outbox.dispatchDueOutboxes as (ctx: { transport: RelayTransport; outbox: unknown; timing: unknown; log?: unknown }) => Promise<unknown>
        const relayTransport = transport
        dispatchOutboxes = async (lease, context) => {
            await dispatch({
                transport: relayTransport,
                timing,
                // Failures only, plus slow sends: the success path would flood the log.
                log: (e: { outcome: string; type: string; entityId: string; attempt: number; code: string | null; sendMs: number }) => {
                    if (e.outcome === "SENT" || e.outcome === "FAILED") relayStats.send(e.outcome === "SENT", e.code)
                    if (e.outcome !== "SENT" || e.sendMs > 5_000) log(`relay send ${e.outcome} ${e.type} from ${e.entityId} attempt ${e.attempt} ${e.code ?? ""} ${e.sendMs}ms`)
                },
                outbox: {
                    entities: () => repo.messagingEntities?.(lease.runId) ?? repo.entities(lease.runId),
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
        const make = projection.createWorkerPublisher as
            | ((deps: { repo: WorkerRepository; env: typeof env; relayHealth?: () => DependencyHealth }) => WorkerDeps["publish"])
            | undefined
        if (make) publish = make({ repo, env, relayHealth: transport ? () => relayStats.health() : undefined })
    } catch (err) {
        log(`projection publisher unavailable: ${errText(err)}`)
    }

    const worker = new SimulationWorker({
        repo,
        model,
        fallback: chooseValidAction,
        transport,
        commandSecret: env.COMMAND_SIGNING_SECRET ?? null,
        negotiation: {
            profile: relayProfile,
            decisionMode: env.GHOST_DECISION_MODE === "IMMEDIATE" || env.GHOST_DECISION_MODE === "JOB" ? env.GHOST_DECISION_MODE : env.AGENT_MODE === "live" ? "JOB" : "IMMEDIATE",
        },
        dispatchOutboxes,
        publish,
        log,
        // Delivered messages: latency from envelope creation, and anything not applied cleanly.
        onRoute: e => {
            if (e.outcome !== "SKIPPED") relayStats.hop(e.latencyMs)
            // Local echo delivers first, so the event-log copy is an expected SKIPPED/DUPLICATE.
            const echoCopy = e.outcome === "SKIPPED" && e.code === "DUPLICATE"
            if (!echoCopy && (e.outcome === "SKIPPED" || e.detail || e.latencyMs > 15_000 || (!e.ackSent && e.type !== "DOMAIN_ACK")))
                log(`relay recv ${e.type} ${e.from}->${e.to} ${e.outcome}/${e.code} ${e.latencyMs}ms ack=${e.ackSent}${e.detail ? ` ${e.detail}` : ""}`)
        },
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

// Shared by the running clock and recovery tests; never relies on an activation response.
export async function reconcileWorkerMembership(repo: WorkerRepository, runId: string, activeIds: EntityId[], agentIds: AgentEntityId[], registry: ReturnType<typeof registrationsFor>, transport: RelayTransport | null, isCurrent: () => boolean = () => true): Promise<boolean> {
    const ids = await repo.entities(runId)
    const messaging = await repo.messagingEntities?.(runId) ?? ids
    const changed = ids.join(",") !== activeIds.join(",")
    const routingChanged = messaging.join(",") !== registry.map(e => e.entityId).join(",")
    if (!isCurrent()) return false
    if (routingChanged && transport) {
        await transport.connect(runId, registrationsFor(runId, messaging))
    }
    if (!isCurrent()) return false
    activeIds.splice(0, activeIds.length, ...ids)
    agentIds.splice(0, agentIds.length, ...ids.filter((id): id is AgentEntityId => id !== "controller"))
    registry.splice(0, registry.length, ...registrationsFor(runId, messaging))
    return changed
}
