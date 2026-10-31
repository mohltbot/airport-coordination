// Job leasing, bounded concurrency, and transparent fallback (design §7 "Model jobs").
// Order per job: take a global slot and the entity's single slot, then claim (never hold a
// job while waiting for a slot), run one structured decision with a 6 s timeout, check the
// proposal, commit with the claim's lease token and decision revision, release the slots.
// No actor mutation is held open during inference: claim and commit are separate actor calls.
import type {
    AgentDecision,
    AgentDecisionInput,
    AirportEntityId,
    ClaimedJob,
    DecisionCommit,
    DecisionSource,
    DomainResult,
    FlightEntityId,
    Job,
    MutationContext,
    Priority,
} from "@ghost-tower/domain/contracts"
import { MAX_CONCURRENT_MODEL_CALLS, MODEL_TIMEOUT_MS } from "@ghost-tower/domain/constants"
import type { AgentModel, FallbackPolicy } from "./model.ts"
import { InputTooLargeError, prepareModelInput } from "./prompts.ts"
import { checkProposal, collectFacts, fallbackReason, ModelOutputError, STALE_COMMIT_CODES, validateDecisionShape, type FallbackCode } from "./tools.ts"

export type AgentEntityId = AirportEntityId | FlightEntityId

// What the worker (Task 8) supplies: cheap reads of who has queued work, and the actor calls.
export interface AgentWorkSource {
    pendingWork(): Promise<PendingWork[]>
    claimWork(entityId: AgentEntityId, context: MutationContext): Promise<ClaimedJob | null>
    commitDecision(entityId: AgentEntityId, context: MutationContext, commit: DecisionCommit): Promise<DomainResult>
}

export type PendingWork = {
    entityId: AgentEntityId
    priority: Priority
    trigger: string // the job's input.trigger, e.g. EMERGENCY, AIRPORT_CLOSED, LANDING_OFFER, INITIAL
    queuedAtWallMs: number
}

export type AgentDecisionEvent = {
    entityId: AgentEntityId
    jobId: string
    role: AgentDecisionInput["role"]
    decisionRevision: number
    source: DecisionSource
    decision: AgentDecision
    modelLabel: string
    fallbackCode: FallbackCode | null
    fallbackDetail: string | null
    latencyMs: number
    result: DomainResult
}

export type AgentRunnerErrorEvent = { entityId: AgentEntityId; jobId: string | null; stage: "claim" | "policy" | "commit"; message: string }

export type AgentRunnerOptions = {
    source: AgentWorkSource
    model: AgentModel
    fallback: FallbackPolicy
    // Fresh mutation context from the worker lease: current run, epoch, lease token, sim and wall time.
    context: (operationId: string) => MutationContext
    onDecision?: (event: AgentDecisionEvent) => void
    onError?: (event: AgentRunnerErrorEvent) => void
    maxConcurrent?: number
    modelTimeoutMs?: number
    now?: () => number
}

// Lower rank runs first: flight emergencies, closures, booking replies, then normal arrivals.
const CLOSURE_TRIGGER = /CLOS|REVOK|WEATHER|RUNWAY|INVALIDAT|DIVERT/i
const BOOKING_TRIGGER = /OFFER|REFUS|CONFIRM|REPLY|REQUEST|STATUS|CLEARANCE|TIMEOUT|COLLECT/i
export function workRank(work: Pick<PendingWork, "priority" | "trigger">): number {
    if (work.priority === "EMERGENCY") return 0
    if (CLOSURE_TRIGGER.test(work.trigger)) return 1
    if (BOOKING_TRIGGER.test(work.trigger)) return 2
    return 3
}

export function sortPendingWork(work: PendingWork[]): PendingWork[] {
    return [...work].sort(
        (a, b) => workRank(a) - workRank(b) || a.queuedAtWallMs - b.queuedAtWallMs || (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0),
    )
}

