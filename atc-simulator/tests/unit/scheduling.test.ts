import { describe, expect, test } from "bun:test"
import { RELAY_TIMING } from "../../packages/domain/src/constants.ts"
import type { AirportState, FlightFacts, Reservation } from "../../packages/domain/src/contracts.ts"
import { negotiationTiming } from "../../packages/domain/src/negotiation.ts"
import {
    earliestSlotStart,
    findLandingOffer,
    findOverlaps,
    intervalsOverlap,
    isOfferExpired,
    protectedInterval,
    type SchedulingContext,
} from "../../packages/domain/src/scheduling.ts"
import { createWorld } from "../../packages/domain/src/world.ts"

const runId = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"
const alp = (): AirportState => createWorld({ flightCount: 1, seed: 1, speed: 10 }, { runId, operationId: "op" }).airports[0]!

// 20 NM north of ALP (50,50): 300 s at 240 kt.
const facts = (over: Partial<FlightFacts> = {}): FlightFacts => ({
    position: { x: 50, y: 30 },
    speedKnots: 240,
    fuelRemainingSec: 3600,
    sampledAtSimSec: 0,
    priority: "NORMAL",
    deadlineSimSec: null,
    ...over,
})
const ctx: SchedulingContext = { simNowSec: 0, wallNowMs: 1_000_000, offerTtlMs: 20_000, minSlotLeadSimSec: 60 }

const hold = (airport: AirportState, flightId: string, f = facts(), c = ctx): AirportState => {
    const r = findLandingOffer(airport, { negotiationId: `${flightId}-N1`, flightId, requestMessageId: crypto.randomUUID(), facts: f }, c)
    if (r.kind !== "OFFER") throw new Error(`expected offer, got ${r.code}`)
    return { ...airport, offers: { ...airport.offers, [r.offer.offerId]: r.offer } }
}

const reservation = (over: Partial<Reservation>): Reservation => ({
    negotiationId: "X-N1",
    offerId: "X-N1@ALP",
    airportId: "ALP",
    runwayId: "R1",
    slotStartSimSec: 360,
    occupancySec: 60,
    expiresAtWallMs: 0,
    airportOperationalRevision: 0,
    flightId: "F009",
    requestMessageId: crypto.randomUUID(),
    priority: "NORMAL",
    reservationId: "rsv-X",
    status: "CONFIRMED",
    ...over,
})

describe("intervals", () => {
    test("an interval ending at 190 does not conflict with one starting at 190", () => {
        expect(intervalsOverlap({ start: 100, end: 190 }, { start: 190, end: 280 })).toBe(false)
        expect(intervalsOverlap({ start: 100, end: 190 }, { start: 189, end: 280 })).toBe(true)
    })
    test("runway protection includes the 30 s landing grace", () => {
        expect(protectedInterval(100, 60)).toEqual({ start: 100, end: 190 })
    })
    test("offer TTL at exactly expiresAtWallMs is expired", () => {
        expect(isOfferExpired({ expiresAtWallMs: 5000 }, 4999)).toBe(false)
        expect(isOfferExpired({ expiresAtWallMs: 5000 }, 5000)).toBe(true)
    })
})

