// Durable outbox dispatcher (design §7). Entries live in actor state until the owning actor
// sees a DOMAIN_ACK (or COMMAND_RESULT) for them. Transport acceptance only records a receipt.
// Retries reuse the envelope's messageId as the Relay idempotency key, so a retry of an accepted
// message is a no-op at Relay; delivery gaps are closed by workspace-event reconciliation.
import type { EntityId, OutboxEntry, RelayTransport } from "@ghost-tower/domain/contracts"
import { OUTBOX_POLL_MS, type RelayTiming } from "@ghost-tower/domain/constants"
import { RelayTransportError, type OutboxPort } from "./transport.ts"

export type DispatchContext = {
    transport: RelayTransport
    outbox: OutboxPort
    timing: RelayTiming
    /** Parallel sends. Hosted Relay takes 2.5 to 4 s per post, so sends must overlap. */
    concurrency?: number
    now?: () => number
    log?: (e: DispatchEvent) => void
}

export type DispatchEvent = {
    entityId: EntityId
    messageId: string
    type: string
    attempt: number
    outcome: "SENT" | "FAILED" | "SKIPPED_EXPIRED"
    transportMessageId: string | null
    code: string | null
    sendMs: number
}

export type DispatchReport = { due: number; sent: number; failed: number; skipped: number }

/** Delay before the next attempt, given how many attempts have now been made (1-based). */
export function retryDelayMs(timing: RelayTiming, attemptsMade: number): number {
    return timing.ackRetryBackoffMs[attemptsMade - 1] ?? timing.ackRetrySteadyMs
}

const isCommand = (e: OutboxEntry) => e.envelope.type === "INCIDENT_CREATE" || e.envelope.type === "INCIDENT_CLEAR"

/**
 * Pick the entries to send now. Controller commands: at most one unacknowledged command per
 * target, the lowest commandSequence, so a clear can never overtake its create. Expired
 * controller commands are still delivered for target-side rejection; other expired messages
 * are left for their actor to retire.
 */
export function selectDue(entityId: EntityId, entries: OutboxEntry[], nowMs: number): { due: OutboxEntry[]; expired: OutboxEntry[] } {
    const pending = entries.filter(e => !e.acknowledged)
    const headOfTarget = new Map<string, number>()
    for (const e of pending) {
        if (!isCommand(e) || !("commandSequence" in e.envelope)) continue
        const seq = e.envelope.commandSequence
        const prev = headOfTarget.get(e.envelope.toEntityId)
        if (prev === undefined || seq < prev) headOfTarget.set(e.envelope.toEntityId, seq)
    }
    const due: OutboxEntry[] = []
    const expired: OutboxEntry[] = []
    for (const e of pending) {
        if (e.nextAttemptAtWallMs > nowMs) continue
        if (isCommand(e) && "commandSequence" in e.envelope) {
            if (headOfTarget.get(e.envelope.toEntityId) !== e.envelope.commandSequence) continue
        } else if (e.envelope.expiresAtWallMs !== null && e.envelope.expiresAtWallMs <= nowMs) {
            expired.push(e)
            continue
        }
        due.push(e)
    }
    void entityId
    return { due, expired }
}

const inFlight = new WeakMap<object, Set<string>>()

/** One dispatcher pass over every entity's durable outbox. */
export async function dispatchDueOutboxes(ctx: DispatchContext): Promise<DispatchReport> {
    const now = ctx.now ?? Date.now
    const flying = inFlight.get(ctx.outbox) ?? new Set<string>()
    inFlight.set(ctx.outbox, flying)
    const report: DispatchReport = { due: 0, sent: 0, failed: 0, skipped: 0 }

    const work: { entityId: EntityId; entry: OutboxEntry }[] = []
    for (const entityId of await ctx.outbox.entities()) {
        const { due, expired } = selectDue(entityId, await ctx.outbox.list(entityId), now())
        report.skipped += expired.length
        for (const e of expired)
            ctx.log?.({ entityId, messageId: e.envelope.messageId, type: e.envelope.type, attempt: e.attemptCount, outcome: "SKIPPED_EXPIRED", transportMessageId: e.transportMessageId, code: null, sendMs: 0 })
        for (const entry of due) if (!flying.has(entry.envelope.messageId)) work.push({ entityId, entry })
    }
    report.due = work.length

    const limit = Math.max(1, ctx.concurrency ?? 6)
    let next = 0
    const runOne = async () => {
        while (next < work.length) {
            const { entityId, entry } = work[next++]!
            const id = entry.envelope.messageId
            flying.add(id)
            const attempt = entry.attemptCount + 1
            const t0 = now()
            try {
                const { transportMessageId } = await ctx.transport.send(entry.envelope)
                await ctx.outbox.recordAttempt(entityId, { messageId: id, transportMessageId, attemptCount: attempt, nextAttemptAtWallMs: now() + retryDelayMs(ctx.timing, attempt) })
                report.sent++
                ctx.log?.({ entityId, messageId: id, type: entry.envelope.type, attempt, outcome: "SENT", transportMessageId, code: null, sendMs: now() - t0 })
            } catch (err) {
                const code = err instanceof RelayTransportError ? err.code : "SEND_FAILED"
                // Non-retryable (malformed or oversized) entries back off at the steady rate so they
                // stay visible without hammering Relay; the owning actor decides what to do with them.
                const delay = err instanceof RelayTransportError && !err.retryable ? ctx.timing.ackRetrySteadyMs : retryDelayMs(ctx.timing, attempt)
                await ctx.outbox
                    .recordAttempt(entityId, { messageId: id, transportMessageId: entry.transportMessageId, attemptCount: attempt, nextAttemptAtWallMs: now() + delay })
                    .catch(() => {})
                report.failed++
                ctx.log?.({ entityId, messageId: id, type: entry.envelope.type, attempt, outcome: "FAILED", transportMessageId: entry.transportMessageId, code, sendMs: now() - t0 })
            } finally {
                flying.delete(id)
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, work.length) }, runOne))
    return report
}

/**
 * Poll every 250 ms. A pass that is still sending does not block the next one: entries already
 * in flight are skipped, new due entries start immediately.
 */
export function startOutboxLoop(ctx: DispatchContext, intervalMs = OUTBOX_POLL_MS): { stop(): Promise<void> } {
    let stopped = false
    const passes = new Set<Promise<unknown>>()
    const timer = setInterval(() => {
        if (stopped || passes.size >= 4) return
        const p = dispatchDueOutboxes(ctx)
            .catch(err => console.error("outbox pass failed:", (err as Error).message))
            .finally(() => passes.delete(p))
        passes.add(p)
    }, intervalMs)
    return {
        async stop() {
            stopped = true
            clearInterval(timer)
            await Promise.allSettled([...passes])
        },
    }
}
