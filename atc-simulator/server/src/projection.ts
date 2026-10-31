// ProjectionHub: reads the newest public snapshot per watched run, stamps it, and fans it out to
// SSE subscribers. Frames go out at most 4 Hz when content changes and at least once per second
// otherwise, so a paused run still proves freshness (the browser shows Reconnecting after 2 s).
// projectionVersion is stamped here as max(previous + 1, wall ms): strictly increasing per run and
// across gateway restarts, so a reconnecting browser never sees a lower version than before.
import { SSE_MAX_HZ } from "@ghost-tower/domain/constants"
import type { AirportId, AirportState, CommandReceipt, FlightState, PublicSnapshot, SimulationState, WorkerLease } from "@ghost-tower/domain/contracts"
import { buildPublicSnapshot } from "@ghost-tower/domain/projections"
import type { SimulationBackend } from "./actors.ts"
import type { TickOutcome } from "./simulation/clock.ts"
import type { WorkerRepository, WorkerStatus } from "./simulation/worker.ts"

export type HubEvent =
    | { type: "snapshot"; snapshot: PublicSnapshot }
    | { type: "command"; receipt: CommandReceipt }
    | { type: "run-reset"; previousRunId: string; activeRunId: string }

type Listener = (event: HubEvent) => void

const FRAME_MS = Math.ceil(1000 / SSE_MAX_HZ)
const KEEPALIVE_MS = 1000

type Watch = {
    listeners: Set<Listener>
    timer: ReturnType<typeof setInterval> | null
    inFlight: boolean
    latest: PublicSnapshot | null
    contentKey: string | null
    lastEmitMs: number
    receipts: Map<string, string>
    resetTo: string | null
}

const contentKey = (s: PublicSnapshot) => JSON.stringify({ ...s, serverWallTimeMs: 0, projectionVersion: 0 })

export class ProjectionHub {
    private watches = new Map<string, Watch>()
    private version = 0

    constructor(
        private readonly backend: SimulationBackend,
        private readonly now: () => number = Date.now,
    ) {}

    private stamp(s: PublicSnapshot): PublicSnapshot {
        const t = this.now()
        this.version = Math.max(this.version + 1, t)
        return { ...s, projectionVersion: this.version, serverWallTimeMs: t }
    }

    private watch(runId: string): Watch {
        let w = this.watches.get(runId)
        if (!w) {
            w = { listeners: new Set(), timer: null, inFlight: false, latest: null, contentKey: null, lastEmitMs: 0, receipts: new Map(), resetTo: null }
            this.watches.set(runId, w)
        }
        return w
    }

    /** Newest stamped snapshot for GET /snapshot and bootstrap. Reads through when nobody is watching. */
    async snapshot(runId: string): Promise<PublicSnapshot | null> {
        const w = this.watches.get(runId)
        if (w?.timer && w.latest && this.now() - w.lastEmitMs < KEEPALIVE_MS * 2) return w.latest
        const raw = await this.backend.readSnapshot(runId)
        if (!raw) return null
        const stamped = this.stamp(raw)
        if (w) {
            w.latest = stamped
            w.contentKey = contentKey(raw)
        }
        return stamped
    }

    /** Subscribe to a run. The newest snapshot (and a pending run-reset) is delivered immediately. */
    subscribe(runId: string, listener: Listener): () => void {
        const w = this.watch(runId)
        w.listeners.add(listener)
        if (!w.timer) w.timer = setInterval(() => void this.poll(runId), FRAME_MS)
        void this.poll(runId, listener)
        return () => {
            w.listeners.delete(listener)
            if (w.listeners.size === 0 && w.timer) {
                clearInterval(w.timer)
                w.timer = null
            }
        }
    }

    subscriberCount(runId: string): number {
        return this.watches.get(runId)?.listeners.size ?? 0
    }

    private emit(w: Watch, event: HubEvent, only?: Listener) {
        for (const l of only ? [only] : w.listeners) {
            try {
                l(event)
            } catch {
                // A broken connection is cleaned up by its own stream.
            }
        }
    }