describe("slot search", () => {
    test("both runways free: earliest grid time, then R1", () => {
        expect(earliestSlotStart(0, 300, 60)).toBe(360)
        const r = findLandingOffer(alp(), { negotiationId: "F001-N1", flightId: "F001", requestMessageId: crypto.randomUUID(), facts: facts() }, ctx)
        expect(r.kind).toBe("OFFER")
        if (r.kind !== "OFFER") return
        expect(r.offer.runwayId).toBe("R1")
        expect(r.offer.slotStartSimSec).toBe(360)
        expect(r.offer.expiresAtWallMs).toBe(ctx.wallNowMs + 20_000)
    })

    test("tentative holds are exclusive: next flights get R2, then R1 after occupancy plus grace", () => {
        let a = hold(alp(), "F001")
        a = hold(a, "F002")
        a = hold(a, "F003")
        const slots = Object.values(a.offers).map(o => [o.flightId, o.runwayId, o.slotStartSimSec])
        expect(slots).toEqual([
            ["F001", "R1", 360],
            ["F002", "R2", 360],
            ["F003", "R1", 450],
        ])
        expect(findOverlaps(a, ctx.wallNowMs, 0)).toEqual([])
    })

    test("an expired hold no longer blocks the runway", () => {
        const a = hold(alp(), "F001")
        const later = { ...ctx, wallNowMs: ctx.wallNowMs + 20_000 }
        const r = findLandingOffer(a, { negotiationId: "F002-N1", flightId: "F002", requestMessageId: crypto.randomUUID(), facts: facts() }, later)
        expect(r.kind === "OFFER" && [r.offer.runwayId, r.offer.slotStartSimSec]).toEqual(["R1", 360])
    })

    test("hosted Relay at 5x pushes the earliest slot out by minSlotLeadSimSec (225 s)", () => {
        const timing = negotiationTiming(RELAY_TIMING.HOSTED, 5)
        expect(timing.minSlotLeadSimSec).toBe(225)
        expect(timing.offerTtlMs).toBe(120_000)
        const r = findLandingOffer(alp(), { negotiationId: "F001-N1", flightId: "F001", requestMessageId: crypto.randomUUID(), facts: facts() }, {
            ...ctx,
            minSlotLeadSimSec: timing.minSlotLeadSimSec,
            offerTtlMs: timing.offerTtlMs,
        })
        expect(r.kind === "OFFER" && r.offer.slotStartSimSec).toBe(540) // ceil((300 + 225) / 30) * 30
    })

    test("closed airport refuses; a closed runway is never offered", () => {
        const closed = { ...alp(), restrictions: { ...alp().restrictions, arrivalsClosed: true } }
        const r = findLandingOffer(closed, { negotiationId: "F001-N1", flightId: "F001", requestMessageId: crypto.randomUUID(), facts: facts() }, ctx)
        expect(r.kind === "REFUSED" && r.code).toBe("CLOSED")
        const r1Closed = { ...alp(), restrictions: { ...alp().restrictions, closedRunways: ["R1" as const] } }
        const r2 = findLandingOffer(r1Closed, { negotiationId: "F001-N1", flightId: "F001", requestMessageId: crypto.randomUUID(), facts: facts() }, ctx)
        expect(r2.kind === "OFFER" && r2.offer.runwayId).toBe("R2")
    })

    test("fuel- or deadline-infeasible requests are refused", () => {
        const lowFuel = findLandingOffer(alp(), { negotiationId: "F001-N1", flightId: "F001", requestMessageId: crypto.randomUUID(), facts: facts({ fuelRemainingSec: 400 }) }, ctx)
        expect(lowFuel.kind === "REFUSED" && lowFuel.code).toBe("UNREACHABLE")
        const late = findLandingOffer(
            alp(),
            { negotiationId: "F001-N1", flightId: "F001", requestMessageId: crypto.randomUUID(), facts: facts({ priority: "EMERGENCY", deadlineSimSec: 330 }) },
            ctx,
        )
        expect(late.kind === "REFUSED" && late.code).toBe("DEADLINE_EXCEEDED")
    })

    test("reduced capacity books new slots with 120 s occupancy", () => {
        const a = { ...alp(), restrictions: { ...alp().restrictions, occupancySec: 120 } }
        const r = findLandingOffer(a, { negotiationId: "F001-N1", flightId: "F001", requestMessageId: crypto.randomUUID(), facts: facts() }, ctx)
        expect(r.kind === "OFFER" && r.offer.occupancySec).toBe(120)
    })
})

describe("emergency preemption", () => {
    // Deadline 400 leaves exactly one achievable grid slot (360) for the emergency.
    const emergency = facts({ priority: "EMERGENCY", deadlineSimSec: 400 })
    const req = { negotiationId: "F005-N1", flightId: "F005", requestMessageId: crypto.randomUUID(), facts: emergency }

    test("free slot first; no preemption when one exists", () => {
        const r = findLandingOffer(alp(), req, ctx)
        expect(r.kind === "OFFER" && r.preempts).toBeNull()
    })

    test("displaces a normal confirmed reservation; earliest slot, then runway, then reservation ID", () => {
        const a: AirportState = {
            ...alp(),
            reservations: {
                "rsv-B": reservation({ reservationId: "rsv-B", runwayId: "R2", flightId: "F008" }),
                "rsv-A": reservation({ reservationId: "rsv-A", runwayId: "R1", flightId: "F009" }),
            },
        }
        const r = findLandingOffer(a, req, ctx)
        expect(r.kind).toBe("OFFER")
        if (r.kind !== "OFFER") return
        expect([r.offer.runwayId, r.offer.slotStartSimSec, r.preempts?.id]).toEqual(["R1", 360, "rsv-A"])
    })

    test("never preempts a cleared reservation, another emergency, or anything inside 120 s", () => {
        const a: AirportState = {
            ...alp(),
            reservations: {
                "rsv-A": reservation({ reservationId: "rsv-A", runwayId: "R1", status: "CLEARED" }),
                "rsv-B": reservation({ reservationId: "rsv-B", runwayId: "R2", priority: "EMERGENCY" }),
            },
        }
        const r = findLandingOffer(a, req, ctx)
        expect(r.kind === "REFUSED" && r.code).toBe("DEADLINE_EXCEEDED")

        const soon: AirportState = {
            ...alp(),
            reservations: {
                "rsv-A": reservation({ reservationId: "rsv-A", runwayId: "R1", slotStartSimSec: 330 }),
                "rsv-B": reservation({ reservationId: "rsv-B", runwayId: "R2", slotStartSimSec: 330 }),
            },
        }
        // now = 250: both slots are within 120 s, so neither is eligible.
        const r2 = findLandingOffer(soon, { ...req, facts: { ...emergency, position: { x: 50, y: 49 }, sampledAtSimSec: 250, deadlineSimSec: 400 } }, { ...ctx, simNowSec: 250 })
        expect(r2.kind).toBe("REFUSED")
    })
})
