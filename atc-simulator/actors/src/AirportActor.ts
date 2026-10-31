import { Actor, Persisted } from "terse-sdk/actor"
import type {
    AirportState,
    AtcDecision,
    ClaimedJob,
    ClearanceCheck,
    ClearanceCheckResult,
    DecisionCommit,
    DomainResult,
    InboxResult,
    Job,
    MutationContext,
    ProtocolEnvelope,
    ReceivedEnvelope,
    Tick,
    TouchdownInput,
    TouchdownReceipt,
} from "@ghost-tower/domain/contracts"
import { JOB_LEASE_MS, RELAY_TIMING, type TransportProfile } from "@ghost-tower/domain/constants"
import { isControllerCommand, receiveControllerCommand } from "@ghost-tower/domain/incidents"
import {
    appendOutbox,
    buildDecisionInput,
    buildEnvelope,
    commitAtcDecision,
    negotiationTiming,
    receiveAirportNegotiation,
    recordAirportTouchdown,
    validateClearance as checkClearance,
    advanceAirport,
    type DecisionMode,
    type NegotiationContext,
    type NegotiationTiming,
} from "../../packages/domain/src/negotiation.ts"
import { applied, checkFence, markOutboxAccepted, rejected } from "./durability.ts"
import { fenceOnly, initializeEntity } from "./entity.ts"

// ---------------------------------------------------------------- module-level helpers
// Sync methods on an actor class throw in Terse 0.14.9, so all logic lives here.

type Step = { state: AirportState | null; result: DomainResult }

function negotiationCtx(state: AirportState, ctx: MutationContext, timing: NegotiationTiming, mode: DecisionMode): NegotiationContext {
    return { simNowSec: Math.max(ctx.simNowSec, state.lastAdvancedSimSec), wallNowMs: ctx.wallNowMs, timing, decisionMode: mode }
}

const plain = (r: DomainResult): InboxResult["result"] => (r.outcome === "DUPLICATE" ? r.original : r)

function withInbox(state: AirportState, message: ReceivedEnvelope, result: DomainResult, wallNowMs: number): AirportState {
    const record: InboxResult = {
        messageId: message.messageId,
        type: message.type,
        fromEntityId: message.fromEntityId,
        result: plain(result),
        processedAtWallMs: wallNowMs,
    }
    return { ...state, inbox: { ...state.inbox, [message.messageId]: record } }
}

const isOpenJob = (j: Job) => j.status === "QUEUED" || j.status === "LEASED"

// incidents.ts revokes holds on a closed runway but sends no LANDING_REFUSED for them. An ATC job
// whose hold was revoked would otherwise leave that flight waiting until its collection deadline.
function cancelRevokedHoldJobs(state: AirportState, nctx: NegotiationContext, causation: string): AirportState {
    let jobs = state.jobs
    const out: ProtocolEnvelope[] = []
    for (const j of Object.values(state.jobs)) {
        if (j.kind !== "ATC_DECISION" || !isOpenJob(j)) continue
        const held = Object.values(state.offers).find(o => o.requestMessageId === j.input.relevantMessageIds[0])
        if (!held || held.status === "OFFERED") continue
        jobs = { ...jobs, [j.jobId]: { ...j, status: "CANCELLED" } }
        out.push(
            buildEnvelope(
                state,
                nctx,
                `flight:${held.flightId}`,
                "LANDING_REFUSED",
                { negotiationId: held.negotiationId, airportId: state.airportId, code: "CLOSED", explanation: `${state.airportId} withdrew the slot: runway unavailable` },
                held.negotiationId,
                causation,
            ),
        )
    }
    if (out.length === 0) return state
    return appendOutbox({ ...state, jobs }, out, nctx.wallNowMs)
}

function receiveStep(state: AirportState | null, ctx: MutationContext, message: ReceivedEnvelope, timing: NegotiationTiming, mode: DecisionMode): Step {
    if (state === null) return { state: null, result: rejected(0, "WRONG_PHASE") }
    if (message.runId !== state.runId || ctx.runId !== state.runId) return { state: null, result: rejected(state.stateRevision, "WRONG_RUN") }
    const fence = checkFence(state, ctx)
    if (!fence.ok) return { state: null, result: fence.result }
    const seen = state.inbox[message.messageId]
    if (seen) return { state: null, result: { outcome: "DUPLICATE", code: seen.result.code, stateRevision: state.stateRevision, original: seen.result } }
    if (message.toEntityId !== state.entityId) return { state: null, result: rejected(state.stateRevision, "UNAUTHORIZED") }
    const fenced: AirportState = { ...state, fencing: fence.fencing }
    const nctx = negotiationCtx(fenced, ctx, timing, mode)

    if (isControllerCommand(message)) {
        const t = receiveControllerCommand(fenced, message, {
            runId: ctx.runId,
            simNowSec: nctx.simNowSec,
            wallNowMs: ctx.wallNowMs,
            causationId: message.messageId,
        })
        const next = cancelRevokedHoldJobs(t.state, nctx, message.messageId)
        return { state: next, result: t.result }
    }

    if (message.type === "DOMAIN_ACK") {
        const id = message.payload.processedMessageId
        const outbox = fenced.outbox.map(e => (e.envelope.messageId === id && !e.acknowledged ? { ...e, acknowledged: true } : e))
        const result = applied(fenced.stateRevision)
        return { state: withInbox({ ...fenced, outbox }, message, result, ctx.wallNowMs), result }
    }

    const t = receiveAirportNegotiation(fenced, message, nctx)
    if (!t) {
        const result = rejected(fenced.stateRevision, "INVALID_PAYLOAD")
        return { state: withInbox(fenced, message, result, ctx.wallNowMs), result }
    }
    return { state: withInbox(t.state, message, t.result, ctx.wallNowMs), result: t.result }
}

