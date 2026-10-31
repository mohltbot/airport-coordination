// Module-level movement and landing steps for FlightActor (plan Task 8).
// Terse 0.14.9: sync methods on an actor class throw, so the logic lives here and
// the actor methods only fence, call one step, and reassign the aggregate.
import type {
    ClaimedJob,
    ClearanceCheckResult,
    DecisionCommit,
    DomainResult,
    FlightState,
    Job,
    MutationContext,
    PilotDecision,
    ReceivedEnvelope,
    Tick,
    TouchdownReceipt,
} from "@ghost-tower/domain/contracts"
import { JOB_LEASE_MS, RELAY_TIMING } from "@ghost-tower/domain/constants"
import { advanceFlight, applyApproachGuard, recordFlightTouchdown, type FlightHooks } from "../../packages/domain/src/flight.js"
import {
    acknowledgeRelease,
    advanceNegotiation,
    buildDecisionInput,
    commitPilotDecision,
    flightWallTimers,
    negotiationTiming,
    nextFlightWallDeadline,
    openRound,
    releaseAllForTerminal,
    requestClearance,
    type DecisionMode,
    type NegotiationContext,
    type NegotiationTiming,
} from "../../packages/domain/src/negotiation.js"
import { checkFence, rejected } from "./durability.js"

export type MotionStep = { state: FlightState | null; result: DomainResult }

// Optional actor settings, read if FlightActor persists them (as AirportActor does).
export type FlightNegotiationSettings = { timing?: NegotiationTiming; decisionMode?: DecisionMode }

export function flightNegotiationCtx(actor: object, state: FlightState, ctx: MutationContext): NegotiationContext {
    const settings = actor as FlightNegotiationSettings
    return {
        simNowSec: Math.max(ctx.simNowSec, state.lastAdvancedSimSec),
        wallNowMs: ctx.wallNowMs,
        timing: settings.timing ?? negotiationTiming(RELAY_TIMING.HOSTED, RELAY_TIMING.HOSTED.defaultSpeed),
        decisionMode: settings.decisionMode ?? "IMMEDIATE",
    }
}

// A dropped assignment opens a real negotiation round; a terminal flight declines
// its outstanding offers and releases its reservation through negotiation.ts.
export function flightHooks(nctx: NegotiationContext): FlightHooks {
    return {
        reopen: (s, trigger) => openRound(s, trigger, nctx).state,
        terminal: s => releaseAllForTerminal(s, nctx).state,
    }
}

function fenced(state: FlightState | null, ctx: MutationContext): { ok: true; state: FlightState } | { ok: false; step: MotionStep } {
    if (state === null) return { ok: false, step: { state: null, result: rejected(0, "WRONG_PHASE") } }
    const f = checkFence(state, ctx)
    if (!f.ok) return { ok: false, step: { state: null, result: f.result } }
    return { ok: true, state: { ...state, fencing: f.fencing } }
}

// One tick: movement, fuel, holding, approach, slot expiry, terminal outcomes, then
// the negotiation wall-clock timers so collection deadlines also fire while running.
export function advanceFlightStep(settings: object, current: FlightState | null, ctx: MutationContext, tick: Tick): MotionStep {
    const f = fenced(current, ctx)
    if (!f.ok) return f.step
    const nctx = flightNegotiationCtx(settings, f.state, { ...ctx, simNowSec: tick.toSimSec })
    const t = advanceFlight(f.state, tick, ctx, flightHooks(nctx))
    if (t.result.outcome !== "APPLIED") return { state: t.state, result: t.result }
    const timers = flightWallTimers(t.state, nctx)
    const next = timers.result.outcome === "APPLIED" ? timers.state : t.state
    return { state: immediateClearance(next, nctx), result: t.result }
}

// IMMEDIATE mode (no pilot agent): send the clearance request as soon as flight.ts
// queues the CLEARANCE job. JOB mode leaves it for the runner (claimFlightWork).
function immediateClearance(flight: FlightState, nctx: NegotiationContext): FlightState {
    if (nctx.decisionMode === "JOB") return flight
    const a = flight.activeAssignment
    const job = Object.values(flight.jobs).find(j => j.input.trigger === "CLEARANCE" && j.status === "QUEUED")
    if (!a || a.clearanceId || !job) return flight
    const r = requestClearance(flight, nctx)
    if (r.result.outcome !== "APPLIED") return flight
    const committed: Job = {
        ...job,
        status: "COMMITTED",
        outcome: { source: "RULES_FALLBACK", action: "REQUEST_CLEARANCE", reason: "Clearance window reached", committedAtWallMs: nctx.wallNowMs },
    }
    return { ...r.state, jobs: { ...r.state.jobs, [job.jobId]: committed } }
}