// Helper for AgentWorkSource.pendingWork: the most urgent claimable job of one entity, read
// from its durable jobs record. A LEASED job whose lease ran out is claimable again.
export function pendingWorkFromJobs(entityId: AgentEntityId, jobs: Record<string, Job>, nowWallMs: number): PendingWork | null {
    const claimable = Object.values(jobs).filter(
        j => j.status === "QUEUED" || (j.status === "LEASED" && j.leaseUntilWallMs !== null && j.leaseUntilWallMs <= nowWallMs),
    )
    if (claimable.length === 0) return null
    const hints = claimable.map(j => ({ entityId, priority: j.input.priority, trigger: j.input.trigger, queuedAtWallMs: j.input.createdAtWallMs }))
    return sortPendingWork(hints)[0]!
}

class TimeoutError extends Error {
    constructor(ms: number) {
        super(`model did not answer within ${ms} ms`)
        this.name = "TimeoutError"
    }
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort()
            reject(new TimeoutError(ms))
        }, ms)
    })
    const work = run(controller.signal)
    work.catch(() => {}) // a late rejection after the timeout is expected and ignored
    try {
        return await Promise.race([work, timeout])
    } finally {
        clearTimeout(timer)
    }
}

// The model never sees lease metadata.
export function toDecisionInput(job: ClaimedJob): AgentDecisionInput {
    return {
        jobId: job.jobId,
        entityId: job.entityId,
        role: job.role,
        decisionRevision: job.decisionRevision,
        allowedActions: job.allowedActions,
        localState: job.localState,
        relevantMessages: job.relevantMessages,
    }
}

type Proposal = { decision: AgentDecision; source: DecisionSource; fallbackCode: FallbackCode | null; fallbackDetail: string | null }

export class AgentRunner {
    private readonly busy = new Set<string>()
    private readonly inFlight = new Set<Promise<void>>()
    private readonly max: number
    private readonly timeoutMs: number
    private readonly now: () => number
    private seq = 0

    constructor(private readonly opts: AgentRunnerOptions) {
        this.max = Math.min(opts.maxConcurrent ?? MAX_CONCURRENT_MODEL_CALLS, MAX_CONCURRENT_MODEL_CALLS)
        this.timeoutMs = opts.modelTimeoutMs ?? MODEL_TIMEOUT_MS
        this.now = opts.now ?? Date.now
    }

    get activeCount(): number {
        return this.busy.size
    }

    // Starts work into free slots without waiting for it to finish. Safe to call every worker
    // loop iteration. Returns how many entity jobs were started.
    async pump(): Promise<number> {
        if (this.busy.size >= this.max) return 0
        const work = sortPendingWork(await this.opts.source.pendingWork())
        let started = 0
        for (const w of work) {
            if (this.busy.size >= this.max) break
            if (this.busy.has(w.entityId)) continue
            this.busy.add(w.entityId) // global slot and per-entity slot taken before the claim
            const p = this.runEntity(w.entityId).finally(() => {
                this.busy.delete(w.entityId)
                this.inFlight.delete(p)
            })
            this.inFlight.add(p)
            started++
        }
        return started
    }

    async drain(): Promise<void> {
        while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
    }

    // One full pass: fill slots, wait, refill until no claimable work is left or nothing starts.
    async runUntilIdle(maxPasses = 100): Promise<void> {
        for (let i = 0; i < maxPasses; i++) {
            const started = await this.pump()
            if (started === 0 && this.inFlight.size === 0) return
            await Promise.race([...this.inFlight])
        }
        await this.drain()
    }

    private op(kind: string, id: string): string {
        return `agent:${kind}:${id}:${++this.seq}`
    }

