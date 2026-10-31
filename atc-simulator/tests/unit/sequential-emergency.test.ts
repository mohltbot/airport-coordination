import { describe, expect, test } from "bun:test"
import { US_AIRPORTS } from "../../packages/domain/src/constants.ts"
import type { AirportId, AirportState, FlightState, ProtocolEnvelope, RunConfig } from "../../packages/domain/src/contracts.ts"
import { BAY_AREA_DESTINATIONS, FEATURED_POSITION, MRY_CLEARANCE_NM } from "../../packages/domain/src/bay-area.ts"
import { distanceNm } from "../../packages/domain/src/geometry.ts"
import { applyIncident } from "../../packages/domain/src/incidents.ts"
import {
    advanceNegotiation,
    buildPilotView,
    commitPilotDecision,
    flightWallTimers,
    openRound,
    receiveAirportNegotiation,
    revokeArrangements,
    type DecisionMode,
    type NegotiationContext,
    type NegotiationTiming,
} from "../../packages/domain/src/negotiation.ts"
import { summarizePayload } from "../../packages/domain/src/projections.ts"
import { createWorld } from "../../packages/domain/src/world.ts"

const runId = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"
const timing: NegotiationTiming = { replyCollectionWindowMs: 4_000, offerAcceptTimeoutMs: 5_000, offerTtlMs: 20_000, minSlotLeadSimSec: 60, noFeasibleRetryMs: 5_000 }
const bayConfig = (over: Partial<RunConfig> = {}): RunConfig => ({
    flightCount: 10,
    seed: 20261031,
    speed: 5,
    airportNetwork: "US",
    focusRegion: "BAY_AREA",
    emergencyCandidateMode: "SEQUENTIAL",
    featuredFlightId: "F001",
    ...over,
})
const smoke = { priority: "EMERGENCY" as const, deadlineSimSec: 900 }

// In-memory network over the Bay Area world: entities exchange their outbox envelopes. No Relay.
class Bay {
    wall = 1_000_000
    sim = 0
    mode: DecisionMode = "IMMEDIATE"
    airports: Record<string, AirportState>
    flights: Record<string, FlightState>
    sent = new Map<string, number>()
    delivered: ProtocolEnvelope[] = []
    drop: (e: ProtocolEnvelope) => boolean = () => false

    constructor(config: RunConfig = bayConfig()) {
        const w = createWorld(config, { runId, operationId: "op" })
        this.airports = Object.fromEntries(w.airports.map(a => [a.airportId, a]))
        this.flights = Object.fromEntries(w.flights.map(f => [f.flightId, f]))
    }
    ctx(): NegotiationContext {
        return { simNowSec: this.sim, wallNowMs: this.wall, timing, decisionMode: this.mode }
    }
    // Close both MRY runways through the real incident path (two RUNWAY_CLOSED incidents).
    closeMryRunways() {
        const nctx = this.ctx()
        for (const runwayId of ["R1", "R2"] as const) {
            const t = applyIncident(
                this.airports.MRY!,
                { incidentId: crypto.randomUUID(), target: "airport:MRY", kind: "RUNWAY_CLOSED", parameters: { runwayId } },
                { runId, simNowSec: this.sim, wallNowMs: this.wall, revokeArrangements: (a, affects, code, reason, cause) => revokeArrangements(a, affects, code, reason, nctx, cause) },
            )
            this.airports.MRY = t.state
        }
        this.sent.set("airport:MRY", this.airports.MRY!.outbox.length)
    }
    emergency(flightId = "F001") {
        this.flights[flightId] = { ...this.flights[flightId]!, ...smoke }
        this.flights[flightId] = openRound(this.flights[flightId]!, "EMERGENCY", this.ctx()).state
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
            const id = env.toEntityId.slice(8)
            const t = receiveAirportNegotiation(this.airports[id]!, env, this.ctx())
            if (t) this.airports[id] = t.state
        } else {
            const id = env.toEntityId.slice(7)
            this.flights[id] = advanceNegotiation(this.flights[id]!, env, this.ctx()).state
        }
    }
    // One hop at a time, so tests can observe ordering.
    step(): ProtocolEnvelope[] {
        const batch = this.pending()
        for (const env of batch) if (!this.drop(env)) this.deliver(env)
        return batch
    }
    flush(rounds = 30) {
        for (let i = 0; i < rounds; i++) if (this.step().length === 0) return
        throw new Error("network did not settle")
    }
    timers(flightId = "F001") {
        this.flights[flightId] = flightWallTimers(this.flights[flightId]!, this.ctx()).state
    }
    from(flightId: string, type: ProtocolEnvelope["type"]) {
        return this.delivered.filter(e => e.fromEntityId === `flight:${flightId}` && e.type === type)
    }
    to(flightId: string, type: ProtocolEnvelope["type"]) {
        return this.delivered.filter(e => e.toEntityId === `flight:${flightId}` && e.type === type)
    }
}

