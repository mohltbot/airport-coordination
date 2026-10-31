// Shared entity transitions for AirportActor and FlightActor (module-level; see durability.ts).
import type { DomainResult, MutationContext, ReceivedEnvelope, Tick } from "@ghost-tower/domain/contracts"
import { applied, checkFence, rejected } from "./durability.js"

type EntityLike = {
    runId: string
    entityId: string
    stateRevision: number
    lastTickId: string | null
    lastAdvancedSimSec: number
    fencing: { workerEpoch: number; leaseToken: string | null }
    inbox: Record<string, { result: { outcome: "APPLIED" | "REJECTED"; code: string; stateRevision: number } }>
    initializedByOperationId: string
}

export type Step<S> = { state: S | null; result: DomainResult }

export function initializeEntity<S extends EntityLike>(current: S | null, ctx: MutationContext, initial: S, actorId: string): Step<S> {
    if (current !== null) {
        if (current.runId !== ctx.runId) return { state: null, result: rejected(current.stateRevision, "WRONG_RUN") }
        return { state: null, result: { outcome: "DUPLICATE", code: "OK", stateRevision: current.stateRevision, original: applied(1) } }
    }
    if (initial.runId !== ctx.runId) return { state: null, result: rejected(0, "WRONG_RUN") }
    const suffix = `.${initial.entityId.replace(":", ".")}`
    if (!actorId.endsWith(suffix)) return { state: null, result: rejected(0, "INVALID_PAYLOAD") }
    const state = {
        ...structuredClone(initial),
        stateRevision: 1,
        fencing: { workerEpoch: ctx.workerEpoch, leaseToken: ctx.leaseToken },
        initializedByOperationId: ctx.operationId,
    }
    return { state, result: applied(1) }
}

// Dedup and fence for an incoming Relay message. Domain handling arrives in Tasks 3 to 5.
export function receiveEntity<S extends EntityLike>(current: S | null, ctx: MutationContext, message: ReceivedEnvelope): Step<S> {
    if (current === null) return { state: null, result: rejected(0, "WRONG_PHASE") }
    if (message.runId !== current.runId) return { state: null, result: rejected(current.stateRevision, "WRONG_RUN") }
    const fence = checkFence(current, ctx)
    if (!fence.ok) return { state: null, result: fence.result }
    const seen = current.inbox[message.messageId]
    if (seen) return { state: null, result: { outcome: "DUPLICATE", code: seen.result.code, stateRevision: current.stateRevision, original: seen.result } }
    return { state: null, result: rejected(current.stateRevision, "NOT_IMPLEMENTED") }
}

// Tick bookkeeping: each tick ID applies once and time never runs backwards. Movement is Task 8.
export function advanceEntity<S extends EntityLike>(current: S | null, ctx: MutationContext, tick: Tick): Step<S> {
    if (current === null) return { state: null, result: rejected(0, "WRONG_PHASE") }
    const fence = checkFence(current, ctx)
    if (!fence.ok) return { state: null, result: fence.result }
    if (current.lastTickId === tick.tickId || tick.toSimSec <= current.lastAdvancedSimSec) {
        return { state: null, result: { outcome: "DUPLICATE", code: "OK", stateRevision: current.stateRevision, original: applied(current.stateRevision) } }
    }
    const state = { ...current, fencing: fence.fencing, lastTickId: tick.tickId, lastAdvancedSimSec: tick.toSimSec, stateRevision: current.stateRevision + 1 }
    return { state, result: applied(state.stateRevision) }
}

export function fenceOnly<S extends EntityLike>(current: S | null, ctx: MutationContext): DomainResult | null {
    if (current === null) return rejected(0, "WRONG_PHASE")
    const fence = checkFence(current, ctx)
    return fence.ok ? null : fence.result
}
