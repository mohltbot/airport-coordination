import { describe, expect, test } from "bun:test"
import type { AirportId, AirportState, FlightState, ProtocolEnvelope, Reservation } from "../../packages/domain/src/contracts.ts"
import {
    acceptOffer,
    advanceNegotiation,
    commitAtcDecision,
    commitPilotDecision,
    flightWallTimers,
    openRound,
    receiveAirportNegotiation,
    recordAirportTouchdown,
    requestClearance,
    revokeArrangements,
    validateClearance,
    type DecisionMode,
    type NegotiationContext,
    type NegotiationTiming,
} from "../../packages/domain/src/negotiation.ts"
import { findOverlaps } from "../../packages/domain/src/scheduling.ts"
import { createWorld } from "../../packages/domain/src/world.ts"

const runId = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"
const timing: NegotiationTiming = { replyCollectionWindowMs: 4_000, offerAcceptTimeoutMs: 5_000, offerTtlMs: 20_000, minSlotLeadSimSec: 60, noFeasibleRetryMs: 5_000 }

// Pure in-memory network: entities exchange the envelopes in their outboxes. No Relay, no actors.
class World {
    wall = 1_000_000
    sim = 0
    mode: DecisionMode = "IMMEDIATE"
    airports: Record<AirportId, AirportState>
    flights: Record<string, FlightState>
    sent = new Map<string, number>() // entityId -> outbox entries already delivered
    delivered: ProtocolEnvelope[] = []
    drop: (e: ProtocolEnvelope) => boolean = () => false

    constructor(flightCount = 3) {
        const w = createWorld({ flightCount, seed: 20261031, speed: 10 }, { runId, operationId: "op" })
        this.airports = Object.fromEntries(w.airports.map(a => [a.airportId, a])) as Record<AirportId, AirportState>
        this.flights = Object.fromEntries(w.flights.map(f => [f.flightId, f]))
    }
    ctx(over: Partial<NegotiationContext> = {}): NegotiationContext {
        return { simNowSec: this.sim, wallNowMs: this.wall, timing, decisionMode: this.mode, ...over }
    }
    flight(id: string, over: Partial<FlightState> = {}) {
        this.flights[id] = { ...this.flights[id]!, ...over }
        return this.flights[id]!
    }
    airport(id: AirportId, over: Partial<AirportState> = {}) {
        this.airports[id] = { ...this.airports[id]!, ...over }
        return this.airports[id]!
    }
    close(id: AirportId) {
        const a = this.airports[id]
        this.airports[id] = { ...a, restrictions: { ...a.restrictions, arrivalsClosed: true }, operationalRevision: a.operationalRevision + 1 }
    }
    pending(): ProtocolEnvelope[] {
        const out: ProtocolEnvelope[] = []
        for (const e of [...Object.values(this.airports), ...Object.values(this.flights)]) {
            const from = this.sent.get(e.entityId) ?? 0
            out.push(...e.outbox.slice(from).map(o => o.envelope))
            this.sent.set(e.entityId, e.outbox.length)
        }
        return out
    }
    deliver(env: ProtocolEnvelope) {
        this.delivered.push(env)
        if (env.toEntityId.startsWith("airport:")) {
            const id = env.toEntityId.slice(8) as AirportId
            const t = receiveAirportNegotiation(this.airports[id], env, this.ctx())
            if (t) this.airports[id] = t.state
        } else if (env.toEntityId.startsWith("flight:")) {
            const id = env.toEntityId.slice(7)
            this.flights[id] = advanceNegotiation(this.flights[id]!, env, this.ctx()).state
        }
    }
    flush(rounds = 30) {
        for (let i = 0; i < rounds; i++) {
            const batch = this.pending()
            if (batch.length === 0) return
            for (const env of batch) if (!this.drop(env)) this.deliver(env)
        }
        throw new Error("network did not settle")
    }
    open(flightId: string, trigger = "INITIAL") {
        const t = openRound(this.flights[flightId]!, trigger, this.ctx())
        this.flights[flightId] = t.state
        return t
    }
    sentBy(entityId: string, type: ProtocolEnvelope["type"]) {
        return this.delivered.filter(e => e.fromEntityId === entityId && e.type === type)
    }
    reservationsOf(flightId: string): Reservation[] {
        return Object.values(this.airports).flatMap(a => Object.values(a.reservations).filter(r => r.flightId === flightId))
    }
}

