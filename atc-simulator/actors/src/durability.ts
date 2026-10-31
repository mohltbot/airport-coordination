// Module-level helpers shared by entity actors. Sync methods on an actor class throw in
// Terse 0.14.9, so pure logic lives here. Every helper returns new objects; callers reassign.
import type { DomainResult, Fencing, MutationContext } from "@ghost-tower/domain/contracts"

export type Rejection = { outcome: "REJECTED"; code: string; stateRevision: number }

export type Applied = { outcome: "APPLIED"; code: string; stateRevision: number }
export const applied = (stateRevision: number, code = "OK"): Applied => ({ outcome: "APPLIED", code, stateRevision })
export const rejected = (stateRevision: number, code: string): Rejection => ({ outcome: "REJECTED", code, stateRevision })

type Fenced = { runId: string; stateRevision: number; fencing: Fencing }

// Run and worker-epoch fence. An older epoch is rejected for good; a newer epoch is adopted.
// Same epoch with a different lease token is a stale holder.
export function checkFence(state: Fenced, ctx: MutationContext): { ok: true; fencing: Fencing } | { ok: false; result: Rejection } {
    if (ctx.runId !== state.runId) return { ok: false, result: rejected(state.stateRevision, "WRONG_RUN") }
    const f = state.fencing
    if (ctx.workerEpoch < f.workerEpoch) return { ok: false, result: rejected(state.stateRevision, "INVALID_LEASE") }
    if (ctx.workerEpoch === f.workerEpoch && f.leaseToken !== null && f.leaseToken !== ctx.leaseToken) {
        return { ok: false, result: rejected(state.stateRevision, "INVALID_LEASE") }
    }
    return { ok: true, fencing: { workerEpoch: ctx.workerEpoch, leaseToken: ctx.leaseToken } }
}

// Effective simulation time never moves backwards for an actor.
export const effectiveSimSec = (lastAdvancedSimSec: number, ctx: MutationContext) => Math.max(lastAdvancedSimSec, ctx.simNowSec)

export type OutboxAttemptTiming = { attemptCount: number; nextAttemptAtWallMs: number }

// Persist the dispatcher's transport receipt and retry schedule on the entry, so a
// restarted worker resumes backoff instead of starting over. transportMessageId is
// null when the send failed; the attempt count and next retry time still persist.
export function markOutboxAccepted<
    T extends { outbox: { envelope: { messageId: string }; transportMessageId: string | null; attemptCount: number; nextAttemptAtWallMs: number }[] },
>(state: T, messageId: string, transportMessageId: string | null, attempt?: OutboxAttemptTiming): T | null {
    const i = state.outbox.findIndex(o => o.envelope.messageId === messageId)
    if (i < 0) return null
    const o = state.outbox[i]
    const next = {
        ...o,
        transportMessageId: transportMessageId ?? o.transportMessageId,
        attemptCount: attempt ? Math.max(o.attemptCount, attempt.attemptCount) : o.attemptCount,
        nextAttemptAtWallMs: attempt ? attempt.nextAttemptAtWallMs : o.nextAttemptAtWallMs,
    }
    if (next.transportMessageId === o.transportMessageId && next.attemptCount === o.attemptCount && next.nextAttemptAtWallMs === o.nextAttemptAtWallMs) return null
    const outbox = state.outbox.map((e, j) => (j === i ? next : e))
    return { ...state, outbox }
}

export const clone = <T>(v: T): T => structuredClone(v)

// Job rule for Task 6: when actor code rejects a MODEL commit on a domain rule, the job stays
// LEASED with the same lease token so the rules fallback can commit under that lease.