    private async poll(runId: string, joiner?: Listener) {
        const w = this.watch(runId)
        if (joiner && w.latest) {
            this.emit(w, { type: "snapshot", snapshot: w.latest }, joiner)
            if (w.resetTo) this.emit(w, { type: "run-reset", previousRunId: runId, activeRunId: w.resetTo }, joiner)
            if (w.inFlight) return
        }
        if (w.inFlight) return
        w.inFlight = true
        try {
            const [raw, active] = await Promise.all([this.backend.readSnapshot(runId), this.backend.activeRun().catch(() => null)])
            if (!raw) return
            const key = contentKey(raw)
            const t = this.now()
            const changed = key !== w.contentKey
            const due = joiner !== undefined || (changed && t - w.lastEmitMs >= FRAME_MS) || t - w.lastEmitMs >= KEEPALIVE_MS
            if (changed) {
                for (const r of raw.commands) {
                    const k = `${r.status}|${r.code}|${r.resultingRevision}`
                    if (w.receipts.get(r.commandId) !== k) {
                        const first = !w.receipts.has(r.commandId) && w.contentKey === null
                        w.receipts.set(r.commandId, k)
                        if (!first) this.emit(w, { type: "command", receipt: r })
                    }
                }
            }
            if (due) {
                const stamped = this.stamp(raw)
                w.latest = stamped
                w.contentKey = key
                w.lastEmitMs = t
                this.emit(w, { type: "snapshot", snapshot: stamped })
            }
            if (active && active.runId !== runId && !w.resetTo) {
                w.resetTo = active.runId
                this.emit(w, { type: "run-reset", previousRunId: runId, activeRunId: active.runId })
            }
        } catch {
            // Upstream unavailable: no frame, so browsers show Reconnecting and fall back to polling.
        } finally {
            w.inFlight = false
        }
    }

    close() {
        for (const w of this.watches.values()) if (w.timer) clearInterval(w.timer)
        this.watches.clear()
    }
}

// ---------------------------------------------------------------- worker publisher

/** Minimum wall gap between published projections: the tick loop runs at 4 Hz, the actor write need not. */
const PUBLISH_MIN_MS = 500

type PublisherSim = {
    readRun(runId: string): Promise<SimulationState | null>
    publishProjection(lease: WorkerLease, snapshot: PublicSnapshot): Promise<void>
}

/**
 * Worker-side projection (worker.ts loads this by name): read every entity of the leased run, redact
 * with the domain projection, stamp the worker's own health, and persist it with publishProjection.
 * The gateway serves it while it is fresh and treats a stale one as a stopped worker.
 */
export function createWorkerPublisher(deps: { repo: WorkerRepository; env: Record<string, string | undefined> }) {
    const { repo, env } = deps
    const agentMode = env.AGENT_MODE?.trim().toLowerCase() === "live" ? ("live" as const) : ("rules" as const)
    const relayConfigured = Boolean(env.RELAY_BASE_URL?.trim() && env.RELAY_WORKSPACE_KEY?.trim())
    const modelConfigured = Boolean(env.OPENAI_API_KEY?.trim() && env.OPENAI_MODEL?.trim())
    const sim = repo.simulation as unknown as PublisherSim
    let lastAt = 0
    let busy = false
    return async (lease: WorkerLease, _outcome: TickOutcome | null, status: WorkerStatus): Promise<void> => {
        const now = Date.now()
        if (busy || now - lastAt < PUBLISH_MIN_MS) return
        busy = true
        try {
            const run = await sim.readRun(lease.runId)
            if (!run) return
            const ids = run.entities.map(e => e.entityId).filter(id => id !== "controller")
            const states = await Promise.all(
                ids.map(id => (id.startsWith("airport:") ? repo.airport(run.runId, id.slice(8) as AirportId).read() : repo.flight(run.runId, id.slice(7)).read())),
            )
            const { workerHealth } = await import("./simulation/worker.ts")
            const worker = workerHealth(status)
            const snapshot = buildPublicSnapshot({
                run,
                airports: states.filter((s): s is AirportState => s.entityId.startsWith("airport:")),
                flights: states.filter((s): s is FlightState => s.entityId.startsWith("flight:")),
                wallNowMs: Date.now(),
                projectionVersion: run.projectionVersion + 1,
                agentMode,
                health: {
                    actors: { status: "READY", detail: null },
                    relay: !relayConfigured
                        ? { status: "UNAVAILABLE", detail: "Relay not configured" }
                        : worker.status === "READY"
                          ? { status: "READY", detail: null }
                          : { status: "DEGRADED", detail: "Worker reconnecting Relay identities" },
                    model:
                        agentMode === "rules"
                            ? { status: "DEGRADED", detail: "Rules mode" }
                            : modelConfigured
                              ? { status: "READY", detail: env.OPENAI_MODEL?.trim() ?? null }
                              : { status: "UNAVAILABLE", detail: "Live mode needs OPENAI_API_KEY and OPENAI_MODEL" },
                    worker,
                },
            })
            await sim.publishProjection(lease, snapshot)
            lastAt = now
        } finally {
            busy = false
        }
    }
}
