// Module-level incident command handling for AirportActor and FlightActor
// (Terse 0.14.9: sync methods on an actor class throw, so logic lives here).
// Call receiveIncidentStep at the top of `receive`; it returns null for any
// message that is not INCIDENT_CREATE / INCIDENT_CLEAR.
import type { AirportState, DomainResult, FlightState, MutationContext, ReceivedEnvelope } from "@ghost-tower/domain/contracts"
import { RELAY_TIMING } from "@ghost-tower/domain/constants"
import { isControllerCommand, receiveControllerCommand, type IncidentContext } from "@ghost-tower/domain/incidents"
import { negotiationTiming, openRound, revokeArrangements, type NegotiationContext } from "../../packages/domain/src/negotiation.ts"
import { checkFence, rejected } from "./durability.ts"

/** Bind the negotiation transitions incidents.ts calls back into: revoked holds
 *  answer their pending request with LANDING_REFUSED, and a flight that becomes
 *  an emergency opens an urgent round in the same aggregate write. */
export function incidentHooks(nctx: NegotiationContext): Pick<IncidentContext, "revokeArrangements" | "openEmergencyRound"> {
    return {
        revokeArrangements: (airport, affects, code, reason, causationId) => revokeArrangements(airport, affects, code, reason, nctx, causationId),
        openEmergencyRound: flight => openRound(flight, "EMERGENCY", nctx).state,
    }
}

/** Used only when the actor supplies no NegotiationContext of its own. */
export function defaultIncidentNegotiationContext(state: { lastAdvancedSimSec: number }, ctx: MutationContext): NegotiationContext {
    return {
        simNowSec: Math.max(ctx.simNowSec, state.lastAdvancedSimSec),
        wallNowMs: ctx.wallNowMs,
        timing: negotiationTiming(RELAY_TIMING.HOSTED, RELAY_TIMING.HOSTED.defaultSpeed),
        decisionMode: "IMMEDIATE",
    }
}

export function receiveIncidentStep<S extends AirportState | FlightState>(
    state: S | null,
    ctx: MutationContext,
    message: ReceivedEnvelope,
    nctx: NegotiationContext | null = null,
    notifyFlightIds?: readonly string[],
): { state: S | null; result: DomainResult } | null {
    if (!isControllerCommand(message)) return null
    if (state === null) return { state: null, result: rejected(0, "WRONG_PHASE") }
    if (message.runId !== state.runId || ctx.runId !== state.runId) return { state: null, result: rejected(state.stateRevision, "WRONG_RUN") }
    const fence = checkFence(state, ctx)
    if (!fence.ok) return { state: null, result: fence.result }
    const fenced = { ...state, fencing: fence.fencing } as S
    const negotiation = nctx ?? defaultIncidentNegotiationContext(state, ctx)
    const t = receiveControllerCommand(fenced, message, {
        runId: ctx.runId,
        simNowSec: negotiation.simNowSec,
        wallNowMs: ctx.wallNowMs,
        causationId: message.messageId,
        notifyFlightIds,
        ...incidentHooks(negotiation),
    })
    return { state: t.state === fenced ? null : t.state, result: t.result }
}
