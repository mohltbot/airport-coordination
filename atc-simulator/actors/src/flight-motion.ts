// Module-level movement and landing steps for FlightActor (plan Task 8).
// Terse 0.14.9: sync methods on an actor class throw, so the logic lives here and
// the actor methods only fence, call one step, and reassign the aggregate.
import type { ClearanceCheckResult, DomainResult, FlightState, MutationContext, Tick, TouchdownReceipt } from "@ghost-tower/domain/contracts"
import { RELAY_TIMING } from "@ghost-tower/domain/constants"
import { advanceFlight, applyApproachGuard, recordFlightTouchdown, type FlightHooks } from "../../packages/domain/src/flight.js"
import {
    flightWallTimers,
    negotiationTiming,
    openRound,
    releaseAllForTerminal,
    type DecisionMode,
    type NegotiationContext,
    type NegotiationTiming,
} from "../../packages/domain/src/negotiation.js"
import { checkFence, rejected } from "./durability.js"

export type MotionStep = { state: FlightState | null; result: DomainResult }

// Optional actor settings, read if FlightActor persists them (as AirportActor does).
export type FlightNegotiationSettings = { timing?: NegotiationTiming; decisionMode?: DecisionMode }

export function flightNegotiationCtx(actor: object, state: FlightState, ctx: MutationContext): NegotiationContext {
    const settings = actor as FlightNegotiationSettings
    return {
        simNowSec: Math.max(ctx.simNowSec, state.lastAdvancedSimSec),
        wallNowMs: ctx.wallNowMs,
        timing: settings.timing ?? negotiationTiming(RELAY_TIMING.HOSTED, RELAY_TIMING.HOSTED.defaultSpeed),
        decisionMode: settings.decisionMode ?? "IMMEDIATE",
    }
}

// A dropped assignment opens a real negotiation round; a terminal flight declines
// its outstanding offers and releases its reservation through negotiation.ts.
export function flightHooks(nctx: NegotiationContext): FlightHooks {
    return {
        reopen: (s, trigger) => openRound(s, trigger, nctx).state,
        terminal: s => releaseAllForTerminal(s, nctx).state,
    }
}

function fenced(state: FlightState | null, ctx: MutationContext): { ok: true; state: FlightState } | { ok: false; step: MotionStep } {
    if (state === null) return { ok: false, step: { state: null, result: rejected(0, "WRONG_PHASE") } }
    const f = checkFence(state, ctx)
    if (!f.ok) return { ok: false, step: { state: null, result: f.result } }
    return { ok: true, state: { ...state, fencing: f.fencing } }
}

// One tick: movement, fuel, holding, approach, slot expiry, terminal outcomes, then
// the negotiation wall-clock timers so collection deadlines also fire while running.
export function advanceFlightStep(settings: object, current: FlightState | null, ctx: MutationContext, tick: Tick): MotionStep {
    const f = fenced(current, ctx)
    if (!f.ok) return f.step
    const nctx = flightNegotiationCtx(settings, f.state, { ...ctx, simNowSec: tick.toSimSec })
    const t = advanceFlight(f.state, tick, ctx, flightHooks(nctx))
    if (t.result.outcome !== "APPLIED") return { state: t.state, result: t.result }
    const timers = flightWallTimers(t.state, nctx)
    return { state: timers.result.outcome === "APPLIED" ? timers.state : t.state, result: t.result }
}

export function approachGuardStep(settings: object, current: FlightState | null, ctx: MutationContext, check: ClearanceCheckResult): MotionStep {
    const f = fenced(current, ctx)
    if (!f.ok) return f.step
    const t = applyApproachGuard(f.state, check, ctx, flightHooks(flightNegotiationCtx(settings, f.state, ctx)))
    return { state: t.result.outcome === "APPLIED" ? t.state : null, result: t.result }
}

// LANDED from the airport's authoritative receipt; leftover offers are declined.
export function touchdownStep(settings: object, current: FlightState | null, ctx: MutationContext, receipt: TouchdownReceipt): MotionStep {
    const f = fenced(current, ctx)
    if (!f.ok) return f.step
    const t = recordFlightTouchdown(f.state, receipt, ctx)
    if (t.result.outcome !== "APPLIED") return { state: null, result: t.result }
    const released = releaseAllForTerminal(t.state, flightNegotiationCtx(settings, t.state, ctx))
    return { state: released.state, result: { ...t.result, stateRevision: released.state.stateRevision } }
}