// F001 sits 20 NM north of ALP with plenty of fuel.
const nearAlp = { position: { x: 50, y: 30 }, fuelRemainingSec: 3600 }
// Close to BRV (110,110): BRV 14 NM, ALP 71 NM, CHR 86 NM.
const nearBrv = { position: { x: 100, y: 100 }, fuelRemainingSec: 3600, originalDestination: "ALP" as const }
// Emergency with a deadline loose enough that all three airports are reachable from nearBrv.
const smoke = { priority: "EMERGENCY" as const, deadlineSimSec: 1500 }

describe("booking sequence", () => {
    test("normal initial traffic requests only its original destination and books one slot", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.open("F001")
        w.flush()
        expect(w.sentBy("flight:F001", "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:ALP"])
        const f = w.flights.F001!
        expect(f.activeAssignment).toMatchObject({ airportId: "ALP", runwayId: "R1", slotStartSimSec: 360, clearanceId: null })
        expect(w.reservationsOf("F001").map(r => [r.reservationId, r.status])).toEqual([[f.activeAssignment!.reservationId, "CONFIRMED"]])
        expect(f.negotiation?.stage).toBe("CONFIRMED")
    })

    test("every negotiation envelope in a round carries the roundId as correlationId", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.open("F001")
        w.flush()
        const roundId = w.flights.F001!.negotiation!.roundId
        expect(w.delivered.length).toBeGreaterThanOrEqual(4)
        expect(new Set(w.delivered.map(e => e.correlationId))).toEqual(new Set([roundId]))
    })

    test("duplicate accept returns the same reservation ID and books once", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.open("F001")
        w.flush()
        const accept = w.sentBy("flight:F001", "OFFER_ACCEPT")[0]!
        const again = acceptOffer(w.airports.ALP, { ...accept, messageId: crypto.randomUUID() } as never, w.ctx())
        const confirms = again.state.outbox.slice(w.airports.ALP.outbox.length).map(o => o.envelope)
        expect(confirms).toHaveLength(1)
        expect(confirms[0]!.type).toBe("LANDING_CONFIRMED")
        expect((confirms[0]!.payload as { reservationId: string }).reservationId).toBe(w.flights.F001!.activeAssignment!.reservationId)
        expect(Object.keys(again.state.reservations)).toHaveLength(1)
    })

    test("simultaneous acceptances never consume the same runway time", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.flight("F002", { ...nearAlp, originalDestination: "ALP" })
        w.flight("F003", { ...nearAlp, originalDestination: "ALP" })
        w.open("F001")
        w.open("F002")
        w.open("F003")
        w.flush()
        const slots = ["F001", "F002", "F003"].map(id => {
            const a = w.flights[id]!.activeAssignment!
            return `${a.runwayId}@${a.slotStartSimSec}`
        })
        expect(new Set(slots).size).toBe(3)
        expect(findOverlaps(w.airports.ALP, w.wall, w.sim)).toEqual([])
    })
})