// ---------------------------------------------------------------- negotiation receive and pilot jobs

// Relay messages other than controller commands: negotiation replies and DOMAIN_ACKs.
// Dedup by (runId, messageId) in the inbox; the router sends the DOMAIN_ACK afterwards.
export function receiveFlightStep(settings: object, current: FlightState | null, ctx: MutationContext, message: ReceivedEnvelope): MotionStep {
    if (current === null) return { state: null, result: rejected(0, "WRONG_PHASE") }
    if (message.runId !== current.runId) return { state: null, result: rejected(current.stateRevision, "WRONG_RUN") }
    const f = fenced(current, ctx)
    if (!f.ok) return f.step
    const seen = f.state.inbox[message.messageId]
    if (seen) return { state: null, result: { outcome: "DUPLICATE", code: seen.result.code, stateRevision: current.stateRevision, original: seen.result } }
    if (message.type === "DOMAIN_ACK") {
        const pid = message.payload.processedMessageId
        if (!f.state.outbox.some(e => e.envelope.messageId === pid)) return { state: null, result: { outcome: "APPLIED", code: "OK", stateRevision: current.stateRevision } }
        const acked = acknowledgeRelease({ ...f.state, outbox: f.state.outbox.filter(e => e.envelope.messageId !== pid) }, pid)
        return { state: acked, result: { outcome: "APPLIED", code: "OK", stateRevision: acked.stateRevision } }
    }
    const nctx = flightNegotiationCtx(settings, f.state, ctx)
    const t = advanceNegotiation(f.state, message, nctx)
    const base = t.result.outcome === "DUPLICATE" ? t.result.original : t.result
    const recorded: FlightState = {
        ...t.state,
        inbox: { ...t.state.inbox, [message.messageId]: { messageId: message.messageId, type: message.type, fromEntityId: message.fromEntityId, result: base, processedAtWallMs: ctx.wallNowMs } },
    }
    return { state: immediateClearance(recorded, nctx), result: t.result }
}

export function claimFlightWork(settings: object, current: FlightState | null, ctx: MutationContext): { state: FlightState | null; job: ClaimedJob | null } {
    const f = fenced(current, ctx)
    if (!f.ok) return { state: null, job: null }
    let next = f.state
    const nctx = flightNegotiationCtx(settings, next, ctx)
    const claimable = Object.values(next.jobs)
        .filter(j => j.kind === "PILOT_DECISION" && (j.status === "QUEUED" || (j.status === "LEASED" && (j.leaseUntilWallMs ?? 0) <= ctx.wallNowMs)))
        .sort((a, b) => (a.input.priority === "EMERGENCY" ? 0 : 1) - (b.input.priority === "EMERGENCY" ? 0 : 1) || a.input.createdAtWallMs - b.input.createdAtWallMs || a.jobId.localeCompare(b.jobId))
    let changed = false
    for (const job of claimable) {
        // A CLEARANCE job outlives decision-revision bumps; refresh it instead of dropping it.
        const current = job.input.trigger === "CLEARANCE" && job.decisionRevision !== next.decisionRevision ? { ...job, decisionRevision: next.decisionRevision } : job
        const input = buildDecisionInput(next, current, nctx)
        if (!input) {
            next = { ...next, jobs: { ...next.jobs, [job.jobId]: { ...job, status: "CANCELLED" } } }
            changed = true
            continue
        }
        const leaseToken = crypto.randomUUID()
        const leaseUntilWallMs = ctx.wallNowMs + JOB_LEASE_MS
        next = { ...next, jobs: { ...next.jobs, [job.jobId]: { ...current, status: "LEASED", leaseToken, leaseUntilWallMs, attemptCount: job.attemptCount + 1 } } }
        return { state: next, job: { ...input, jobLeaseToken: leaseToken, leaseUntilWallMs } }
    }
    return { state: changed ? next : null, job: null }
}

const PILOT_TYPES = new Set(["REQUEST_LANDING", "SELECT_OFFER", "HOLD", "REQUEST_CLEARANCE"])

