import { describe, expect, test } from "bun:test"
import { DEFAULT_SEED } from "../../packages/domain/src/constants.ts"
import { AirportStateSchema, FlightStateSchema } from "../../packages/domain/src/contracts.ts"
import { createWorld } from "../../packages/domain/src/world.ts"
import { distanceNm } from "../../packages/domain/src/geometry.ts"

const opts = { runId: "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c", operationId: "op" }

describe("createWorld", () => {
    test("1 and 30 flights validate against the aggregate schemas", () => {
        for (const flightCount of [1, 30]) {
            const w = createWorld({ flightCount, seed: DEFAULT_SEED, speed: 10 }, opts)
            expect(w.airports).toHaveLength(3)
            expect(w.flights).toHaveLength(flightCount)
            for (const a of w.airports) AirportStateSchema.parse(a)
            for (const f of w.flights) FlightStateSchema.parse(f)
        }
    })
    test.each([0, 31, 2.5, Number.NaN])("rejects flightCount %p", flightCount => {
        expect(() => createWorld({ flightCount, seed: 1, speed: 10 }, opts)).toThrow()
    })
    test("rejects invalid seed and unsupported speed", () => {
        expect(() => createWorld({ flightCount: 5, seed: -1, speed: 10 }, opts)).toThrow()
        expect(() => createWorld({ flightCount: 5, seed: 1, speed: 2 as 5 }, opts)).toThrow()
    })
    test("same seed and config give identical positions, fuel and IDs", () => {
        const a = createWorld({ flightCount: 20, seed: 42, speed: 5 }, opts)
        const b = createWorld({ flightCount: 20, seed: 42, speed: 5 }, opts)
        expect(b).toEqual(a)
        const c = createWorld({ flightCount: 20, seed: 43, speed: 5 }, opts)
        expect(c.flights.map(f => f.position)).not.toEqual(a.flights.map(f => f.position))
    })
    test("10 flights: destinations ALP 4, BRV 3, CHR 3; IDs and callsigns", () => {
        const w = createWorld({ flightCount: 10, seed: DEFAULT_SEED, speed: 10 }, opts)
        const count = (id: string) => w.flights.filter(f => f.originalDestination === id).length
        expect([count("ALP"), count("BRV"), count("CHR")]).toEqual([4, 3, 3])
        expect(w.flights[0]).toMatchObject({ flightId: "F001", callsign: "GHOST 001", entityId: "flight:F001" })
        expect(w.flights[9].flightId).toBe("F010")
    })
    test("spawn distance 25 to 40 NM from destination; fuel 3600 to 5399; cruise 240 kt", () => {
        const w = createWorld({ flightCount: 30, seed: DEFAULT_SEED, speed: 10 }, opts)
        for (const f of w.flights) {
            const dest = w.airports.find(a => a.airportId === f.originalDestination)!
            const d = distanceNm(f.position, dest.position)
            expect(d).toBeGreaterThanOrEqual(25 - 1e-9)
            expect(d).toBeLessThanOrEqual(40 + 1e-9)
            expect(f.fuelRemainingSec).toBeGreaterThanOrEqual(3600)
            expect(f.fuelRemainingSec).toBeLessThan(5400)
            expect(f.speedKnots).toBe(240)
            expect(f.phase).toBe("ENROUTE")
        }
    })
    test("airports at the specified coordinates with two open runways and every field present", () => {
        const w = createWorld({ flightCount: 3, seed: 1, speed: 1 }, opts)
        expect(w.airports.map(a => [a.airportId, a.position.x, a.position.y])).toEqual([["ALP", 50, 50], ["BRV", 110, 110], ["CHR", 170, 50]])
        for (const a of w.airports) {
            expect(a.runways.map(r => r.runwayId)).toEqual(["R1", "R2"])
            expect(a.restrictions).toEqual({ arrivalsClosed: false, closedRunways: [], occupancySec: 60, activeIncidentIds: [] })
        }
    })
})
