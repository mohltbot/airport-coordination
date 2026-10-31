// New York weather demo placement (team decision 2026-10-31). Pure and deterministic for a given config.
// Flights inbound to JFK (every fourth one to LGA as background traffic) inside the UI's New York
// view. Weather then closes JFK through the controller command path; its bookings are revoked and
// those flights re-negotiate with LGA and EWR, whose runway capacity decides who fits where.
// Live traffic may only lend callsigns (live-traffic.ts).
import { CRUISE_SPEED_KNOTS, US_AIRPORTS } from "./constants.js"
import type { AirportId, FlightState, InitialWorld, Point, RunConfig } from "./contracts.js"
import { distanceNm, headingDeg, polarOffset } from "./geometry.js"

export const NYC_DESTINATIONS = ["JFK", "LGA"] as const satisfies readonly AirportId[]
export const NYC_CLOSED: AirportId = "JFK"
export const NYC_ALTERNATE: AirportId = "EWR"
// Flight i (0-based) flies to LGA when i % 4 === 3, so 8 flights are 6 to JFK and 2 to LGA.
export const nycDestination = (index: number): AirportId => (index % 4 === 3 ? "LGA" : "JFK")
// Arrival envelope; distant aircraft enter the closer regional view as they approach.
export const NYC_BOX = { minX: 166, maxX: 231, minY: 28, maxY: 92 } as const
// Start well outside the approach ring: arrivals fly inbound while towers negotiate slots.
export const NYC_SPAWN_NM = { min: 11, max: 29 } as const
export const NYC_FUEL_BASE_SEC = 3600
export const NYC_FUEL_RANGE_SEC = 900

const airport = (id: AirportId) => US_AIRPORTS.find(a => a.airportId === id)!

function rng(seed: number): () => number {
    let a = (seed ^ 0x5bd1e995) >>> 0
    return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const inBox = (p: Point) => p.x >= NYC_BOX.minX && p.x <= NYC_BOX.maxX && p.y >= NYC_BOX.minY && p.y <= NYC_BOX.maxY

function spawnNear(destination: Point, rand: () => number, index: number): Point {
    const ewr = airport(NYC_ALTERNATE).position
    // Interleave near, medium and distant arrivals instead of sampling one narrow ring.
    const band = [12, 21, 28, 16][index % 4]!
    const radius = band + (rand() - .5) * 2
    for (let attempt = 0; attempt < 64; attempt++) {
        const p = polarOffset(destination, (-2.9 + (index * .9) % 3.3) + (rand() - .5) * .1, radius)
        // Keep ordinary traffic off the top of Newark so the diversion reads on the map.
        if (inBox(p) && distanceNm(p, ewr) >= 2) return p
    }
    return { x: destination.x + NYC_SPAWN_NM.min, y: destination.y }
}

export const isNycFocus = (config: Pick<RunConfig, "airportNetwork" | "focusRegion" | "continuousTraffic">): boolean =>
    config.focusRegion === "NYC" && config.airportNetwork === "US"

// Re-place a US world's flights around JFK and LGA (never EWR): ENROUTE, NORMAL, 240 kt, fuel >= 3600 s.
export function placeNycFlights(config: RunConfig, flights: readonly FlightState[]): FlightState[] {
    const rand = rng(config.seed)
    return flights.map((f, i) => {
        const destId = nycDestination(i)
        const dest = airport(destId).position
        const position = spawnNear(dest, rand, i)
        return {
            ...f,
            originalDestination: destId,
            position,
            headingDeg: headingDeg(position, dest),
            speedKnots: CRUISE_SPEED_KNOTS,
            fuelRemainingSec: NYC_FUEL_BASE_SEC + Math.floor(NYC_FUEL_RANGE_SEC * rand()),
            phase: "ENROUTE",
            priority: "NORMAL",
        }
    })
}

export function applyNycConfig(config: RunConfig, world: InitialWorld): InitialWorld {
    return isNycFocus(config) ? { ...world, flights: placeNycFlights(config, world.flights) } : world
}