const position = (id: AirportId) => US_AIRPORTS.find(a => a.airportId === id)!.position

describe("Bay Area placement", () => {
    test("featured flight sits south of MRY inbound to SFO; MRY then SJC are its nearest airports", () => {
        const b = new Bay()
        const f = b.flights.F001!
        expect(f.position).toEqual(FEATURED_POSITION)
        expect(f.originalDestination).toBe("SFO")
        expect(f.position.y).toBeGreaterThan(position("MRY").y)
        const order = (["SFO", "OAK", "SJC", "MRY"] as const).map(id => [id, distanceNm(f.position, position(id))] as const).sort((a, c) => a[1] - c[1])
        expect(order.map(o => o[0]).slice(0, 2)).toEqual(["MRY", "SJC"])
        expect(f.emergencyCandidateMode).toBe("SEQUENTIAL")
    })

    test("other traffic flies to SFO, OAK or SJC, inside the view box, clear of MRY", () => {
        const b = new Bay()
        const others = Object.values(b.flights).filter(f => f.flightId !== "F001")
        expect(others).toHaveLength(9)
        for (const f of others) {
            expect(BAY_AREA_DESTINATIONS as readonly string[]).toContain(f.originalDestination)
            const d = distanceNm(f.position, position(f.originalDestination))
            expect(d).toBeGreaterThanOrEqual(3.99)
            expect(d).toBeLessThanOrEqual(9.01)
            expect(distanceNm(f.position, position("MRY"))).toBeGreaterThanOrEqual(MRY_CLEARANCE_NM)
            expect(f.fuelRemainingSec).toBeGreaterThanOrEqual(3600)
        }
    })

    test("absent demo fields keep the old world exactly", () => {
        const plain = createWorld({ flightCount: 10, seed: 20261031, speed: 5, airportNetwork: "US" }, { runId, operationId: "op" })
        const nulls = createWorld({ flightCount: 10, seed: 20261031, speed: 5, airportNetwork: "US", focusRegion: null, featuredFlightId: null }, { runId, operationId: "op" })
        expect(nulls).toEqual(plain)
        expect(plain.flights.every(f => f.emergencyCandidateMode === undefined)).toBe(true)
    })
})