describe("lost confirmation (review focus 2)", () => {
    test("the flight reconciles the same reservation and never accepts a second destination", () => {
        const w = new World()
        w.flight("F001", nearBrv)
        w.flight("F001", { ...w.flights.F001!, ...smoke })
        let dropped = 0
        w.drop = e => e.type === "LANDING_CONFIRMED" && dropped++ === 0
        w.open("F001", "EMERGENCY")
        w.flush()

        // Airport confirmed; the flight never heard. It stays in one uncertain acceptance.
        const pend = w.flights.F001!.pendingAcceptance!
        expect(pend.airportId).toBe("BRV")
        expect(w.flights.F001!.activeAssignment).toBeNull()
        expect(w.reservationsOf("F001").filter(r => r.status === "CONFIRMED")).toHaveLength(1)
        expect(openRound(w.flights.F001!, "EMERGENCY", w.ctx()).result.code).toBe("WRONG_PHASE")

        // Before the timeout nothing happens; after it the flight asks the same airport about the same IDs.
        w.wall += timing.offerAcceptTimeoutMs - 1
        expect(flightWallTimers(w.flights.F001!, w.ctx()).state.outbox).toHaveLength(w.flights.F001!.outbox.length)
        w.wall += 1
        w.flights.F001 = flightWallTimers(w.flights.F001!, w.ctx()).state
        w.flush()

        const statusReq = w.sentBy("flight:F001", "RESERVATION_STATUS_REQUEST")
        expect(statusReq.map(e => [e.toEntityId, (e.payload as { offerId: string }).offerId])).toEqual([["airport:BRV", pend.offerId]])
        const f = w.flights.F001!
        const booked = w.reservationsOf("F001")
        expect(booked).toHaveLength(1)
        expect(f.activeAssignment?.reservationId).toBe(booked[0]!.reservationId)
        expect(f.pendingAcceptance).toBeNull()
        // Exactly one acceptance was ever sent, to one airport.
        expect(w.sentBy("flight:F001", "OFFER_ACCEPT").map(e => e.toEntityId)).toEqual(["airport:BRV"])
        expect(w.sentBy("flight:F001", "OFFER_DECLINE").map(e => e.toEntityId).sort()).toEqual(["airport:ALP", "airport:CHR"])
    })

    test("the dropped confirmation arriving late is a no-op duplicate", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        let held: ProtocolEnvelope | null = null
        w.drop = e => (e.type === "LANDING_CONFIRMED" && !held ? ((held = e), true) : false)
        w.open("F001")
        w.flush()
        w.wall += timing.offerAcceptTimeoutMs
        w.flights.F001 = flightWallTimers(w.flights.F001!, w.ctx()).state
        w.flush()
        const before = w.flights.F001!
        w.deliver(held!)
        expect(w.flights.F001!.activeAssignment).toEqual(before.activeAssignment)
        expect(w.flights.F001!.releaseObligations).toEqual([])
    })

    test("status EXPIRED ends the uncertainty and a new round starts", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.drop = e => e.type === "OFFER_ACCEPT" // acceptance never arrives; the hold lapses
        w.open("F001")
        w.flush()
        w.drop = () => false
        w.wall += timing.offerTtlMs
        w.flights.F001 = flightWallTimers(w.flights.F001!, w.ctx()).state
        w.flush()
        const f = w.flights.F001!
        expect(f.negotiationCounter).toBe(2)
        expect(f.activeAssignment).not.toBeNull()
        expect(w.reservationsOf("F001").filter(r => r.status === "CONFIRMED")).toHaveLength(1)
    })
})