// A model proposal that breaks a hard rule is replaced by the rules choice inside
// commitPilotDecision (recorded RULES_FALLBACK). A malformed commit is rejected and
// the job stays LEASED under the same token, so the runner's fallback can commit.
export function commitFlightDecision(settings: object, current: FlightState | null, ctx: MutationContext, commit: DecisionCommit): MotionStep {
    const f = fenced(current, ctx)
    if (!f.ok) return f.step
    const job = f.state.jobs[commit.jobId]
    if (!job || job.kind !== "PILOT_DECISION") return { state: null, result: rejected(f.state.stateRevision, "STALE_STATE") }
    if (job.status === "COMMITTED") {
        const original = { outcome: "APPLIED" as const, code: "OK", stateRevision: f.state.stateRevision }
        return { state: null, result: { outcome: "DUPLICATE", code: "OK", stateRevision: f.state.stateRevision, original } }
    }
    if (job.status !== "LEASED" || job.leaseToken !== commit.jobLeaseToken) return { state: null, result: rejected(f.state.stateRevision, "INVALID_LEASE") }
    if (commit.decisionRevision !== job.decisionRevision) return { state: null, result: rejected(f.state.stateRevision, "STALE_STATE") }
    if (!PILOT_TYPES.has(commit.decision.type)) return { state: null, result: rejected(f.state.stateRevision, "INVALID_PAYLOAD") }
    const t = commitPilotDecision(f.state, commit.jobId, commit.decision as PilotDecision, commit.source, flightNegotiationCtx(settings, f.state, ctx))
    return { state: t.result.outcome === "APPLIED" || t.state !== f.state ? t.state : null, result: t.result }
}

export function approachGuardStep(settings: object, current: FlightState | null, ctx: MutationContext, check: ClearanceCheckResult): MotionStep {
    const f = fenced(current, ctx)
    if (!f.ok) return f.step
    const t = applyApproachGuard(f.state, check, ctx, flightHooks(flightNegotiationCtx(settings, f.state, ctx)))
    return { state: t.result.outcome === "APPLIED" ? t.state : null, result: t.result }
}

// LANDED from the airport's authoritative receipt; leftover offers are declined.
export function touchdownStep(settings: object, current: FlightState | null, ctx: MutationContext, receipt: TouchdownReceipt): MotionStep {
    const f = fenced(current, ctx)
    if (!f.ok) return f.step
    const t = recordFlightTouchdown(f.state, receipt, ctx)
    if (t.result.outcome !== "APPLIED") return { state: null, result: t.result }
    const released = releaseAllForTerminal(t.state, flightNegotiationCtx(settings, t.state, ctx))
    return { state: released.state, result: { ...t.result, stateRevision: released.state.stateRevision } }
}

// ---------------------------------------------------------------- settings and wall-clock timers

export type FlightNegotiationOptions = { profile?: "HOSTED" | "LOCAL"; speed: 1 | 5 | 10; decisionMode?: DecisionMode }

export function configuredTiming(options: FlightNegotiationOptions): NegotiationTiming {
    return negotiationTiming(RELAY_TIMING[options.profile ?? "HOSTED"], options.speed)
}

// Collection deadline, acceptance status check and no-feasible retry fire on wall
// time, also while the run is paused. Local alarms are lost when the runtime
// restarts, so the due time is persisted and re-armed on every actor call.
type AlarmHost = { alarm: { get(): number | null; set(at: number): void }; timerAt: number | null; state: FlightState | null }

export function armFlightTimer(actor: AlarmHost, timing: NegotiationTiming): void {
    const due = actor.state ? nextFlightWallDeadline(actor.state, timing) : null
    if (due !== actor.timerAt) actor.timerAt = due
    if (due !== null && actor.alarm.get() !== due) actor.alarm.set(due)
}

export function ensureFlightTimer(actor: AlarmHost): void {
    if (actor.timerAt !== null && actor.alarm.get() === null) actor.alarm.set(actor.timerAt)
}

export function flightTimerStep(settings: object, current: FlightState | null, wallNowMs: number): FlightState | null {
    if (current === null) return null
    const nctx = flightNegotiationCtx(settings, current, {
        runId: current.runId,
        workerEpoch: current.fencing.workerEpoch,
        leaseToken: current.fencing.leaseToken ?? "timer",
        simNowSec: current.lastAdvancedSimSec,
        wallNowMs,
        operationId: "timer",
    })
    const t = flightWallTimers(current, nctx)
    return t.state === current ? null : immediateClearance(t.state, nctx)
}
