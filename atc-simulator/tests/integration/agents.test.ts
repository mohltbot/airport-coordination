// Task 6: actor-owned agent jobs, bounded model concurrency, and transparent fallback.
// The work source below is an in-memory stand-in that follows the actor claimWork/commitDecision
// contract (lease token, decision revision, run fence, duplicate commit). Swap in the real
// actor repository once Task 2/4 actors expose those methods.
// Live call: AGENT_LIVE_TEST=1 bun test tests/integration/agents.test.ts (needs OPENAI_API_KEY, OPENAI_MODEL).
import { describe, expect, test } from "bun:test"
import type {
    AgentDecision,
    AgentDecisionInput,
    ClaimedJob,
    DecisionCommit,
    DomainResult,
    MutationContext,
    Priority,
} from "../../packages/domain/src/contracts.ts"
import { MAX_DECISION_INPUT_BYTES, MAX_RELEVANT_MESSAGES, MODEL_TIMEOUT_MS } from "../../packages/domain/src/constants.ts"
import {
    agentModelConfigFromEnv,
    agentModelHealth,
    createAgentModel,
    OpenAIModelAdapter,
    RulesModelAdapter,
    type AgentModel,
    type FallbackPolicy,
    type ResponsesClient,
} from "../../server/src/agents/model.ts"
import { decisionJsonSchema, prepareModelInput } from "../../server/src/agents/prompts.ts"
import { AgentRunner, runAgentJobs, type AgentDecisionEvent, type AgentEntityId, type AgentWorkSource, type PendingWork } from "../../server/src/agents/runner.ts"
import { checkProposal, ModelOutputError } from "../../server/src/agents/tools.ts"
import { chooseValidAction, type AtcView, type PilotView } from "../../packages/domain/src/policy.ts"