describe("SEQUENTIAL emergency negotiation", () => {
    test("MRY refuses with RUNWAY_CLOSED, then SJC is asked, offers, confirms", () => {
        const b = new Bay()
        b.closeMryRunways()
        b.emergency()
        const round = b.flights.F001!.negotiation!
        expect(round.sequential).toBe(true)
        expect(round.candidateAirports.slice(0, 2)).toEqual(["MRY", "SJC"])

        // Hop 1: only MRY is asked.
        const first = b.step()
        expect(first.filter(e => e.type === "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:MRY"])

        // Hop 2: MRY's refusal carries the reason derived from its closed runways.
        const second = b.step()
        const refusal = second.find(e => e.type === "LANDING_REFUSED")!
        expect(refusal.fromEntityId).toBe("airport:MRY")
        expect(refusal.payload).toMatchObject({ code: "CLOSED", reasonCode: "RUNWAY_CLOSED", reasonText: "runways R1 and R2 closed" })
        expect(summarizePayload(refusal.type, refusal.payload)).toBe("Monterey Tower: unable to accept your landing request, runways R1 and R2 closed.")

        // Hop 3: only after the refusal does the flight ask SJC.
        const third = b.step()
        expect(third.filter(e => e.type === "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:SJC"])
        b.flush()

        const requests = b.from("F001", "LANDING_REQUEST").map(e => e.toEntityId)
        expect(requests).toEqual(["airport:MRY", "airport:SJC"])
        const f = b.flights.F001!
        expect(f.activeAssignment?.airportId).toBe("SJC")
        expect(f.negotiation!.replies.map(r => [r.airportId, r.kind])).toEqual([
            ["MRY", "REFUSED"],
            ["SJC", "OFFER"],
        ])
        expect(b.airports.SJC!.reservations[f.activeAssignment!.reservationId]!.status).toBe("CONFIRMED")
    })

    test("no parallel fan-out: at most one landing request is outstanding at any time", () => {
        const b = new Bay()
        b.closeMryRunways()
        b.emergency()
        for (let i = 0; i < 30; i++) {
            const out = b.flights.F001!.negotiation!.replies.filter(r => r.kind === "PENDING")
            expect(out.length).toBeLessThanOrEqual(1)
            if (b.step().length === 0) break
        }
        expect(b.from("F001", "LANDING_REQUEST")).toHaveLength(2)
    })

    test("a lost MRY reply times out to the next candidate, and a late MRY reply is not adopted", () => {
        const b = new Bay()
        b.emergency()
        let held: ProtocolEnvelope | null = null
        b.drop = e => {
            if (e.fromEntityId === "airport:MRY" && e.type === "LANDING_OFFER") {
                held = e
                return true
            }
            return false
        }
        b.flush()
        expect(b.from("F001", "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:MRY"])
        expect(b.flights.F001!.activeAssignment).toBeNull()

        b.wall += timing.replyCollectionWindowMs
        b.timers()
        b.drop = () => false
        b.flush()
        expect(b.from("F001", "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:MRY", "airport:SJC"])
        expect(b.flights.F001!.negotiation!.replies.map(r => [r.airportId, r.kind])).toEqual([
            ["MRY", "TIMEOUT"],
            ["SJC", "OFFER"],
        ])
        expect(b.flights.F001!.activeAssignment?.airportId).toBe("SJC")

        // MRY's offer finally arrives: declined, the SJC assignment stands.
        b.deliver(held!)
        b.flush()
        expect(b.flights.F001!.activeAssignment?.airportId).toBe("SJC")
        expect(b.from("F001", "OFFER_DECLINE").map(e => e.toEntityId)).toContain("airport:MRY")
    })

    test("an open MRY is accepted first and SJC is never asked", () => {
        const b = new Bay()
        b.emergency()
        b.flush()
        expect(b.from("F001", "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:MRY"])
        expect(b.flights.F001!.activeAssignment?.airportId).toBe("MRY")
    })

    test("PARALLEL (absent mode) still asks every candidate at once and skips a known-closed MRY", () => {
        const b = new Bay(bayConfig({ emergencyCandidateMode: undefined }))
        b.closeMryRunways()
        b.flights.F001 = {
            ...b.flights.F001!,
            knownAirportStatus: { MRY: { airportId: "MRY", statusRevision: 2, restrictions: b.airports.MRY!.restrictions } },
        }
        b.emergency()
        const first = b.step().filter(e => e.type === "LANDING_REQUEST").map(e => e.toEntityId)
        expect(first.length).toBeGreaterThan(1)
        expect(first).not.toContain("airport:MRY")
        expect(b.flights.F001!.negotiation!.sequential).toBeUndefined()
    })

    test("SEQUENTIAL still asks a known-closed MRY: its tower gives the real reason", () => {
        const b = new Bay()
        b.closeMryRunways()
        b.flights.F001 = {
            ...b.flights.F001!,
            knownAirportStatus: { MRY: { airportId: "MRY", statusRevision: 2, restrictions: b.airports.MRY!.restrictions } },
        }
        b.emergency()
        expect(b.step().filter(e => e.type === "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:MRY"])
    })

    test("JOB mode: the pilot's REQUEST_LANDING covers only the nearest candidate", () => {
        const b = new Bay()
        b.mode = "JOB"
        b.closeMryRunways()
        b.emergency()
        const f = b.flights.F001!
        const view = buildPilotView(f, b.ctx())
        expect(view.requestCandidates).toEqual(["MRY"])
        expect(view.sequentialQueue?.[0]).toBe("SJC")
        const job = Object.values(f.jobs).find(j => j.kind === "PILOT_DECISION" && j.status === "QUEUED")!
        const t = commitPilotDecision(f, job.jobId, { type: "REQUEST_LANDING", airportIds: ["MRY"], reason: "nearest first" }, "MODEL", b.ctx())
        expect(t.appliedSource).toBe("MODEL")
        b.flights.F001 = t.state
        expect(b.step().filter(e => e.type === "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:MRY"])
    })

    test("smoke during the INITIAL acceptance opens the emergency round once SFO confirms", () => {
        const b = new Bay()
        b.closeMryRunways()
        b.flights.F001 = openRound(b.flights.F001!, "INITIAL", b.ctx()).state
        b.step() // request reaches SFO
        b.step() // offer reaches F001, which sends OFFER_ACCEPT
        expect(b.flights.F001!.pendingAcceptance).not.toBeNull()
        b.emergency() // refused while the acceptance is pending
        expect(b.flights.F001!.negotiation!.trigger).toBe("INITIAL")
        b.flush()
        const f = b.flights.F001!
        expect(b.from("F001", "LANDING_REQUEST").map(e => e.toEntityId)).toEqual(["airport:SFO", "airport:MRY", "airport:SJC"])
        expect(f.activeAssignment?.airportId).toBe("SJC")
        expect(b.from("F001", "RESERVATION_RELEASE").map(e => e.toEntityId)).toEqual(["airport:SFO"])
    })
})