describe("diversion and emergency choice", () => {
    test("smoke chooses the nearest feasible airport", () => {
        const w = new World()
        w.flight("F001", { ...nearBrv, ...smoke })
        w.open("F001", "EMERGENCY")
        w.flush()
        expect(w.sentBy("flight:F001", "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:BRV", "airport:ALP", "airport:CHR"])
        expect(w.flights.F001!.activeAssignment?.airportId).toBe("BRV")
    })

    test("a farther airport wins only when the nearer one refuses", () => {
        const w = new World()
        w.flight("F001", { ...nearBrv, ...smoke })
        w.close("BRV")
        w.open("F001", "EMERGENCY")
        w.flush()
        expect(w.flights.F001!.negotiation!.replies.find(r => r.airportId === "BRV")?.code).toBe("CLOSED")
        expect(w.flights.F001!.activeAssignment?.airportId).toBe("ALP")
    })

    test("a silent nearer airport is waited for until the collection deadline, then recorded as TIMEOUT", () => {
        const w = new World()
        w.flight("F001", { ...nearBrv, ...smoke })
        w.drop = e => e.toEntityId === "airport:BRV"
        w.open("F001", "EMERGENCY")
        w.flush()
        expect(w.sentBy("flight:F001", "OFFER_ACCEPT")).toHaveLength(0) // ALP and CHR offered, BRV pending
        w.wall += timing.replyCollectionWindowMs
        w.flights.F001 = flightWallTimers(w.flights.F001!, w.ctx()).state
        w.flush()
        expect(w.flights.F001!.negotiation!.replies.find(r => r.airportId === "BRV")?.kind).toBe("TIMEOUT")
        expect(w.flights.F001!.activeAssignment?.airportId).toBe("ALP")
    })

    test("weather closing between offer and acceptance rejects it; the flight asks the other two", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.open("F001")
        w.deliver(w.pending()[0]!) // ALP holds and offers
        w.close("ALP")
        w.flush()
        expect(w.reservationsOf("F001").filter(r => r.airportId === "ALP")).toHaveLength(0)
        const accepts = w.sentBy("flight:F001", "OFFER_ACCEPT").map(e => e.toEntityId)
        expect(accepts[0]).toBe("airport:ALP")
        expect(w.flights.F001!.activeAssignment?.airportId).not.toBe("ALP")
        expect(w.flights.F001!.activeAssignment).not.toBeNull()
    })

    test("all airports unavailable: hold in NO_FEASIBLE_AIRPORT, never accept, retry after 5 s", () => {
        const w = new World()
        w.flight("F001", { ...nearBrv, ...smoke })
        w.close("ALP")
        w.close("BRV")
        w.close("CHR")
        w.open("F001", "EMERGENCY")
        w.flush()
        const f = w.flights.F001!
        expect(f.negotiation?.stage).toBe("NO_FEASIBLE_AIRPORT")
        expect(f.activeAssignment).toBeNull()
        expect(w.sentBy("flight:F001", "OFFER_ACCEPT")).toHaveLength(0)
        w.wall += timing.noFeasibleRetryMs
        w.flights.F001 = flightWallTimers(w.flights.F001!, w.ctx()).state
        expect(w.flights.F001!.negotiationCounter).toBe(2)
    })

    test("unreachable everywhere: no request is sent at all", () => {
        const w = new World()
        w.flight("F001", { ...nearBrv, fuelRemainingSec: 150 })
        w.open("F001", "CLOSURE")
        expect(w.flights.F001!.negotiation?.stage).toBe("NO_FEASIBLE_AIRPORT")
        expect(w.pending()).toHaveLength(0)
    })

    test("clearing weather does not reverse a confirmed diversion", () => {
        const w = new World()
        w.flight("F001", { ...nearBrv })
        w.close("ALP")
        w.open("F001", "CLOSURE")
        w.flush()
        const before = w.flights.F001!.activeAssignment
        expect(before?.airportId).toBe("BRV")
        const reopened = {
            ...w.sentBy("flight:F001", "LANDING_REQUEST")[0]!,
            messageId: crypto.randomUUID(),
            fromEntityId: "airport:ALP",
            toEntityId: "flight:F001",
            type: "AIRPORT_STATUS",
            payload: { airportId: "ALP", statusRevision: 2, restrictions: { arrivalsClosed: false, closedRunways: [], occupancySec: 60, activeIncidentIds: [] } },
        } as ProtocolEnvelope
        w.deliver(reopened)
        expect(w.flights.F001!.activeAssignment).toEqual(before)
        expect(w.pending()).toHaveLength(0)
    })

    test("emergency preemption revokes the displaced reservation durably in the same transition", () => {
        const w = new World()
        const r = (id: string, runwayId: "R1" | "R2", flightId: string): Reservation => ({
            negotiationId: `${flightId}-N1`,
            offerId: `${flightId}-N1@ALP`,
            airportId: "ALP",
            runwayId,
            slotStartSimSec: 360,
            occupancySec: 60,
            expiresAtWallMs: 0,
            airportOperationalRevision: 0,
            flightId,
            requestMessageId: crypto.randomUUID(),
            priority: "NORMAL",
            reservationId: id,
            status: "CONFIRMED",
        })
        w.airport("ALP", { reservations: { "rsv-A": r("rsv-A", "R1", "F002"), "rsv-B": r("rsv-B", "R2", "F003") } })
        w.flight("F001", { ...nearAlp, priority: "EMERGENCY", deadlineSimSec: 400 })
        w.open("F001", "EMERGENCY")
        w.deliver(w.pending().find(e => e.toEntityId === "airport:ALP")!)
        const out = w.pending().filter(e => e.fromEntityId === "airport:ALP")
        expect(out.map(e => [e.type, e.toEntityId])).toEqual([
            ["RESERVATION_REVOKED", "flight:F002"],
            ["LANDING_OFFER", "flight:F001"],
        ])
        expect(w.airports.ALP.reservations["rsv-A"]!.status).toBe("REVOKED")
        expect(w.airports.ALP.reservations["rsv-B"]!.status).toBe("CONFIRMED")
    })
})

