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
import { advanceFlightStep, approachGuardStep, touchdownStep } from "./flight-motion.js"

// One per flight per run; actor ID `<runId>.flight.F001`.
export class FlightActor extends Actor<null, null> {
    @Persisted state: FlightState | null = null

    async initialize(context: MutationContext, initialState: FlightState): Promise<DomainResult> {
        const step = initializeEntity(this.state, context, initialState, this.id)
        if (step.state) this.state = step.state
        return step.result
    }

    async read(): Promise<FlightState | null> {
        return this.state
    }

    async receive(context: MutationContext, message: ReceivedEnvelope): Promise<DomainResult> {
        // Task 3: INCIDENT_CREATE / INCIDENT_CLEAR in commandSequence order; null for other types.
        const incident = receiveIncidentStep(this.state, context, message)
        if (incident) {
            if (incident.state) this.state = incident.state
            return incident.result
        }
        const step = receiveEntity(this.state, context, message)
        if (step.state) this.state = step.state
        return step.result
    }

    async advance(context: MutationContext, tick: Tick): Promise<DomainResult> {
        // Task 8: movement, fuel, holding, approach and terminal outcomes (flight-motion.ts).
        const step = advanceFlightStep(this, this.state, context, tick)
        if (step.state) this.state = step.state
        return step.result
    }

    async claimWork(context: MutationContext): Promise<ClaimedJob | null> {
        if (fenceOnly(this.state, context)) return null
        return null // Task 6
    }

    async commitDecision(context: MutationContext, commit: DecisionCommit): Promise<DomainResult> {
        return fenceOnly(this.state, context) ?? rejected(this.state?.stateRevision ?? 0, "NOT_IMPLEMENTED") // Task 6
    }

    async markTransportAccepted(context: MutationContext, messageId: string, transportMessageId: string): Promise<void> {
        if (fenceOnly(this.state, context) || !this.state) return
        const next = markOutboxAccepted(this.state, messageId, transportMessageId)
        if (next) this.state = next
    }

    async applyApproachGuard(context: MutationContext, result: ClearanceCheckResult): Promise<DomainResult> {
        const step = approachGuardStep(this, this.state, context, result)
        if (step.state) this.state = step.state
        return step.result
    }

    async recordTouchdown(context: MutationContext, receipt: TouchdownReceipt): Promise<DomainResult> {
        const step = touchdownStep(this, this.state, context, receipt)
        if (step.state) this.state = step.state
        return step.result
    }

    async onMessage() {}
}