function advanceStep(state: AirportState | null, ctx: MutationContext, tick: Tick, timing: NegotiationTiming, mode: DecisionMode): Step {
    if (state === null) return { state: null, result: rejected(0, "WRONG_PHASE") }
    const fence = checkFence(state, ctx)
    if (!fence.ok) return { state: null, result: fence.result }
    if (state.lastTickId === tick.tickId || tick.toSimSec <= state.lastAdvancedSimSec)
        return { state: null, result: { outcome: "DUPLICATE", code: "OK", stateRevision: state.stateRevision, original: { outcome: "APPLIED", code: "OK", stateRevision: state.stateRevision } } }
    const fenced: AirportState = { ...state, fencing: fence.fencing }
    const t = advanceAirport(fenced, tick, negotiationCtx(fenced, ctx, timing, mode))
    return { state: t.state, result: t.result }
}

function claimStep(state: AirportState | null, ctx: MutationContext, timing: NegotiationTiming, mode: DecisionMode): { state: AirportState | null; job: ClaimedJob | null } {
    if (state === null) return { state: null, job: null }
    const fence = checkFence(state, ctx)
    if (!fence.ok) return { state: null, job: null }
    let next: AirportState = { ...state, fencing: fence.fencing }
    const nctx = negotiationCtx(next, ctx, timing, mode)
    const claimable = Object.values(next.jobs)
        .filter(j => j.kind === "ATC_DECISION" && (j.status === "QUEUED" || (j.status === "LEASED" && (j.leaseUntilWallMs ?? 0) <= ctx.wallNowMs)))
        .sort((a, b) => {
            const pa = a.input.priority === "EMERGENCY" ? 0 : 1
            const pb = b.input.priority === "EMERGENCY" ? 0 : 1
            return pa - pb || a.input.createdAtWallMs - b.input.createdAtWallMs || a.jobId.localeCompare(b.jobId)
        })
    let changed = false
    for (const job of claimable) {
        const input = buildDecisionInput(next, job, nctx)
        if (!input) {
            next = { ...next, jobs: { ...next.jobs, [job.jobId]: { ...job, status: "CANCELLED" } } }
            changed = true
            continue
        }
        const leaseToken = crypto.randomUUID()
        const leaseUntilWallMs = ctx.wallNowMs + JOB_LEASE_MS
        const leased: Job = { ...job, status: "LEASED", leaseToken, leaseUntilWallMs, attemptCount: job.attemptCount + 1 }
        next = { ...next, jobs: { ...next.jobs, [job.jobId]: leased } }
        return { state: next, job: { ...input, jobLeaseToken: leaseToken, leaseUntilWallMs } }
    }
    return { state: changed ? next : null, job: null }
}

function commitStep(state: AirportState | null, ctx: MutationContext, commit: DecisionCommit, timing: NegotiationTiming, mode: DecisionMode): Step {
    if (state === null) return { state: null, result: rejected(0, "WRONG_PHASE") }
    const fence = checkFence(state, ctx)
    if (!fence.ok) return { state: null, result: fence.result }
    const job = state.jobs[commit.jobId]
    if (!job || job.kind !== "ATC_DECISION") return { state: null, result: rejected(state.stateRevision, "STALE_STATE") }
    if (job.status !== "LEASED" || job.leaseToken !== commit.jobLeaseToken) return { state: null, result: rejected(state.stateRevision, "INVALID_LEASE") }
    if (commit.decisionRevision !== job.decisionRevision) return { state: null, result: rejected(state.stateRevision, "STALE_STATE") }
    if (commit.decision.type !== "PROPOSE_OFFER" && commit.decision.type !== "REFUSE")
        return { state: null, result: rejected(state.stateRevision, "INVALID_PAYLOAD") }
    const fenced: AirportState = { ...state, fencing: fence.fencing }
    // Hard constraints are checked against the specific hold, not the whole queue revision.
    const t = commitAtcDecision(fenced, commit.jobId, commit.decision as AtcDecision, commit.source, negotiationCtx(fenced, ctx, timing, mode))
    return { state: t.state, result: t.result }
}

