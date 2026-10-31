// Final authoritative touchdown and its crash recovery (design §4, plan Task 8).
//
// Write order: the airport records the touchdown receipt first (idempotent, it
// validates the clearance, reservation and window against its current state),
// then the flight is marked LANDED from that receipt. If the worker dies between
// the two writes, reconcileLandings finishes the flight from the airport receipt.
// A later closure never undoes a recorded touchdown, because recovery reads the
// receipt before anything checks the newer airport state.
import type { AirportId, ClearanceCheckResult, MutationContext, TouchdownInput, TouchdownReceipt } from "@ghost-tower/domain/contracts"
import { FencedError, type SimulationRepository } from "./clock.ts"

export type TouchdownAttempt = TouchdownInput & { airportId: AirportId }
export type TouchdownOutcome = { receipt: TouchdownReceipt | null; guarded: boolean; reason: string | null }

function isReceipt(value: unknown): value is TouchdownReceipt {
    return typeof value === "object" && value !== null && typeof (value as TouchdownReceipt).receiptId === "string"
}

function reasonOf(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err)
    return message.slice(0, 240)
}

export async function attemptTouchdown(repo: SimulationRepository, context: MutationContext, input: TouchdownAttempt): Promise<TouchdownOutcome> {
    const flight = repo.flight(context.runId, input.flightId)
    const current = await flight.read()
    // Already landed with a receipt: nothing to do (duplicate touchdown).
    if (current.landingReceipt) return { receipt: current.landingReceipt, guarded: false, reason: null }

    const airport = repo.airport(context.runId, input.airportId)
    const { airportId: _airportId, ...touchdown } = input
    let receipt: TouchdownReceipt | null = null
    let refusal: string | null = null
    try {
        const result: unknown = await airport.recordTouchdown(context, touchdown)
        if (isReceipt(result)) receipt = result
        else refusal = typeof result === "object" && result !== null && "code" in result ? String((result as { code: unknown }).code) : "REJECTED"
    } catch (err) {
        // AirportActor throws its refusal code. A fence means another worker or run
        // owns the airport; a wait code retries next tick; a refusal forces holding
        // and renegotiation; anything else (transport) leaves the tick pending.
        const kind = classifyTouchdownError(err)
        if (kind === "FENCE") throw new FencedError(reasonOf(err), `touchdown fenced: ${reasonOf(err)}`)
        if (kind === "WAIT") return { receipt: null, guarded: false, reason: reasonOf(err) }
        if (kind === "OTHER") throw err
        refusal = reasonOf(err)
    }

    if (receipt) {
        await flight.recordTouchdown(context, receipt)
        return { receipt, guarded: false, reason: null }
    }
    const check: ClearanceCheckResult = {
        valid: false,
        reason: (refusal ?? "touchdown refused").slice(0, 240),
        reservationId: input.reservationId,
        clearanceId: input.clearanceId,
    }
    await flight.applyApproachGuard(context, check)
    return { receipt: null, guarded: true, reason: check.reason }
}

// Terse surfaces an actor-thrown error as an invocation error carrying the thrown
// message; AirportActor.recordTouchdown throws its domain code.
const FENCE_CODES = ["INVALID_LEASE", "WRONG_RUN"]
const WAIT_CODES = ["WINDOW_NOT_OPEN", "RUNWAY_OCCUPIED"]
const REFUSAL_CODES = [
    "CLOSED",
    "UNKNOWN_CLEARANCE",
    "MISMATCH",
    "CLEARANCE_",
    "WINDOW_PASSED",
    "OFFER_EXPIRED",
    "STALE_STATE",
    "WRONG_PHASE",
    "DEADLINE_EXCEEDED",
    "NO_CAPACITY",
    "INVALID_PAYLOAD",
    "ALREADY_TERMINAL",
]
export function classifyTouchdownError(err: unknown): "FENCE" | "WAIT" | "REFUSAL" | "OTHER" {
    const text = reasonOf(err)
    if (FENCE_CODES.some(c => text.includes(c))) return "FENCE"
    if (WAIT_CODES.some(c => text.includes(c))) return "WAIT"
    if (REFUSAL_CODES.some(c => text.includes(c))) return "REFUSAL"
    return "OTHER"
}

// Recovery: finish any flight whose airport receipt exists but whose own LANDED
// write was lost. Safe to run at any time; recordTouchdown is idempotent.
export async function reconcileLandings(
    repo: SimulationRepository,
    context: MutationContext,
    airportIds: readonly AirportId[],
): Promise<TouchdownReceipt[]> {
    const completed: TouchdownReceipt[] = []
    for (const airportId of airportIds) {
        const airport = await repo.airport(context.runId, airportId).read()
        for (const receipt of Object.values(airport.touchdowns)) {
            if (receipt.runId !== context.runId) continue
            const flight = repo.flight(context.runId, receipt.flightId)
            const state = await flight.read()
            if (state.landingReceipt?.receiptId === receipt.receiptId) continue
            const result = await flight.recordTouchdown({ ...context, operationId: `recover:${receipt.receiptId}`.slice(0, 128) }, receipt)
            if (result.outcome === "APPLIED") completed.push(receipt)
        }
    }
    return completed
}