    private async runEntity(entityId: AgentEntityId): Promise<void> {
        const { source, onError } = this.opts
        let job: ClaimedJob | null
        try {
            job = await source.claimWork(entityId, this.opts.context(this.op("claim", entityId)))
        } catch (err) {
            onError?.({ entityId, jobId: null, stage: "claim", message: errorMessage(err) })
            return
        }
        if (!job) return
        const input = toDecisionInput(job)
        const started = this.now()
        let proposal: Proposal
        try {
            proposal = await this.propose(input)
        } catch (err) {
            // The policy itself failed. Leave the job; its lease expires and the actor requeues it.
            onError?.({ entityId, jobId: job.jobId, stage: "policy", message: errorMessage(err) })
            return
        }
        let result: DomainResult
        try {
            result = await this.commit(entityId, job, proposal)
        } catch (err) {
            onError?.({ entityId, jobId: job.jobId, stage: "commit", message: errorMessage(err) })
            return
        }
        // The actor rejected a model proposal on a domain rule: commit the policy decision instead.
        if (result.outcome === "REJECTED" && proposal.source === "MODEL" && !STALE_COMMIT_CODES.has(result.code)) {
            const rejected = proposal
            try {
                proposal = this.fallback(input, "COMMIT_REJECTED", `actor rejected ${rejected.decision.type}: ${result.code}`)
                result = await this.commit(entityId, job, proposal)
            } catch (err) {
                onError?.({ entityId, jobId: job.jobId, stage: "commit", message: errorMessage(err) })
                return
            }
        }
        this.opts.onDecision?.({
            entityId,
            jobId: job.jobId,
            role: job.role,
            decisionRevision: job.decisionRevision,
            source: proposal.source,
            decision: proposal.decision,
            modelLabel: proposal.source === "MODEL" ? this.opts.model.label : "rules",
            fallbackCode: proposal.fallbackCode,
            fallbackDetail: proposal.fallbackDetail,
            latencyMs: this.now() - started,
            result,
        })
    }

    private commit(entityId: AgentEntityId, job: ClaimedJob, proposal: Proposal): Promise<DomainResult> {
        const commit: DecisionCommit = {
            jobId: job.jobId,
            jobLeaseToken: job.jobLeaseToken,
            decisionRevision: job.decisionRevision,
            decision: proposal.decision,
            source: proposal.source,
        }
        return this.opts.source.commitDecision(entityId, this.opts.context(this.op("commit", job.jobId)), commit)
    }

    private fallback(input: AgentDecisionInput, code: FallbackCode, detail: string | null): Proposal {
        const raw = this.opts.fallback(input)
        const decision = validateDecisionShape(input, raw)
        return { decision: { ...decision, reason: fallbackReason(code, decision.reason) }, source: "RULES_FALLBACK", fallbackCode: code, fallbackDetail: detail }
    }

    private async propose(input: AgentDecisionInput): Promise<Proposal> {
        const { model } = this.opts
        if (model.source !== "MODEL") return this.fallback(input, "RULES_MODE", null)
        let prepared
        try {
            prepared = prepareModelInput(input)
        } catch (err) {
            if (err instanceof InputTooLargeError) return this.fallback(input, "INPUT_TOO_LARGE", err.message)
            throw err
        }
        let decision: AgentDecision
        try {
            const raw = await withTimeout(signal => model.decide(prepared.input, signal), this.timeoutMs)
            decision = validateDecisionShape(input, raw)
        } catch (err) {
            if (err instanceof TimeoutError) return this.fallback(input, "TIMEOUT", err.message)
            if (err instanceof ModelOutputError) return this.fallback(input, "INVALID_OUTPUT", err.message)
            return this.fallback(input, "MODEL_ERROR", errorMessage(err))
        }
        const check = checkProposal(input, decision, collectFacts(prepared.input))
        if (!check.ok) return this.fallback(input, "RULE_VIOLATION", check.detail)
        return { decision, source: "MODEL", fallbackCode: null, fallbackDetail: null }
    }
}

// Convenience for tests and simple loops: run claimable work until idle.
export async function runAgentJobs(opts: AgentRunnerOptions): Promise<void> {
    await new AgentRunner(opts).runUntilIdle()
}

function errorMessage(err: unknown): string {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    // Never echo credentials that an SDK error might carry.
    return msg.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-[REDACTED]").slice(0, 300)
}