const RUN_A = "11111111-1111-4111-8111-111111111111"
const RUN_B = "22222222-2222-4222-8222-222222222222"
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`

// ---------------------------------------------------------------- fixtures

function pilotState(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        runId: RUN_A,
        entityId: "flight:F001",
        flightId: "F001",
        callsign: "GHOST 001",
        originalDestination: "ALP",
        position: { x: 80, y: 60 },
        headingDeg: 270,
        speedKnots: 240,
        fuelRemainingSec: 3000,
        phase: "ENROUTE",
        priority: "EMERGENCY",
        deadlineSimSec: 1500,
        lastAdvancedSimSec: 600,
        lastTickId: "tick-40",
        stateRevision: 4,
        decisionRevision: 2,
        incidents: {
            [uuid(1)]: { incidentId: uuid(1), kind: "SMOKE", parameters: {}, status: "ACTIVE", createdAtSimSec: 600, revision: 1 },
            [uuid(2)]: { incidentId: uuid(2), kind: "LOW_FUEL", parameters: {}, status: "RESOLVED", createdAtSimSec: 100, revision: 2 },
        },
        knownAirportStatus: {
            ALP: { airportId: "ALP", statusRevision: 2, restrictions: { arrivalsClosed: true, closedRunways: [], occupancySec: 60, activeIncidentIds: [uuid(3)] } },
        },
        negotiation: {
            roundId: "round-F001-3",
            trigger: "SMOKE",
            candidateAirports: ["BRV", "CHR"],
            replies: [
                { airportId: "BRV", kind: "OFFER", offerId: "offer-BRV-1", code: null, slotStartSimSec: 1080, explanation: null },
                { airportId: "CHR", kind: "OFFER", offerId: "offer-CHR-1", code: null, slotStartSimSec: 1050, explanation: null },
            ],
            collectUntilWallMs: 1_000,
            stage: "COLLECTING",
        },
        pendingAcceptance: null,
        activeAssignment: null,
        releaseObligations: [],
        landingReceipt: null,
        terminalReason: null,
        inbox: { [uuid(9)]: { messageId: uuid(9), type: "LANDING_OFFER", fromEntityId: "airport:BRV", result: { outcome: "APPLIED", code: "OK", stateRevision: 3 }, processedAtWallMs: 1 } },
        outbox: [{ envelope: { messageId: uuid(10) }, recipientHandle: "ghost-11111111-atc-brv", attemptCount: 0, nextAttemptAtWallMs: 0, transportMessageId: null, acknowledged: false }],
        jobs: { "job-x": { jobId: "job-x", leaseToken: "lease-should-not-leak" } },
        fencing: { workerEpoch: 3, leaseToken: "worker-lease-should-not-leak" },
        bufferedControllerMessages: [],
        lastControllerSequence: 2,
        initializedByOperationId: "init-op",
        ...over,
    }
}

function atcState(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        runId: RUN_A,
        entityId: "airport:BRV",
        airportId: "BRV",
        name: "Bravo",
        position: { x: 110, y: 110 },
        lastAdvancedSimSec: 600,
        restrictions: { arrivalsClosed: false, closedRunways: [], occupancySec: 60, activeIncidentIds: [] },
        runways: [
            { runwayId: "R1", occupiedUntilSimSec: null },
            { runwayId: "R2", occupiedUntilSimSec: null },
        ],
        offers: {},
        reservations: {
            "res-1": { reservationId: "res-1", flightId: "F004", runwayId: "R1", slotStartSimSec: 900, occupancySec: 60, status: "CONFIRMED", priority: "NORMAL" },
            "res-0": { reservationId: "res-0", flightId: "F002", runwayId: "R2", slotStartSimSec: 300, occupancySec: 60, status: "COMPLETED", priority: "NORMAL" },
        },
        clearances: {},
        incidents: {},
        request: {
            negotiationId: "round-F001-3",
            flightId: "F001",
            position: { x: 80, y: 60 },
            speedKnots: 240,
            fuelRemainingSec: 3000,
            sampledAtSimSec: 600,
            priority: "EMERGENCY",
            deadlineSimSec: 1500,
        },
        inbox: {},
        outbox: [],
        jobs: {},
        fencing: { workerEpoch: 3, leaseToken: "worker-lease-should-not-leak" },
        ...over,
    }
}

const PILOT_ACTIONS = ["REQUEST_LANDING", "SELECT_OFFER", "HOLD"] as const
const ATC_ACTIONS = ["PROPOSE_OFFER", "REFUSE"] as const

// Deterministic stand-in for packages/domain/src/policy.ts chooseValidAction.
const stubPolicy: FallbackPolicy = input => {
    if (input.role === "PILOT") return { type: "HOLD", reason: "Policy holds until a feasible offer is confirmed." }
    const ls = input.localState as { restrictions?: { arrivalsClosed?: boolean }; request?: { negotiationId: string; flightId: string } }
    const req = ls.request ?? { negotiationId: "round-F001-3", flightId: "F001" }
    if (ls.restrictions?.arrivalsClosed) return { type: "REFUSE", negotiationId: req.negotiationId, flightId: req.flightId, code: "CLOSED", reason: "Arrivals are closed." }
    return { type: "PROPOSE_OFFER", negotiationId: req.negotiationId, flightId: req.flightId, runwayId: "R2", slotStartSimSec: 1440, reason: "Earliest free slot." }
}

// ---------------------------------------------------------------- in-memory actor work source

type FakeJob = {
    jobId: string
    role: "PILOT" | "ATC"
    status: "QUEUED" | "LEASED" | "COMMITTED" | "CANCELLED"
    priority: Priority
    trigger: string
    queuedAtWallMs: number
    allowedActions: AgentDecisionInput["allowedActions"]
    localState: Record<string, unknown>
    relevantMessages: AgentDecisionInput["relevantMessages"]
    leaseToken: string | null
    committed: DecisionCommit | null
    result: DomainResult | null
}

class FakeActors implements AgentWorkSource {
    runId = RUN_A
    jobs = new Map<AgentEntityId, FakeJob[]>()
    decisionRevision = new Map<AgentEntityId, number>()
    stateRevision = new Map<AgentEntityId, number>()
    claims: { entityId: AgentEntityId; jobId: string; runId: string }[] = []
    commits: { entityId: AgentEntityId; commit: DecisionCommit; runId: string; result: DomainResult }[] = []
    rejectNextModelCommitWith: string | null = null
    loseNextCommitResponse = false
    private leaseSeq = 0

    add(entityId: AgentEntityId, job: Partial<FakeJob> & { jobId: string }): void {
        const role = entityId.startsWith("airport:") ? "ATC" : "PILOT"
        const full: FakeJob = {
            role,
            status: "QUEUED",
            priority: "NORMAL",
            trigger: "INITIAL",
            queuedAtWallMs: 0,
            allowedActions: role === "PILOT" ? [...PILOT_ACTIONS] : [...ATC_ACTIONS],
            localState: role === "PILOT" ? pilotState({ entityId, flightId: entityId.slice(7) }) : atcState(),
            relevantMessages: [],
            leaseToken: null,
            committed: null,
            result: null,
            ...job,
        }
        this.jobs.set(entityId, [...(this.jobs.get(entityId) ?? []), full])
        if (!this.decisionRevision.has(entityId)) this.decisionRevision.set(entityId, 1)
        if (!this.stateRevision.has(entityId)) this.stateRevision.set(entityId, 1)
    }

    reset(newRunId: string): void {
        this.runId = newRunId
        this.jobs.clear()
    }

    async pendingWork(): Promise<PendingWork[]> {
        const out: PendingWork[] = []
        for (const [entityId, jobs] of this.jobs) {
            const j = jobs.find(x => x.status === "QUEUED")
            if (j) out.push({ entityId, priority: j.priority, trigger: j.trigger, queuedAtWallMs: j.queuedAtWallMs })
        }
        return out
    }

    async claimWork(entityId: AgentEntityId, ctx: MutationContext): Promise<ClaimedJob | null> {
        if (ctx.runId !== this.runId) return null
        const job = this.jobs.get(entityId)?.find(j => j.status === "QUEUED")
        if (!job) return null
        job.status = "LEASED"
        job.leaseToken = `job-lease-${++this.leaseSeq}`
        this.claims.push({ entityId, jobId: job.jobId, runId: ctx.runId })
        return {
            jobId: job.jobId,
            entityId,
            role: job.role,
            decisionRevision: this.decisionRevision.get(entityId)!,
            allowedActions: job.allowedActions,
            localState: job.localState,
            relevantMessages: job.relevantMessages,
            jobLeaseToken: job.leaseToken,
            leaseUntilWallMs: ctx.wallNowMs + 10_000,
        }
    }

    async commitDecision(entityId: AgentEntityId, ctx: MutationContext, commit: DecisionCommit): Promise<DomainResult> {
        const result = this.applyCommit(entityId, ctx, commit)
        this.commits.push({ entityId, commit, runId: ctx.runId, result })
        if (this.loseNextCommitResponse) {
            this.loseNextCommitResponse = false
            throw new Error("connection reset after commit")
        }
        return result
    }

    private applyCommit(entityId: AgentEntityId, ctx: MutationContext, commit: DecisionCommit): DomainResult {
        const rev = this.stateRevision.get(entityId) ?? 0
        if (ctx.runId !== this.runId) return { outcome: "REJECTED", code: "WRONG_RUN", stateRevision: rev }
        const job = this.jobs.get(entityId)?.find(j => j.jobId === commit.jobId)
        if (!job) return { outcome: "REJECTED", code: "STALE_STATE", stateRevision: rev }
        if (job.status === "COMMITTED") {
            if (commit.jobLeaseToken === job.leaseToken && job.result && job.result.outcome !== "DUPLICATE")
                return { outcome: "DUPLICATE", code: "OK", stateRevision: rev, original: job.result }
            return { outcome: "REJECTED", code: "INVALID_LEASE", stateRevision: rev }
        }
        if (job.status !== "LEASED" || commit.jobLeaseToken !== job.leaseToken) return { outcome: "REJECTED", code: "INVALID_LEASE", stateRevision: rev }
        if (commit.decisionRevision !== this.decisionRevision.get(entityId)) {
            job.status = "CANCELLED"
            return { outcome: "REJECTED", code: "REVISION_CONFLICT", stateRevision: rev }
        }
        if (this.rejectNextModelCommitWith && commit.source === "MODEL") {
            const code = this.rejectNextModelCommitWith
            this.rejectNextModelCommitWith = null
            return { outcome: "REJECTED", code, stateRevision: rev }
        }
        job.status = "COMMITTED"
        job.committed = commit
        this.stateRevision.set(entityId, rev + 1)
        job.result = { outcome: "APPLIED", code: "OK", stateRevision: rev + 1 }
        return job.result
    }
}

class FakeModel implements AgentModel {
    readonly source = "MODEL" as const
    readonly label = "fake-model"
    calls: AgentDecisionInput[] = []
    signals: AbortSignal[] = []
    active = 0
    maxActive = 0
    activePerEntity = new Map<string, number>()
    maxPerEntity = 0
    constructor(private readonly impl: (input: AgentDecisionInput, signal: AbortSignal) => Promise<AgentDecision>) {}
    async decide(input: AgentDecisionInput, signal: AbortSignal): Promise<AgentDecision> {
        this.calls.push(input)
        this.signals.push(signal)
        this.active++
        this.maxActive = Math.max(this.maxActive, this.active)
        const n = (this.activePerEntity.get(input.entityId) ?? 0) + 1
        this.activePerEntity.set(input.entityId, n)
        this.maxPerEntity = Math.max(this.maxPerEntity, n)
        try {
            return await this.impl(input, signal)
        } finally {
            this.active--
            this.activePerEntity.set(input.entityId, (this.activePerEntity.get(input.entityId) ?? 1) - 1)
        }
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hold: AgentDecision = { type: "HOLD", reason: "Waiting for Charlie's reply before choosing." }

function harness(source: FakeActors, model: AgentModel, over: Partial<ConstructorParameters<typeof AgentRunner>[0]> = {}) {
    const events: AgentDecisionEvent[] = []
    const errors: string[] = []
    let runId = RUN_A
    const opts = {
        source,
        model,
        fallback: stubPolicy,
        context: (operationId: string): MutationContext => ({ runId, workerEpoch: 3, leaseToken: "worker-lease", simNowSec: 600, wallNowMs: Date.now(), operationId }),
        onDecision: (e: AgentDecisionEvent) => events.push(e),
        onError: (e: { message: string }) => errors.push(e.message),
        ...over,
    }
    return { opts, events, errors, setWorkerRun: (id: string) => (runId = id) }
}

// ---------------------------------------------------------------- concurrency and ordering

describe("agent runner scheduling", () => {
    test("takes a slot before claiming: at most 4 model calls at once and one per entity", async () => {
        const src = new FakeActors()
        for (let i = 1; i <= 6; i++) src.add(`flight:F00${i}`, { jobId: `job-F00${i}-a` })
        src.add("flight:F001", { jobId: "job-F001-b" })
        src.add("flight:F001", { jobId: "job-F001-c" })
        const model = new FakeModel(async () => {
            await sleep(25)
            return hold
        })
        const h = harness(src, model)
        const runner = new AgentRunner(h.opts)
        expect(await runner.pump()).toBe(4)
        // Only the four slot holders claimed; the other jobs stay QUEUED, not leased while waiting.
        await sleep(1)
        expect(src.claims.length).toBe(4)
        await runner.runUntilIdle()
        expect(model.maxActive).toBe(4)
        expect(model.maxPerEntity).toBe(1)
        expect(src.commits.length).toBe(8)
        expect(src.commits.every(c => c.result.outcome === "APPLIED" && c.commit.source === "MODEL")).toBe(true)
    })

    test("emergencies run first, then closures, booking replies, normal arrivals", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "normal", trigger: "INITIAL", queuedAtWallMs: 1 })
        src.add("flight:F002", { jobId: "booking", trigger: "LANDING_OFFER", queuedAtWallMs: 2 })
        src.add("flight:F003", { jobId: "closure", trigger: "AIRPORT_CLOSED", queuedAtWallMs: 3 })
        src.add("flight:F004", { jobId: "emergency", trigger: "SMOKE", priority: "EMERGENCY", queuedAtWallMs: 4 })
        const model = new FakeModel(async () => hold)
        await runAgentJobs({ ...harness(src, model).opts, maxConcurrent: 1 })
        expect(src.claims.map(c => c.jobId)).toEqual(["emergency", "closure", "booking", "normal"])
    })

    test("the global cap cannot be raised above 4", async () => {
        const src = new FakeActors()
        for (let i = 1; i <= 8; i++) src.add(`flight:F00${i}`, { jobId: `j${i}` })
        const model = new FakeModel(async () => {
            await sleep(10)
            return hold
        })
        await runAgentJobs({ ...harness(src, model).opts, maxConcurrent: 16 })
        expect(model.maxActive).toBe(4)
    })
})

// ---------------------------------------------------------------- decisions and fallback

describe("model decisions and transparent fallback", () => {
    test("a valid model proposal commits as MODEL with its short reason", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1", allowedActions: ["SELECT_OFFER", "HOLD"] })
        const model = new FakeModel(async () => ({ type: "SELECT_OFFER", offerId: "offer-CHR-1", airportId: "CHR", reason: "Charlie is closer and can take us at 1050." }))
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(src.commits).toHaveLength(1)
        expect(src.commits[0]!.commit.source).toBe("MODEL")
        expect(src.commits[0]!.commit.decision).toMatchObject({ type: "SELECT_OFFER", offerId: "offer-CHR-1" })
        expect(h.events[0]).toMatchObject({ source: "MODEL", fallbackCode: null, modelLabel: "fake-model" })
    })

    test("timeout falls back to the rules policy, labelled RULES_FALLBACK", async () => {
        expect(MODEL_TIMEOUT_MS).toBe(6_000)
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1" })
        const model = new FakeModel((_input, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))))
        const h = harness(src, model, { modelTimeoutMs: 40 })
        await runAgentJobs(h.opts)
        expect(model.signals[0]!.aborted).toBe(true)
        expect(src.commits).toHaveLength(1)
        const { commit } = src.commits[0]!
        expect(commit.source).toBe("RULES_FALLBACK")
        expect(commit.decision.type).toBe("HOLD")
        expect(commit.decision.reason.startsWith("Rules fallback (TIMEOUT):")).toBe(true)
        expect(h.events[0]).toMatchObject({ source: "RULES_FALLBACK", fallbackCode: "TIMEOUT" })
    })

    test("invalid JSON from the OpenAI adapter falls back, and the request shape is pinned", async () => {
        const bodies: Record<string, unknown>[] = []
        const options: unknown[] = []
        const client: ResponsesClient = {
            responses: {
                async create(body, opts) {
                    bodies.push(body)
                    options.push(opts)
                    return { status: "completed", output_text: "{not json", output: [], usage: { input_tokens: 900, output_tokens: 12 } }
                },
            },
        }
        const adapter = new OpenAIModelAdapter({ model: "test-model", client })
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1" })
        const h = harness(src, adapter)
        await runAgentJobs(h.opts)
        expect(h.events[0]).toMatchObject({ source: "RULES_FALLBACK", fallbackCode: "INVALID_OUTPUT" })
        expect(src.commits[0]!.commit.source).toBe("RULES_FALLBACK")
        const body = bodies[0]!
        expect(body.model).toBe("test-model")
        expect(body.store).toBe(false)
        expect(body.reasoning).toEqual({ effort: "none" })
        expect((body.text as { format: { type: string; strict: boolean } }).format).toMatchObject({ type: "json_schema", strict: true, name: "pilot_decision" })
        expect(options[0]).toMatchObject({ timeout: MODEL_TIMEOUT_MS, maxRetries: 0 })
        const wire = JSON.stringify(body)
        for (const secret of ["lease-should-not-leak", "worker-lease", "job-lease-", '"inbox"', '"outbox"', '"fencing"', uuid(9)]) expect(wire.includes(secret)).toBe(false)
    })

    test("a model-invented airport is malformed output and falls back", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1" })
        const model = new FakeModel(async () => ({ type: "REQUEST_LANDING", airportIds: ["DLT"], reason: "Delta looks quiet." }) as unknown as AgentDecision)
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(h.events[0]).toMatchObject({ source: "RULES_FALLBACK", fallbackCode: "INVALID_OUTPUT" })
    })

    test("a model-invented offer is a rule violation and falls back", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1" })
        const model = new FakeModel(async () => ({ type: "SELECT_OFFER", offerId: "offer-ALP-9", airportId: "ALP", reason: "Alpha is home." }))
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(h.events[0]).toMatchObject({ source: "RULES_FALLBACK", fallbackCode: "RULE_VIOLATION" })
        expect(h.events[0]!.fallbackDetail).toContain("never received")
    })

    test("a model-invented slot off the 30 s grid falls back", async () => {
        const src = new FakeActors()
        src.add("airport:BRV", { jobId: "a1" })
        const model = new FakeModel(async () => ({ type: "PROPOSE_OFFER", negotiationId: "round-F001-3", flightId: "F001", runwayId: "R2", slotStartSimSec: 1415, reason: "Soon." }))
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(h.events[0]).toMatchObject({ source: "RULES_FALLBACK", fallbackCode: "RULE_VIOLATION" })
        expect(src.commits[0]!.commit.decision).toMatchObject({ type: "PROPOSE_OFFER", slotStartSimSec: 1440 })
    })

    test("an ATC offer into a hard closure becomes the rules refusal", async () => {
        const src = new FakeActors()
        src.add("airport:BRV", { jobId: "a1", localState: atcState({ restrictions: { arrivalsClosed: true, closedRunways: [], occupancySec: 60, activeIncidentIds: [uuid(3)] } }) })
        const model = new FakeModel(async () => ({ type: "PROPOSE_OFFER", negotiationId: "round-F001-3", flightId: "F001", runwayId: "R1", slotStartSimSec: 1440, reason: "Emergency, so offering anyway." }))
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(h.events[0]).toMatchObject({ source: "RULES_FALLBACK", fallbackCode: "RULE_VIOLATION" })
        expect(src.commits[0]!.commit.decision).toMatchObject({ type: "REFUSE", code: "CLOSED" })
    })

    test("oversized required facts never reach the model", async () => {
        const src = new FakeActors()
        const offers: Record<string, unknown> = {}
        for (let i = 0; i < 400; i++) offers[`offer-${i}`] = { offerId: `offer-${i}`, flightId: "F002", runwayId: "R1", slotStartSimSec: 900 + i * 30, occupancySec: 60, status: "OFFERED" }
        src.add("airport:BRV", { jobId: "a1", localState: atcState({ offers }) })
        const model = new FakeModel(async () => hold)
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(model.calls).toHaveLength(0)
        expect(h.events[0]).toMatchObject({ source: "RULES_FALLBACK", fallbackCode: "INPUT_TOO_LARGE" })
    })

    test("an actor rule rejection of a model proposal commits the policy instead", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1" })
        src.rejectNextModelCommitWith = "OFFER_EXPIRED"
        const model = new FakeModel(async () => ({ type: "SELECT_OFFER", offerId: "offer-BRV-1", airportId: "BRV", reason: "Bravo first." }))
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(src.commits.map(c => [c.commit.source, c.result.outcome])).toEqual([
            ["MODEL", "REJECTED"],
            ["RULES_FALLBACK", "APPLIED"],
        ])
        expect(h.events[0]).toMatchObject({ fallbackCode: "COMMIT_REJECTED" })
    })

    test("rules mode makes no model call and never claims to be a model", async () => {
        const model = createAgentModel({ AGENT_MODE: "rules" }, stubPolicy)
        expect(model).toBeInstanceOf(RulesModelAdapter)
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1" })
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(src.commits[0]!.commit.source).toBe("RULES_FALLBACK")
        expect(src.commits[0]!.commit.decision.reason.startsWith("Rules:")).toBe(true)
        expect(h.events[0]).toMatchObject({ fallbackCode: "RULES_MODE", modelLabel: "rules" })
    })
})

// ---------------------------------------------------------------- revisions, duplicates, reset

describe("revision guards", () => {
    test("an incident during inference makes the result stale; no fallback replaces it", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1" })
        const model = new FakeModel(async input => {
            src.decisionRevision.set(input.entityId as AgentEntityId, 2) // incident/reservation change
            return hold
        })
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(src.commits).toHaveLength(1)
        expect(src.commits[0]!.result).toMatchObject({ outcome: "REJECTED", code: "REVISION_CONFLICT" })
        expect(h.events[0]).toMatchObject({ source: "MODEL", fallbackCode: null })
    })

    test("movement-only stateRevision changes do not reject the decision", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1" })
        const model = new FakeModel(async input => {
            const id = input.entityId as AgentEntityId
            src.stateRevision.set(id, (src.stateRevision.get(id) ?? 0) + 5) // five movement ticks
            return hold
        })
        await runAgentJobs(harness(src, model).opts)
        expect(src.commits[0]!.result.outcome).toBe("APPLIED")
    })

    test("a duplicate leased result applies once", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1" })
        src.loseNextCommitResponse = true
        const model = new FakeModel(async () => hold)
        const h = harness(src, model)
        await runAgentJobs(h.opts)
        expect(h.errors[0]).toContain("connection reset")
        // The worker retries the same commit after the lost response: the actor returns DUPLICATE.
        const first = src.commits[0]!
        const again = await src.commitDecision("flight:F001", h.opts.context("retry"), first.commit)
        expect(again.outcome).toBe("DUPLICATE")
        await runAgentJobs(h.opts)
        expect(model.calls).toHaveLength(1)
        expect(src.commits.filter(c => c.result.outcome === "APPLIED")).toHaveLength(1)
    })

    test("a delayed model result after reset cannot mutate the new run", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "old-run-job" })
        let release!: () => void
        const gate = new Promise<void>(r => (release = r))
        const model = new FakeModel(async () => {
            await gate
            return hold
        })
        const h = harness(src, model)
        const runner = new AgentRunner(h.opts)
        await runner.pump()
        await sleep(5)
        src.reset(RUN_B) // operator Reset while the old run's model call is in flight
        src.add("flight:F001", { jobId: "new-run-job" })
        release()
        await runner.drain()
        expect(src.commits).toHaveLength(1)
        expect(src.commits[0]!.result).toMatchObject({ outcome: "REJECTED", code: "WRONG_RUN" })
        expect(src.jobs.get("flight:F001")![0]!.status).toBe("QUEUED")
        // The old worker context still cannot claim new-run work.
        await runner.runUntilIdle()
        expect(src.claims.filter(c => c.runId === RUN_B)).toHaveLength(0)
    })
})

// ---------------------------------------------------------------- model view and schema

describe("model view", () => {
    test("keeps the latest 12 messages, caps summaries at 512 chars, and hides internals", () => {
        const messages = Array.from({ length: 20 }, (_, i) => ({
            messageId: uuid(100 + i),
            type: "LANDING_OFFER" as const,
            fromEntityId: "airport:BRV" as const,
            summary: i === 19 ? "x".repeat(2000) : `offer ${i}`,
        }))
        const { input, bytes } = prepareModelInput({
            jobId: "j1",
            entityId: "flight:F001",
            role: "PILOT",
            decisionRevision: 2,
            allowedActions: [...PILOT_ACTIONS],
            localState: pilotState(),
            relevantMessages: messages,
        })
        expect(input.relevantMessages).toHaveLength(MAX_RELEVANT_MESSAGES)
        expect(input.relevantMessages[0]!.summary).toBe("offer 8")
        expect(input.relevantMessages[11]!.summary.length).toBe(512)
        expect(bytes).toBeLessThanOrEqual(MAX_DECISION_INPUT_BYTES)
        const ls = input.localState
        for (const k of ["inbox", "outbox", "jobs", "fencing", "bufferedControllerMessages", "lastControllerSequence", "initializedByOperationId"]) expect(k in ls).toBe(false)
        expect(ls.simNowSec).toBe(600)
        expect((ls.incidents as unknown[]).length).toBe(1)
        expect((ls.airportDirectory as { airportId: string }[]).map(a => a.airportId)).toEqual(["ALP", "BRV", "CHR"])
    })

    test("the strict schema offers only allowed actions and the offer IDs the pilot received", () => {
        const input: AgentDecisionInput = {
            jobId: "j1",
            entityId: "flight:F001",
            role: "PILOT",
            decisionRevision: 2,
            allowedActions: ["SELECT_OFFER", "HOLD", "PROPOSE_OFFER"],
            localState: pilotState(),
            relevantMessages: [],
        }
        const schema = decisionJsonSchema(prepareModelInput(input).input) as { properties: { decision: { anyOf: { properties: Record<string, { enum?: string[] }> }[] } } }
        const variants = schema.properties.decision.anyOf
        expect(variants.map(v => v.properties.type!.enum![0])).toEqual(["SELECT_OFFER", "HOLD"])
        expect(variants[0]!.properties.offerId!.enum).toEqual(["offer-BRV-1", "offer-CHR-1"])
        expect(checkProposal(input, { type: "SELECT_OFFER", offerId: "offer-BRV-1", airportId: "CHR", reason: "x" })).toMatchObject({ ok: false })
    })
})

// ---------------------------------------------------------------- policy views (negotiation.ts shapes)

describe("with the domain policy and its decision views", () => {
    const pilotView = (over: Partial<PilotView> = {}): PilotView => ({
        role: "PILOT",
        flightId: "F001",
        simNowSec: 600,
        phase: "ENROUTE",
        priority: "EMERGENCY",
        deadlineSimSec: 1500,
        fuelRemainingSec: 3000,
        speedKnots: 240,
        originalDestination: "ALP",
        roundId: "round-F001-3",
        stage: "COLLECTING",
        requestCandidates: [],
        offers: [
            { offerId: "offer-BRV-1", airportId: "BRV", runwayId: "R2", slotStartSimSec: 1080, distanceNm: 58.3, feasible: true, isOriginalDestination: false },
            { offerId: "offer-CHR-1", airportId: "CHR", runwayId: "R1", slotStartSimSec: 1050, distanceNm: 90.6, feasible: false, isOriginalDestination: false },
        ],
        refusals: [{ airportId: "ALP", code: "CLOSED", explanation: "Weather" }],
        activeAssignment: null,
        clearanceDue: false,
        ...over,
    })
    const atcView = (over: Partial<AtcView> = {}): AtcView => ({
        role: "ATC",
        airportId: "BRV",
        simNowSec: 600,
        arrivalsClosed: false,
        closedRunways: [],
        occupancySec: 60,
        request: { negotiationId: "round-F001-3", flightId: "F001", priority: "EMERGENCY", deadlineSimSec: 1500 },
        held: { offerId: "offer-BRV-1", runwayId: "R2", slotStartSimSec: 1080 },
        queue: [{ flightId: "F004", runwayId: "R1", slotStartSimSec: 900, priority: "NORMAL", status: "CONFIRMED" }],
        ...over,
    })

    test("the compact view keeps policy offers, and an infeasible offer pick falls back to the closest feasible", async () => {
        const src = new FakeActors()
        src.add("flight:F001", { jobId: "j1", allowedActions: ["SELECT_OFFER", "HOLD"], localState: pilotView() as unknown as Record<string, unknown> })
        const model = new FakeModel(async () => ({ type: "SELECT_OFFER", offerId: "offer-CHR-1", airportId: "CHR", reason: "Charlie's slot is earlier." }))
        const h = harness(src, model, { fallback: chooseValidAction })
        await runAgentJobs(h.opts)
        expect((model.calls[0]!.localState.offers as unknown[]).length).toBe(2)
        expect(h.events[0]).toMatchObject({ source: "RULES_FALLBACK", fallbackCode: "RULE_VIOLATION" })
        expect(src.commits[0]!.commit.decision).toMatchObject({ type: "SELECT_OFFER", offerId: "offer-BRV-1", airportId: "BRV" })
    })

    test("ATC views: an offer while closed or with no held slot becomes the policy refusal", async () => {
        for (const [view, code] of [
            [atcView({ arrivalsClosed: true, held: null }), "CLOSED"],
            [atcView({ held: null }), "NO_CAPACITY"],
        ] as const) {
            const src = new FakeActors()
            src.add("airport:BRV", { jobId: "a1", localState: view as unknown as Record<string, unknown> })
            const model = new FakeModel(async () => ({ type: "PROPOSE_OFFER", negotiationId: "round-F001-3", flightId: "F001", runwayId: "R1", slotStartSimSec: 1440, reason: "Squeeze it in." }))
            const h = harness(src, model, { fallback: chooseValidAction })
            await runAgentJobs(h.opts)
            expect(h.events[0]).toMatchObject({ source: "RULES_FALLBACK", fallbackCode: "RULE_VIOLATION" })
            expect(src.commits[0]!.commit.decision).toMatchObject({ type: "REFUSE", code })
        }
    })

    test("an ATC model offer of the held slot commits as MODEL", async () => {
        const src = new FakeActors()
        src.add("airport:BRV", { jobId: "a1", localState: atcView() as unknown as Record<string, unknown> })
        const model = new FakeModel(async () => ({ type: "PROPOSE_OFFER", negotiationId: "round-F001-3", flightId: "F001", runwayId: "R2", slotStartSimSec: 1080, reason: "Emergency: R2 at T+480 s is our earliest free time." }))
        const h = harness(src, model, { fallback: chooseValidAction })
        await runAgentJobs(h.opts)
        expect(h.events[0]).toMatchObject({ source: "MODEL", fallbackCode: null })
    })
})

// ---------------------------------------------------------------- configuration

describe("model configuration", () => {
    test("live mode requires a key and a model; rules mode needs neither and reports DEGRADED", () => {
        expect(() => agentModelConfigFromEnv({ AGENT_MODE: "live", OPENAI_MODEL: "m" })).toThrow("OPENAI_API_KEY")
        expect(() => agentModelConfigFromEnv({ AGENT_MODE: "live", OPENAI_API_KEY: "sk-test" })).toThrow("OPENAI_MODEL")
        expect(agentModelConfigFromEnv({ AGENT_MODE: "rules" })).toEqual({ mode: "rules" })
        expect(agentModelHealth({ AGENT_MODE: "rules" }).status).toBe("DEGRADED")
        expect(agentModelHealth({ AGENT_MODE: "live", OPENAI_MODEL: "m" }).status).toBe("UNAVAILABLE")
        const ready = agentModelHealth({ AGENT_MODE: "live", OPENAI_MODEL: "m", OPENAI_API_KEY: "sk-secret-value-123" })
        expect(ready.status).toBe("READY")
        expect(JSON.stringify(ready).includes("sk-secret")).toBe(false)
    })

    test("ModelOutputError carries the INVALID_OUTPUT code", () => {
        expect(new ModelOutputError("INVALID_OUTPUT", "x").code).toBe("INVALID_OUTPUT")
    })
})

// ---------------------------------------------------------------- one real model call (opt-in)

describe.skipIf(!process.env.AGENT_LIVE_TEST)("live model", () => {
    test(
        "one structured decision from the configured model passes the proposal checks",
        async () => {
            const cfg = agentModelConfigFromEnv({ ...process.env, AGENT_MODE: "live" })
            if (cfg.mode !== "live") throw new Error("unreachable")
            let usage: { latencyMs: number; inputTokens: number | null; outputTokens: number | null } | null = null
            const adapter = new OpenAIModelAdapter({ model: cfg.model, apiKey: cfg.apiKey, reasoningEffort: cfg.reasoningEffort, onUsage: u => (usage = u) })
            const input: AgentDecisionInput = {
                jobId: "live-1",
                entityId: "flight:F001",
                role: "PILOT",
                decisionRevision: 2,
                allowedActions: ["SELECT_OFFER", "HOLD"],
                localState: pilotState(),
                relevantMessages: [
                    { messageId: uuid(201), type: "LANDING_OFFER", fromEntityId: "airport:BRV", summary: "BRV offers offerId=offer-BRV-1 runway R2 slot 1080" },
                    { messageId: uuid(202), type: "LANDING_OFFER", fromEntityId: "airport:CHR", summary: "CHR offers offerId=offer-CHR-1 runway R1 slot 1050" },
                ],
            }
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS)
            const decision = await adapter.decide(prepareModelInput(input).input, controller.signal)
            clearTimeout(timer)
            expect(["SELECT_OFFER", "HOLD"]).toContain(decision.type)
            expect(checkProposal(input, decision)).toEqual({ ok: true })
            expect(decision.reason.length).toBeLessThanOrEqual(240)
            console.log(`[live] model=${cfg.model} decision=${decision.type} latencyMs=${usage!.latencyMs} in=${usage!.inputTokens} out=${usage!.outputTokens} reason="${decision.reason}"`)
        },
        { timeout: 15_000 },
    )
})
