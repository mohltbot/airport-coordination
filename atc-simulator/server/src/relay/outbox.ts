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

// Per-transport memory of sends in flight and the retry schedule. The persisted entry is the
// durable record, but an actor may persist only the transport receipt and the caller may build
// a new OutboxPort each pass, so the schedule is also kept here (keyed by the long-lived
// transport) and the later of the two times wins. After a restart the persisted times apply.
type DispatchMemory = { flying: Set<string>; schedule: Map<string, { attempts: number; nextAt: number }>; busyUntil: number }
const memories = new WeakMap<object, DispatchMemory>()
const memoryFor = (key: object) => {
    let m = memories.get(key)
    if (!m) memories.set(key, (m = { flying: new Set(), schedule: new Map(), busyUntil: 0 }))
    return m
}

const RELAY_BUSY_PAUSE_MS = 3_000

/** One dispatcher pass over every entity's durable outbox. */
export async function dispatchDueOutboxes(ctx: DispatchContext): Promise<DispatchReport> {
    const now = ctx.now ?? Date.now
    const memory = memoryFor(ctx.transport)
    const { flying, schedule } = memory
    const report: DispatchReport = { due: 0, sent: 0, failed: 0, skipped: 0 }
    // Hosted Relay answered 429 (workspace_busy / delivery depth): hold every send briefly
    // instead of letting six parallel retries keep the workspace saturated.
    if (memory.busyUntil > now()) return report

    const work: { entityId: EntityId; entry: OutboxEntry }[] = []
    const listed = new Set<string>()
    for (const entityId of await ctx.outbox.entities()) {
        const entries = await ctx.outbox.list(entityId)
        for (const e of entries) if (!e.acknowledged) listed.add(e.envelope.messageId)
        const { due, expired } = selectDue(entityId, entries, now())
        report.skipped += expired.length
        for (const e of expired)
            ctx.log?.({ entityId, messageId: e.envelope.messageId, type: e.envelope.type, attempt: e.attemptCount, outcome: "SKIPPED_EXPIRED", transportMessageId: e.transportMessageId, code: null, sendMs: 0 })
        for (const entry of due) {
            const id = entry.envelope.messageId
            const mem = schedule.get(id)
            if (flying.has(id) || (mem && mem.nextAt > now())) continue
            work.push({ entityId, entry: mem && mem.attempts > entry.attemptCount ? { ...entry, attemptCount: mem.attempts } : entry })
        }
    }
    // Acknowledged entries drop out of the listing; forget their schedule.
    for (const id of schedule.keys()) if (!listed.has(id) && !flying.has(id)) schedule.delete(id)
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
                const nextAt = now() + retryDelayMs(ctx.timing, attempt)
                schedule.set(id, { attempts: attempt, nextAt })
                await ctx.outbox.recordAttempt(entityId, { messageId: id, transportMessageId, attemptCount: attempt, nextAttemptAtWallMs: nextAt })
                report.sent++
                ctx.log?.({ entityId, messageId: id, type: entry.envelope.type, attempt, outcome: "SENT", transportMessageId, code: null, sendMs: now() - t0 })
            } catch (err) {
                const code = err instanceof RelayTransportError ? err.code : "SEND_FAILED"
                // Non-retryable (malformed or oversized) entries back off at the steady rate so they
                // stay visible without hammering Relay; the owning actor decides what to do with them.
                const delay = err instanceof RelayTransportError && !err.retryable ? ctx.timing.ackRetrySteadyMs : retryDelayMs(ctx.timing, attempt)
                if (err instanceof RelayTransportError && err.status === 429) memory.busyUntil = Math.max(memory.busyUntil, now() + RELAY_BUSY_PAUSE_MS)
                schedule.set(id, { attempts: attempt, nextAt: now() + delay })
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