describe("stale and late messages", () => {
    test("an offer from a previous round is declined, not recorded", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.open("F001")
        const firstRequest = w.pending()[0]!
        w.deliver(firstRequest)
        const oldOffer = w.pending().find(e => e.type === "LANDING_OFFER")!
        // A revocation-style trigger supersedes the round before the old offer is read.
        w.flights.F001 = openRound(w.flights.F001!, "CLOSURE", w.ctx()).state
        w.pending()
        w.deliver(oldOffer)
        const f = w.flights.F001!
        expect(f.negotiation!.roundId).toBe("F001-N2")
        expect(f.negotiation!.replies.every(r => r.kind === "PENDING")).toBe(true)
        expect(w.pending().map(e => e.type)).toEqual(["OFFER_DECLINE"])
    })

    test("a late confirmation never overwrites the current assignment; it is released", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.open("F001")
        w.flush()
        const current = w.flights.F001!.activeAssignment
        const late = {
            ...w.sentBy("airport:ALP", "LANDING_CONFIRMED")[0]!,
            messageId: crypto.randomUUID(),
            fromEntityId: "airport:CHR",
            payload: { negotiationId: "F001-N0", offerId: "F001-N0@CHR", reservationId: "rsv-F001-N0@CHR", runwayId: "R1", slotStartSimSec: 900, occupancySec: 60 },
        } as ProtocolEnvelope
        w.deliver(late)
        expect(w.flights.F001!.activeAssignment).toEqual(current)
        expect(w.pending().map(e => [e.type, e.toEntityId, e.correlationId])).toEqual([["RESERVATION_RELEASE", "airport:CHR", "F001-N0"]])
    })

    test("a terminal flight releases a confirmation instead of adopting it", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.drop = e => e.type === "LANDING_CONFIRMED"
        w.open("F001")
        w.flush()
        const confirm = w.delivered.length // nothing delivered for the confirmation
        expect(confirm).toBeGreaterThan(0)
        const env = w.airports.ALP.outbox.map(o => o.envelope).find(e => e.type === "LANDING_CONFIRMED")!
        w.flight("F001", { phase: "UNRESOLVED", terminalReason: "FUEL_EXHAUSTED" })
        w.drop = () => false
        w.deliver(env)
        expect(w.flights.F001!.activeAssignment).toBeNull()
        w.flush()
        expect(w.reservationsOf("F001").map(r => r.status)).toEqual(["RELEASED"])
    })

    test("revocation discards the assignment and opens a new round", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.open("F001")
        w.flush()
        const ctx = w.ctx()
        const r = revokeArrangements(w.airports.ALP, () => true, "CLOSED", "Weather", ctx)
        w.airports.ALP = { ...r.airport, outbox: [...r.airport.outbox, ...r.out.map(e => ({ envelope: e, recipientHandle: "x", attemptCount: 0, nextAttemptAtWallMs: 0, transportMessageId: null, acknowledged: false }))] }
        w.close("ALP")
        w.flush()
        const f = w.flights.F001!
        expect(f.negotiationCounter).toBeGreaterThanOrEqual(2)
        expect(f.activeAssignment?.airportId).not.toBe("ALP")
    })
})

