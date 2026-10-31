import { describe, expect, test } from "bun:test"
import type { AgentDecisionInput } from "../../packages/domain/src/contracts.ts"
import { buildDecisionInput, openRound, receiveAirportNegotiation, type NegotiationContext } from "../../packages/domain/src/negotiation.ts"
import { chooseValidAction, rankOffers, type PilotOfferView, type PilotView } from "../../packages/domain/src/policy.ts"
import { createWorld } from "../../packages/domain/src/world.ts"

const runId = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"
const ctx: NegotiationContext = {
    simNowSec: 0,
    wallNowMs: 1_000_000,
    timing: { replyCollectionWindowMs: 4_000, offerAcceptTimeoutMs: 5_000, offerTtlMs: 20_000, minSlotLeadSimSec: 60, noFeasibleRetryMs: 5_000 },
    decisionMode: "JOB",
}
const offer = (o: Partial<PilotOfferView>): PilotOfferView => ({
    offerId: `o-${o.airportId}`,
    airportId: "ALP",
    runwayId: "R1",
    slotStartSimSec: 600,
    distanceNm: 20,
    feasible: true,
    isOriginalDestination: false,
    ...o,
})

describe("rankOffers", () => {
    const offers = [
        offer({ airportId: "ALP", distanceNm: 30, slotStartSimSec: 400 }),
        offer({ airportId: "BRV", distanceNm: 10, slotStartSimSec: 900 }),
        offer({ airportId: "CHR", distanceNm: 5, slotStartSimSec: 300, feasible: false }),
    ]
    test("emergency: closest feasible first, an infeasible nearer offer never wins", () => {
        expect(rankOffers(offers, "EMERGENCY").map(o => o.airportId)).toEqual(["BRV", "ALP"])
    })
    test("normal: original destination while feasible, else earliest touchdown", () => {
        expect(rankOffers(offers, "NORMAL").map(o => o.airportId)).toEqual(["ALP", "BRV"])
        const withOrig = offers.map(o => (o.airportId === "BRV" ? { ...o, isOriginalDestination: true } : o))
        expect(rankOffers(withOrig, "NORMAL")[0]!.airportId).toBe("BRV")
    })
    test("ties break on distance, then airport ID", () => {
        const tie = [offer({ airportId: "CHR", distanceNm: 10 }), offer({ airportId: "BRV", distanceNm: 10 })]
        expect(rankOffers(tie, "EMERGENCY").map(o => o.airportId)).toEqual(["BRV", "CHR"])
    })
})

describe("chooseValidAction (RULES_FALLBACK entry point)", () => {
    const world = () => createWorld({ flightCount: 1, seed: 20261031, speed: 10 }, { runId, operationId: "op" })

    test("pilot in REQUESTING asks the rule candidates", () => {
        const w = world()
        const flight = openRound({ ...w.flights[0]!, position: { x: 50, y: 30 } }, "INITIAL", ctx).state
        const job = Object.values(flight.jobs)[0]!
        const input = buildDecisionInput(flight, job, ctx) as AgentDecisionInput
        expect(input.role).toBe("PILOT")
        expect(JSON.stringify(input.localState)).not.toMatch(/outbox|inbox|leaseToken|fencing/)
        expect(chooseValidAction(input)).toMatchObject({ type: "REQUEST_LANDING", airportIds: ["ALP"] })
    })

    test("ATC proposes exactly the held slot; refuses when the airport is closed", () => {
        const w = world()
        const flight = { ...w.flights[0]!, position: { x: 50, y: 30 } }
        const request = {
            messageId: crypto.randomUUID(),
            fromEntityId: "flight:F001" as const,
            correlationId: "F001-N1",
            type: "LANDING_REQUEST" as const,
            payload: {
                negotiationId: "F001-N1",
                flightId: "F001",
                flightDecisionRevision: 1,
                position: flight.position,
                speedKnots: 240,
                fuelRemainingSec: 3600,
                sampledAtSimSec: 0,
                priority: "NORMAL" as const,
                deadlineSimSec: null,
            },
        }
        const airport = receiveAirportNegotiation(w.airports[0]!, request, ctx)!.state
        const job = Object.values(airport.jobs)[0]!
        const input = buildDecisionInput(airport, job, ctx)!
        expect(chooseValidAction(input)).toMatchObject({ type: "PROPOSE_OFFER", runwayId: "R1", slotStartSimSec: 360, negotiationId: "F001-N1" })
        const closedView = { ...input, localState: { ...input.localState, held: null, arrivalsClosed: true } }
        expect(chooseValidAction(closedView)).toMatchObject({ type: "REFUSE", code: "CLOSED" })
    })

    test("pilot with no feasible offer holds; with offers it selects the mandated best", () => {
        const base: PilotView = {
            role: "PILOT",
            flightId: "F001",
            simNowSec: 0,
            phase: "ENROUTE",
            priority: "EMERGENCY",
            deadlineSimSec: 900,
            fuelRemainingSec: 2000,
            speedKnots: 240,
            originalDestination: "ALP",
            roundId: "F001-N1",
            stage: "COLLECTING",
            requestCandidates: [],
            offers: [],
            refusals: [],
            activeAssignment: null,
            clearanceDue: false,
        }
        const input = (view: PilotView): AgentDecisionInput => ({
            jobId: "j",
            entityId: "flight:F001",
            role: "PILOT",
            decisionRevision: 1,
            allowedActions: ["SELECT_OFFER", "HOLD"],
            localState: view as unknown as Record<string, unknown>,
            relevantMessages: [],
        })
        expect(chooseValidAction(input(base)).type).toBe("HOLD")
        const pick = chooseValidAction(input({ ...base, offers: [offer({ airportId: "CHR", distanceNm: 40 }), offer({ airportId: "BRV", distanceNm: 12 })] }))
        expect(pick).toMatchObject({ type: "SELECT_OFFER", airportId: "BRV", offerId: "o-BRV" })
        expect(pick.reason.length).toBeLessThanOrEqual(240)
    })
})
