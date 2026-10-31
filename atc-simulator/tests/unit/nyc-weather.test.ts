import { describe, expect, test } from "bun:test"
import { RUNWAY_OCCUPANCY_SEC, US_AIRPORTS } from "../../packages/domain/src/constants.ts"
import type { AirportId, AirportState, FlightState, ProtocolEnvelope, RunConfig } from "../../packages/domain/src/contracts.ts"
import { distanceNm } from "../../packages/domain/src/geometry.ts"
import { applyIncident } from "../../packages/domain/src/incidents.ts"
import { applyLiveTraffic } from "../../packages/domain/src/live-traffic.ts"
import {
    advanceNegotiation,
    flightWallTimers,
    openRound,
    planCandidates,
    receiveAirportNegotiation,
    revokeArrangements,
    type NegotiationContext,
    type NegotiationTiming,
} from "../../packages/domain/src/negotiation.ts"
import { NYC_BOX, NYC_SPAWN_NM, nycDestination } from "../../packages/domain/src/nyc.ts"
import { createWorld } from "../../packages/domain/src/world.ts"

const runId = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"
const timing: NegotiationTiming = { replyCollectionWindowMs: 4_000, offerAcceptTimeoutMs: 5_000, offerTtlMs: 20_000, minSlotLeadSimSec: 120, noFeasibleRetryMs: 5_000 }
const nycConfig = (over: Partial<RunConfig> = {}): RunConfig => ({ flightCount: 8, seed: 20261031, speed: 10, airportNetwork: "US", focusRegion: "NYC", ...over })
const position = (id: AirportId) => US_AIRPORTS.find(a => a.airportId === id)!.position

// In-memory network over the NYC world: entities exchange their outbox envelopes. No Relay.
class Nyc {
    wall = 1_000_000
    sim = 0
    airports: Record<string, AirportState>
    flights: Record<string, FlightState>
    sent = new Map<string, number>()
    delivered: ProtocolEnvelope[] = []