describe("acceptance and confirmation revalidate arrival feasibility", () => {
    test("acceptance with facts that can no longer make the slot is refused, never booked", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.drop = e => e.type === "OFFER_ACCEPT"
        w.open("F001")
        w.flush()
        const accept = w.sentBy("flight:F001", "OFFER_ACCEPT")
        expect(accept).toHaveLength(0)
        const env = w.flights.F001!.outbox.map(o => o.envelope).find(e => e.type === "OFFER_ACCEPT")!
        const starving = { ...env, payload: { ...(env.payload as object), facts: { ...(env.payload as { facts: object }).facts, fuelRemainingSec: 200 } } } as never
        const t = acceptOffer(w.airports.ALP, starving, w.ctx())
        expect(t.result.code).toBe("UNREACHABLE")
        expect(Object.keys(t.state.reservations)).toHaveLength(0)
    })

    test("a confirmation the flight can no longer make is released and renegotiated", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.drop = e => e.type === "LANDING_CONFIRMED"
        w.open("F001")
        w.flush()
        const confirm = w.airports.ALP.outbox.map(o => o.envelope).find(e => e.type === "LANDING_CONFIRMED")!
        w.flight("F001", { fuelRemainingSec: 300 }) // slot 360 is now beyond the fuel reserve
        w.drop = () => false
        w.deliver(confirm)
        const f = w.flights.F001!
        expect(f.activeAssignment).toBeNull()
        expect(f.releaseObligations.map(o => o.reservationId)).toEqual([(confirm.payload as { reservationId: string }).reservationId])
        w.flush()
        expect(w.reservationsOf("F001").find(r => r.reservationId === (confirm.payload as { reservationId: string }).reservationId)?.status).toBe("RELEASED")
    })
})