// recordTouchdown refusals surface as thrown errors carrying a domain code (server/src/simulation/landing.ts).
const TOUCHDOWN_CODES: Record<string, string> = {
    CLOSED: "CLOSED",
    WINDOW_PASSED: "DEADLINE_EXCEEDED",
    WINDOW_NOT_OPEN: "WRONG_PHASE",
    RUNWAY_OCCUPIED: "NO_CAPACITY",
}

function touchdownStep(
    state: AirportState | null,
    ctx: MutationContext,
    input: TouchdownInput,
    timing: NegotiationTiming,
    mode: DecisionMode,
): { state: AirportState | null; receipt: TouchdownReceipt | null; error: string | null } {
    const fence = fenceOnly(state, ctx)
    if (fence || state === null) return { state: null, receipt: null, error: fence?.code ?? "WRONG_PHASE" }
    const r = recordAirportTouchdown(state, input, negotiationCtx(state, ctx, timing, mode))
    if (!r.receipt) return { state: null, receipt: null, error: `${TOUCHDOWN_CODES[r.reason] ?? "STALE_STATE"}: ${r.reason}` }
    return { state: r.state === state ? null : r.state, receipt: r.receipt, error: null }
}

// ---------------------------------------------------------------- actor

// One per airport per run; actor ID `<runId>.airport.<ALP|BRV|CHR>`.
// The aggregate lives in one persisted field and is always reassigned, never mutated.
export class AirportActor extends Actor<null, null> {
    @Persisted state: AirportState | null = null
    // Wall-clock offer timing and slot lead for the transport profile and run speed.
    @Persisted timing: NegotiationTiming = negotiationTiming(RELAY_TIMING.HOSTED, RELAY_TIMING.HOSTED.defaultSpeed)
    // IMMEDIATE: rules answer requests inside receive. JOB: an ATC_DECISION job is queued for the agent runner.
    @Persisted decisionMode: DecisionMode = "IMMEDIATE"

    async initialize(context: MutationContext, initialState: AirportState): Promise<DomainResult> {
        const step = initializeEntity(this.state, context, initialState, this.id)
        if (step.state) this.state = step.state
        return step.result
    }

    // Internal repository access only; never forwarded to a browser.
    async read(): Promise<AirportState | null> {
        return this.state
    }

    // Called by the worker at start and on setSpeed. Profile defaults to HOSTED.
    async configureNegotiation(
        context: MutationContext,
        options: { profile?: TransportProfile; speed: 1 | 5 | 10; decisionMode?: DecisionMode },
    ): Promise<DomainResult> {
        const fence = fenceOnly(this.state, context)
        if (fence) return fence
        this.timing = negotiationTiming(RELAY_TIMING[options.profile ?? "HOSTED"], options.speed)
        if (options.decisionMode) this.decisionMode = options.decisionMode
        return applied(this.state?.stateRevision ?? 0)
    }

    async receive(context: MutationContext, message: ReceivedEnvelope): Promise<DomainResult> {
        const step = receiveStep(this.state, context, message, this.timing, this.decisionMode)
        if (step.state) this.state = step.state
        return step.result
    }

    async advance(context: MutationContext, tick: Tick): Promise<DomainResult> {
        const step = advanceStep(this.state, context, tick, this.timing, this.decisionMode)
        if (step.state) this.state = step.state
        return step.result
    }

    async claimWork(context: MutationContext): Promise<ClaimedJob | null> {
        const step = claimStep(this.state, context, this.timing, this.decisionMode)
        if (step.state) this.state = step.state
        return step.job
    }

    async commitDecision(context: MutationContext, commit: DecisionCommit): Promise<DomainResult> {
        const step = commitStep(this.state, context, commit, this.timing, this.decisionMode)
        if (step.state) this.state = step.state
        return step.result
    }

    async markTransportAccepted(context: MutationContext, messageId: string, transportMessageId: string): Promise<void> {
        if (fenceOnly(this.state, context) || !this.state) return
        const next = markOutboxAccepted(this.state, messageId, transportMessageId)
        if (next) this.state = next
    }

    async validateClearance(context: MutationContext, input: ClearanceCheck): Promise<ClearanceCheckResult> {
        const fence = fenceOnly(this.state, context)
        if (fence || !this.state)
            return { valid: false, reason: fence?.code ?? "WRONG_PHASE", reservationId: input.reservationId, clearanceId: input.clearanceId }
        return checkClearance(this.state, input, context.simNowSec)
    }

    // Authoritative touchdown, idempotent per clearance. Refusals throw `<DOMAIN_CODE>: <reason>`.
    async recordTouchdown(context: MutationContext, input: TouchdownInput): Promise<TouchdownReceipt> {
        const step = touchdownStep(this.state, context, input, this.timing, this.decisionMode)
        if (step.state) this.state = step.state
        if (!step.receipt) throw new Error(step.error ?? "STALE_STATE")
        return step.receipt
    }

    async onMessage() {}
}