    constructor(config: RunConfig = nycConfig()) {
        const w = createWorld(config, { runId, operationId: "op" })
        this.airports = Object.fromEntries(w.airports.map(a => [a.airportId, a]))
        this.flights = Object.fromEntries(w.flights.map(f => [f.flightId, f]))
    }
    ctx(): NegotiationContext {
        return { simNowSec: this.sim, wallNowMs: this.wall, timing, decisionMode: "IMMEDIATE" }
    }
    weather(id: AirportId) {
        const nctx = this.ctx()
        const t = applyIncident(
            this.airports[id]!,
            { incidentId: crypto.randomUUID(), target: `airport:${id}`, kind: "WEATHER_CLOSED", parameters: {} },
            { runId, simNowSec: this.sim, wallNowMs: this.wall, revokeArrangements: (a, affects, code, reason, cause) => revokeArrangements(a, affects, code, reason, nctx, cause) },
        )
        this.airports[id] = t.state
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
    flush(rounds = 60) {
        for (let i = 0; i < rounds; i++) {
            const batch = this.pending()
            if (batch.length === 0) {
                // Collection windows close on the wall clock.
                this.wall += 5_000
                for (const id of Object.keys(this.flights)) this.flights[id] = flightWallTimers(this.flights[id]!, this.ctx()).state
                if (this.pending().length === 0) return
                continue
            }
            for (const env of batch) this.deliver(env)
        }
        throw new Error("network did not settle")
    }
}

describe("NYC placement", () => {
    test("8 flights, 6 inbound to JFK and 2 to LGA, inside the New York view, ENROUTE NORMAL 240 kt, fuel >= 3600 s", () => {
        const w = createWorld(nycConfig(), { runId, operationId: "op" })
        expect(w).toEqual(createWorld(nycConfig(), { runId, operationId: "op" }))
        expect(w.flights.map(f => f.flightId)).toEqual(["F001", "F002", "F003", "F004", "F005", "F006", "F007", "F008"])
        w.flights.forEach((f, i) => {
            expect(f.originalDestination).toBe(nycDestination(i))
            const d = distanceNm(f.position, position(f.originalDestination))
            expect(d).toBeGreaterThanOrEqual(NYC_SPAWN_NM.min - 0.01)
            expect(d).toBeLessThanOrEqual(NYC_SPAWN_NM.max + 0.01)
            expect(f.position.x).toBeGreaterThanOrEqual(NYC_BOX.minX)
            expect(f.position.x).toBeLessThanOrEqual(NYC_BOX.maxX)
            expect(f.position.y).toBeGreaterThanOrEqual(NYC_BOX.minY)
            expect(f.position.y).toBeLessThanOrEqual(NYC_BOX.maxY)
            expect(f).toMatchObject({ phase: "ENROUTE", priority: "NORMAL", speedKnots: 240 })
            expect(f.fuelRemainingSec).toBeGreaterThanOrEqual(3600)
            // LGA and EWR are short hops: well inside fuel.
            for (const alt of ["LGA", "EWR"] as const) expect((distanceNm(f.position, position(alt)) / 240) * 3600).toBeLessThan(f.fuelRemainingSec - 600)
        })
    })

    test("continuous traffic and other focus regions keep their worlds; live traffic lends callsigns only", () => {
        const plain = createWorld({ flightCount: 8, seed: 20261031, speed: 10, airportNetwork: "US" }, { runId, operationId: "op" })
        expect(plain.flights.map(f => f.originalDestination)).not.toEqual(createWorld(nycConfig(), { runId, operationId: "op" }).flights.map(f => f.originalDestination))
        const continuous = createWorld(nycConfig({ continuousTraffic: true }), { runId, operationId: "op" })
        expect(continuous).toEqual(createWorld({ ...nycConfig(), focusRegion: null, continuousTraffic: true }, { runId, operationId: "op" }))
        const seed = { source: "OpenSky Network" as const, fetchedAtWallMs: 1, flights: [{ callsign: "DAL123", icao24: "abc123", lat: 41.9, lon: -87.9, headingDeg: 90, groundSpeedKt: 400, altitudeFt: 30000, destinationAirportId: "ORD" as const }] }
        const lent = applyLiveTraffic(nycConfig(), plain.flights, seed)
        expect(lent[0]!.callsign).toBe("DAL123")
        expect(lent[0]!.position).toEqual(plain.flights[0]!.position)
        const live = createWorld(nycConfig(), { runId, operationId: "op" }, seed)
        expect(live.flights[0]!.callsign).toBe("DAL123")
        expect(live.flights[0]!.originalDestination).toBe("JFK")
    })
})

describe("NYC weather diversion", () => {
    test("JFK closes for weather: its bookings are revoked, JFK refuses truthfully, LGA and EWR take them within runway capacity", () => {
        const n = new Nyc()
        expect(Object.values(n.flights).filter(f => f.originalDestination === "JFK")).toHaveLength(6)
        for (const id of Object.keys(n.flights)) n.flights[id] = openRound(n.flights[id]!, "INITIAL", n.ctx()).state
        n.flush()
        for (const f of Object.values(n.flights)) expect(f.activeAssignment?.airportId).toBe(f.originalDestination)

        n.weather("JFK")
        n.flush()

        const revoked = n.delivered.filter(e => e.type === "RESERVATION_REVOKED")
        expect(revoked).toHaveLength(6)
        expect(new Set(revoked.map(e => e.fromEntityId))).toEqual(new Set(["airport:JFK"]))
        for (const f of Object.values(n.flights).filter(f => f.originalDestination === "JFK")) {
            const asked = n.delivered.filter(e => e.fromEntityId === f.entityId && e.type === "LANDING_REQUEST").map(e => e.toEntityId)
            expect(asked).toContain("airport:EWR")
            expect(asked).toContain("airport:LGA")
            expect(["LGA", "EWR"]).toContain(f.activeAssignment?.airportId ?? "none")
        }
        const refusals = n.delivered.filter(e => e.type === "LANDING_REFUSED" && e.fromEntityId === "airport:JFK")
        for (const r of refusals) expect(r.payload).toMatchObject({ reasonCode: "WEATHER_CLOSED" })
        // LGA background traffic keeps its booking.
        for (const f of Object.values(n.flights).filter(f => f.originalDestination === "LGA")) expect(f.activeAssignment?.airportId).toBe("LGA")
        expect(Object.values(n.flights).some(f => f.activeAssignment?.airportId === "JFK")).toBe(false)

        // Runway capacity at both open airports: one landing per runway per occupancy window.
        for (const id of ["LGA", "EWR"] as const) {
            const reservations = Object.values(n.airports[id]!.reservations).filter(r => r.status === "CONFIRMED")
            for (const runwayId of ["R1", "R2"]) {
                const slots = reservations.filter(r => r.runwayId === runwayId).map(r => r.slotStartSimSec).sort((a, b) => a - b)
                for (let i = 1; i < slots.length; i++) expect(slots[i]! - slots[i - 1]!).toBeGreaterThanOrEqual(RUNWAY_OCCUPANCY_SEC)
            }
        }
        expect(Object.values(n.flights).filter(f => f.activeAssignment).length).toBe(8)
    })

    test("once a flight knows JFK is closed, LGA and EWR head its candidate list", () => {
        const n = new Nyc()
        n.weather("JFK")
        const jfk = n.airports.JFK!
        const f = n.flights.F001!
        const known = { ...f, knownAirportStatus: { JFK: { airportId: "JFK", statusRevision: jfk.statusRevision, restrictions: jfk.restrictions } } } as FlightState
        expect(planCandidates(known, "CLOSURE", n.ctx()).slice(0, 2).sort()).toEqual(["EWR", "LGA"])
        expect(planCandidates(f, "CLOSURE", n.ctx())).toContain("EWR")
    })
})