describe("stale proposals and invalid clearances never land (review focus 3)", () => {
    test("an ATC job finishing after a closure produces a refusal, not an offer", () => {
        const w = new World()
        w.mode = "JOB"
        w.flight("F001", nearAlp)
        w.flights.F001 = openRound(w.flights.F001!, "INITIAL", { ...w.ctx(), decisionMode: "IMMEDIATE" }).state
        w.deliver(w.pending()[0]!)
        expect(w.pending().filter(e => e.type === "LANDING_OFFER")).toHaveLength(0) // held, waiting on ATC
        const job = Object.values(w.airports.ALP.jobs)[0]!
        const hold = Object.values(w.airports.ALP.offers)[0]!
        const r = revokeArrangements(w.airports.ALP, () => true, "CLOSED", "Weather", w.ctx())
        w.airports.ALP = r.airport
        expect(r.out.map(e => [e.type, (e.payload as { code: string }).code])).toEqual([["LANDING_REFUSED", "CLOSED"]])
        expect(w.airports.ALP.jobs[job.jobId]!.status).toBe("CANCELLED")
        const late = commitAtcDecision(
            w.airports.ALP,
            job.jobId,
            { type: "PROPOSE_OFFER", negotiationId: hold.negotiationId, flightId: "F001", runwayId: hold.runwayId, slotStartSimSec: hold.slotStartSimSec, reason: "ok" },
            "MODEL",
            w.ctx(),
        )
        expect(late.result.outcome).toBe("REJECTED")
        expect(late.state.outbox.some(o => o.envelope.type === "LANDING_OFFER")).toBe(false)
    })

    test("an ATC model that invents a slot or refuses an emergency is overridden by the hold (RULES_FALLBACK)", () => {
        for (const emergency of [false, true]) {
            const w = new World()
            w.mode = "JOB"
            w.flight("F001", emergency ? { ...nearAlp, ...smoke } : nearAlp)
            w.flights.F001 = openRound(w.flights.F001!, "INITIAL", { ...w.ctx(), decisionMode: "IMMEDIATE" }).state
            w.deliver(w.pending()[0]!)
            const job = Object.values(w.airports.ALP.jobs)[0]!
            const hold = Object.values(w.airports.ALP.offers)[0]!
            const bad = emergency
                ? ({ type: "REFUSE", negotiationId: hold.negotiationId, flightId: "F001", code: "NO_CAPACITY", reason: "busy" } as const)
                : ({ type: "PROPOSE_OFFER", negotiationId: hold.negotiationId, flightId: "F001", runwayId: "R2", slotStartSimSec: 60, reason: "sooner" } as const)
            const t = commitAtcDecision(w.airports.ALP, job.jobId, bad, "MODEL", w.ctx())
            expect(t.appliedSource).toBe("RULES_FALLBACK")
            const offer = t.state.outbox.map(o => o.envelope).find(e => e.type === "LANDING_OFFER")!
            expect(offer.payload).toMatchObject({ runwayId: hold.runwayId, slotStartSimSec: hold.slotStartSimSec })
            expect(t.state.jobs[job.jobId]!.outcome?.source).toBe("RULES_FALLBACK")
        }
    })

    test("a pilot REQUEST_LANDING matching the rule candidates commits as MODEL", () => {
        const w = new World()
        w.mode = "JOB"
        w.flight("F001", { ...nearBrv, ...smoke })
        w.open("F001", "EMERGENCY")
        expect(w.pending()).toHaveLength(0) // queued for the pilot agent, nothing sent yet
        const reqJob = Object.values(w.flights.F001!.jobs).find(j => j.status === "QUEUED")!
        const t1 = commitPilotDecision(w.flights.F001!, reqJob.jobId, { type: "REQUEST_LANDING", airportIds: ["CHR", "ALP", "BRV"], reason: "all" }, "MODEL", w.ctx())
        expect(t1.appliedSource).toBe("MODEL")
        expect(t1.state.outbox.map(o => o.envelope.toEntityId)).toEqual(["airport:BRV", "airport:ALP", "airport:CHR"])
        const dropOne = commitPilotDecision(w.flights.F001!, reqJob.jobId, { type: "REQUEST_LANDING", airportIds: ["CHR"], reason: "far one" }, "MODEL", w.ctx())
        expect(dropOne.appliedSource).toBe("RULES_FALLBACK")
        expect(dropOne.state.outbox).toHaveLength(3)
    })

    test("a pilot SELECT_OFFER that is not the mandated best becomes RULES_FALLBACK; stale revision rejects", () => {
        const w = new World()
        w.flight("F001", { ...nearBrv, ...smoke })
        w.mode = "IMMEDIATE"
        w.open("F001", "EMERGENCY")
        // Deliver requests and offers, but intercept the flight's own acceptance step by switching to JOB mode.
        const requests = w.pending()
        for (const r of requests) w.deliver(r)
        w.mode = "JOB"
        for (const e of w.pending()) w.deliver(e)
        const f = w.flights.F001!
        const job = Object.values(f.jobs).find(j => j.status === "QUEUED" && j.input.allowedActions.includes("SELECT_OFFER"))!
        const alpOffer = f.negotiation!.replies.find(r => r.airportId === "ALP")!
        const stale = commitPilotDecision({ ...f, decisionRevision: f.decisionRevision + 1 }, job.jobId, { type: "SELECT_OFFER", offerId: alpOffer.offerId!, airportId: "ALP", reason: "x" }, "MODEL", w.ctx())
        expect(stale.result).toMatchObject({ outcome: "REJECTED", code: "STALE_STATE" })
        expect(stale.state.outbox.some(o => o.envelope.type === "OFFER_ACCEPT")).toBe(false)
        const t = commitPilotDecision(f, job.jobId, { type: "SELECT_OFFER", offerId: alpOffer.offerId!, airportId: "ALP", reason: "bigger airport" }, "MODEL", w.ctx())
        expect(t.appliedSource).toBe("RULES_FALLBACK")
        const accept = t.state.outbox.map(o => o.envelope).filter(e => e.type === "OFFER_ACCEPT")
        expect(accept.map(e => e.toEntityId)).toEqual(["airport:BRV"])
    })

    test("a clearance invalidated by a closure fails validation and touchdown; the flight renegotiates", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.open("F001")
        w.flush()
        w.sim = 250
        w.flight("F001", { position: { x: 50, y: 44 }, lastAdvancedSimSec: 250 }) // 6 NM out, 90 s to the runway
        w.flights.F001 = requestClearance(w.flights.F001!, w.ctx()).state
        w.flush()
        const a = w.flights.F001!.activeAssignment!
        expect(a.clearanceId).not.toBeNull()
        const check = { flightId: "F001", reservationId: a.reservationId, clearanceId: a.clearanceId! }
        expect(validateClearance(w.airports.ALP, check, w.sim).valid).toBe(true)

        const r = revokeArrangements(w.airports.ALP, () => true, "CLOSED", "Weather", w.ctx())
        w.airports.ALP = { ...r.airport, restrictions: { ...r.airport.restrictions, arrivalsClosed: true } }
        expect(validateClearance(w.airports.ALP, check, 360)).toMatchObject({ valid: false })
        expect(recordAirportTouchdown(w.airports.ALP, { ...check, position: { x: 50, y: 50 }, tickId: "t1" }, w.ctx({ simNowSec: 360 })).receipt).toBeNull()

        for (const e of r.out) w.deliver(e)
        expect(w.flights.F001!.activeAssignment).toBeNull()
        expect(w.flights.F001!.negotiationCounter).toBe(2)
    })

    test("touchdown only inside [slot, slot+30]; a recorded touchdown survives a later closure", () => {
        const w = new World()
        w.flight("F001", nearAlp)
        w.open("F001")
        w.flush()
        w.sim = 250
        w.flight("F001", { position: { x: 50, y: 44 }, lastAdvancedSimSec: 250 }) // 6 NM out, 90 s to the runway
        w.flights.F001 = requestClearance(w.flights.F001!, w.ctx()).state
        w.flush()
        const a = w.flights.F001!.activeAssignment!
        const input = { flightId: "F001", reservationId: a.reservationId, clearanceId: a.clearanceId!, position: { x: 50, y: 50 }, tickId: "t" }
        expect(recordAirportTouchdown(w.airports.ALP, input, w.ctx({ simNowSec: 359 })).reason).toBe("WINDOW_NOT_OPEN")
        expect(recordAirportTouchdown(w.airports.ALP, input, w.ctx({ simNowSec: 391 })).receipt).toBeNull()
        const ok = recordAirportTouchdown(w.airports.ALP, input, w.ctx({ simNowSec: 370 }))
        expect(ok.receipt).toMatchObject({ touchdownAtSimSec: 370, occupiedUntilSimSec: 430, runwayId: "R1" })
        const closed = { ...ok.state, restrictions: { ...ok.state.restrictions, arrivalsClosed: true } }
        expect(recordAirportTouchdown(closed, input, w.ctx({ simNowSec: 375 })).receipt).toEqual(ok.receipt)
    })
})
