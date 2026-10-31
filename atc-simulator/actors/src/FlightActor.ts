import { Actor, Persisted } from "terse-sdk/actor"
import type {
    ClaimedJob,
    ClearanceCheckResult,
    DecisionCommit,
    DomainResult,
    FlightState,
    MutationContext,
    ReceivedEnvelope,
    Tick,
    TouchdownReceipt,
} from "@ghost-tower/domain/contracts"
import { markOutboxAccepted, rejected } from "./durability.js"
import { advanceEntity, fenceOnly, initializeEntity, receiveEntity } from "./entity.js"
import { receiveIncidentStep } from "./incident-receive.js"
import {
    advanceFlightStep,
    approachGuardStep,
    armFlightTimer,
    claimFlightWork,
    commitFlightDecision,
    configuredTiming,
    ensureFlightTimer,
    flightNegotiationCtx,
    flightTimerStep,
    receiveFlightStep,
    touchdownStep,
    type FlightNegotiationOptions,
} from "./flight-motion.js"
import type { DecisionMode, NegotiationTiming } from "../../packages/domain/src/negotiation.js"

// Module-level so the class has no sync methods (Terse 0.14.9).
const arm = (actor: FlightActor) => armFlightTimer(actor as unknown as Parameters<typeof armFlightTimer>[0], actor.timing)

// One per flight per run; actor ID `<runId>.flight.F001`.
export class FlightActor extends Actor<null, null> {
    @Persisted state: FlightState | null = null
    // Negotiation timing and decision mode; the worker sets them with configureNegotiation.
    @Persisted timing: NegotiationTiming = configuredTiming({ speed: 5 })
    @Persisted decisionMode: DecisionMode = "IMMEDIATE"
    // Next negotiation wall-clock deadline, persisted so a lost local alarm is re-armed.
    @Persisted timerAt: number | null = null

    async configureNegotiation(context: MutationContext, options: FlightNegotiationOptions): Promise<DomainResult> {
        const fence = fenceOnly(this.state, context)
        if (fence) return fence
        this.timing = configuredTiming(options)
        if (options.decisionMode) this.decisionMode = options.decisionMode
        arm(this)
        return { outcome: "APPLIED", code: "OK", stateRevision: this.state?.stateRevision ?? 0 }
    }

    async onAlarm() {
        this.timerAt = null
        const next = flightTimerStep(this, this.state, Date.now())
        if (next) this.state = next
        arm(this)
    }

    async initialize(context: MutationContext, initialState: FlightState): Promise<DomainResult> {
        const step = initializeEntity(this.state, context, initialState, this.id)
        if (step.state) this.state = step.state
        return step.result
    }

    async read(): Promise<FlightState | null> {
        ensureFlightTimer(this as unknown as Parameters<typeof ensureFlightTimer>[0])
        return this.state
    }

    async receive(context: MutationContext, message: ReceivedEnvelope): Promise<DomainResult> {
        // Task 3: INCIDENT_CREATE / INCIDENT_CLEAR in commandSequence order; null for other types.
        const incident = receiveIncidentStep(this.state, context, message, this.state ? flightNegotiationCtx(this, this.state, context) : null)
        if (incident) {
            if (incident.state) this.state = incident.state
            arm(this)
            return incident.result
        }
        // Negotiation replies and DOMAIN_ACKs (flight-motion.ts receiveFlightStep).
        const step = receiveFlightStep(this, this.state, context, message)
        if (step.state) this.state = step.state
        arm(this)
        return step.result
    }

    async advance(context: MutationContext, tick: Tick): Promise<DomainResult> {
        // Task 8: movement, fuel, holding, approach and terminal outcomes (flight-motion.ts).
        const step = advanceFlightStep(this, this.state, context, tick)
        if (step.state) this.state = step.state
        arm(this)
        return step.result
    }

    async claimWork(context: MutationContext): Promise<ClaimedJob | null> {
        const step = claimFlightWork(this, this.state, context)
        if (step.state) this.state = step.state
        return step.job
    }

    async commitDecision(context: MutationContext, commit: DecisionCommit): Promise<DomainResult> {
        const step = commitFlightDecision(this, this.state, context, commit)
        if (step.state) this.state = step.state
        arm(this)
        return step.result
    }

    // attemptCount / nextAttemptAtWallMs persist the dispatcher's retry schedule (survives a worker restart).
    async markTransportAccepted(
        context: MutationContext,
        messageId: string,
        transportMessageId: string | null,
        attemptCount?: number,
        nextAttemptAtWallMs?: number,
    ): Promise<void> {
        if (fenceOnly(this.state, context) || !this.state) return
        const attempt = attemptCount !== undefined && nextAttemptAtWallMs !== undefined ? { attemptCount, nextAttemptAtWallMs } : undefined
        const next = markOutboxAccepted(this.state, messageId, transportMessageId, attempt)
        if (next) this.state = next
    }

    async applyApproachGuard(context: MutationContext, result: ClearanceCheckResult): Promise<DomainResult> {
        const step = approachGuardStep(this, this.state, context, result)
        if (step.state) this.state = step.state
        arm(this)
        return step.result
    }

    async recordTouchdown(context: MutationContext, receipt: TouchdownReceipt): Promise<DomainResult> {
        const step = touchdownStep(this, this.state, context, receipt)
        if (step.state) this.state = step.state
        arm(this)
        return step.result
    }

    async onMessage() {}
}
