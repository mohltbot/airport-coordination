// Bay Area demo placement and run-level negotiation policy (team decision 2026-10-31).
// Pure and deterministic for a given config. Positions, destinations and fuel are simulation data;
// live traffic may only lend callsigns onto these flights (see web/BAY-AREA-DEMO.md).
import { CRUISE_SPEED_KNOTS, INITIAL_FUEL_BASE_SEC, INITIAL_FUEL_RANGE_SEC, US_AIRPORTS } from "./constants.js"
import type { AirportId, FlightState, InitialWorld, Point, RunConfig } from "./contracts.js"
import { distanceNm, headingDeg, polarOffset } from "./geometry.js"

export const BAY_AREA_DESTINATIONS = ["SFO", "OAK", "SJC"] as const satisfies readonly AirportId[]
// Wider Bay Area arrival view, in simulation coordinates (+y is south).
export const BAY_AREA_BOX = { minX: 3, maxX: 43, minY: 52, maxY: 94 } as const
export const BAY_AREA_SPAWN_NM = { min: 12, max: 18 } as const
// Ordinary traffic keeps clear of Monterey so the featured flight's emergency is the story there.
export const MRY_CLEARANCE_NM = 3
// Featured flight: 8 sim NM south of Monterey, inbound to SFO. Nearest airports from here are
// MRY (8.0 NM), SJC (11.6), SFO (12.9), OAK (13.4), LAX (13.6). Farther south, LAX overtakes SJC.
export const FEATURED_POSITION: Point = { x: 23.6, y: 87.4 }
export const FEATURED_DESTINATION: AirportId = "SFO"
export const FEATURED_FUEL_SEC = 4200

const airport = (id: AirportId) => US_AIRPORTS.find(a => a.airportId === id)!

function rng(seed: number): () => number {
    let a = (seed ^ 0x9e3779b9) >>> 0
    return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const inBox = (p: Point) => p.x >= BAY_AREA_BOX.minX && p.x <= BAY_AREA_BOX.maxX && p.y >= BAY_AREA_BOX.minY && p.y <= BAY_AREA_BOX.maxY

function spawnNear(destination: Point, rand: () => number, index: number): Point {
    const mry = airport("MRY").position
    // Spread arrivals around the compass instead of spawning inside the holding ring.
    const bearing = index * Math.PI * (3 - Math.sqrt(5)) + (rand() - .5) * .35
    for (let attempt = 0; attempt < 64; attempt++) {
        const p = polarOffset(destination, bearing + attempt * .2, BAY_AREA_SPAWN_NM.min + (BAY_AREA_SPAWN_NM.max - BAY_AREA_SPAWN_NM.min) * rand())
        if (inBox(p) && distanceNm(p, mry) >= MRY_CLEARANCE_NM) return p
    }
    // Due east remains outside the holding boundary and inside the arrival view.
    return { x: destination.x + BAY_AREA_SPAWN_NM.min, y: destination.y }
}

// Re-place a US world's flights around SFO/OAK/SJC (never MRY) with the featured flight south of MRY.
export function placeBayAreaFlights(config: RunConfig, flights: readonly FlightState[]): FlightState[] {
    const rand = rng(config.seed)
    let ordinary = 0
    return flights.map(f => {
        if (f.flightId === config.featuredFlightId) {
            const dest = airport(FEATURED_DESTINATION)
            return {
                ...f,
                originalDestination: FEATURED_DESTINATION,
                position: { ...FEATURED_POSITION },
                headingDeg: headingDeg(FEATURED_POSITION, dest.position),
                speedKnots: CRUISE_SPEED_KNOTS,
                fuelRemainingSec: FEATURED_FUEL_SEC,
            }
        }
        const destId = BAY_AREA_DESTINATIONS[ordinary++ % BAY_AREA_DESTINATIONS.length]!
        const dest = airport(destId).position
        const position = spawnNear(dest, rand, ordinary - 1)
        return {
            ...f,
            originalDestination: destId,
            position,
            headingDeg: headingDeg(position, dest),
            speedKnots: CRUISE_SPEED_KNOTS,
            fuelRemainingSec: INITIAL_FUEL_BASE_SEC + Math.floor(INITIAL_FUEL_RANGE_SEC * rand()),
        }
    })
}

// Run-level options applied after createWorld: Bay Area placement and the emergency candidate mode.
export function applyDemoConfig(config: RunConfig, world: InitialWorld): InitialWorld {
    let flights = world.flights
    if (config.focusRegion === "BAY_AREA" && config.airportNetwork === "US" && !config.continuousTraffic)
        flights = placeBayAreaFlights(config, flights)
    if (config.emergencyCandidateMode === "SEQUENTIAL") flights = flights.map(f => ({ ...f, emergencyCandidateMode: "SEQUENTIAL" as const }))
    const smoke = config.smokeDeadlineSec
    if (smoke !== undefined) flights = flights.map(f => ({ ...f, smokeDeadlineSec: smoke }))
    return flights === world.flights ? world : { ...world, flights }
}
