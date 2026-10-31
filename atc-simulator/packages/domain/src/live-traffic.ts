// Live callsigns from OpenSky Network. server/src/live/opensky.ts picks the flights once at run
// creation and stores them in SimulationState.liveTrafficSeed; world generation reads that seed,
// so a run replays the same flights after a restart or reset. Entity IDs (flight:F001) never change.
import { airportsForNetwork, CRUISE_SPEED_KNOTS, MAP_HEIGHT_NM, MAP_WIDTH_NM } from "./constants.js"
import type { FlightState, LiveFlight, LiveTrafficSeed, Point, RunConfig } from "./contracts.js"

export const LIVE_TRAFFIC_SOURCE = "OpenSky Network" as const
export const LIVE_TRAFFIC_ATTRIBUTION = "Live callsigns: OpenSky Network"
export const AIRLINE_CALLSIGN = /^[A-Z]{3}\d{1,4}[A-Z]?$/

// Same equirectangular projection as web/MAP-SOURCES.md and web/src/lib/us-geography.ts.
export function projectUs(longitude: number, latitude: number): Point {
    return { x: 12 + (longitude + 125) * 3.65, y: 17 + (50 - latitude) * 4.65 }
}

// A true track as a map heading. The projection stretches longitude and latitude differently.
export function projectedHeadingDeg(trueTrackDeg: number, latitude: number): number {
    const rad = (trueTrackDeg * Math.PI) / 180
    const east = (Math.sin(rad) / Math.cos((latitude * Math.PI) / 180)) * 3.65
    const north = Math.cos(rad) * 4.65
    const deg = (Math.atan2(east, north) * 180) / Math.PI
    return ((deg % 360) + 360) % 360
}

export const isBayAreaFocus = (config: Pick<RunConfig, "airportNetwork" | "focusRegion">): boolean =>
    config.airportNetwork === "US" && config.focusRegion === "BAY_AREA"
export const isNycFocus = (config: Pick<RunConfig, "airportNetwork" | "focusRegion">): boolean =>
    config.airportNetwork === "US" && config.focusRegion === "NYC"
// Scenario focus regions own positions, destinations and fuel; live traffic lends callsigns only.
export const isCallsignOnlyFocus = (config: Pick<RunConfig, "airportNetwork" | "focusRegion">): boolean => isBayAreaFocus(config) || isNycFocus(config)

const clampToMap = (p: Point): Point => ({
    x: Math.min(MAP_WIDTH_NM - 1, Math.max(1, p.x)),
    y: Math.min(MAP_HEIGHT_NM - 1, Math.max(1, p.y)),
})

/** The live flight lent to a flight ID (F001 takes flights[0]); null when the seed is absent or exhausted. */
export function liveFlightFor(config: RunConfig, seed: LiveTrafficSeed | null | undefined, flightId: string): LiveFlight | null {
    if (!seed || config.airportNetwork !== "US") return null
    const index = Number(flightId.slice(1)) - 1
    return Number.isInteger(index) && index >= 0 ? (seed.flights[index] ?? null) : null
}

/**
 * BAY_AREA and NYC lend only the callsign: the scenario owns positions, destinations, fuel and speed.
 * US places the flight where it really is, on its real track, bound for the airport it was
 * selected for. Speed stays at the sim cruise speed (incidents reset to it anyway) and fuel
 * stays seeded, so scenario timing is unchanged.
 */
export function applyLiveTraffic(config: RunConfig, flights: FlightState[], seed: LiveTrafficSeed | null | undefined): FlightState[] {
    if (!seed || config.airportNetwork !== "US") return flights
    const directory = airportsForNetwork("US")
    const bay = isCallsignOnlyFocus(config)
    return flights.map(flight => {
        const live = liveFlightFor(config, seed, flight.flightId)
        if (!live) return flight
        const lent = { ...flight, callsign: live.callsign }
        const destination = directory.find(a => a.airportId === live.destinationAirportId)
        if (bay || !destination) return lent
        const { originAirportId: _airborne, ...rest } = lent
        return {
            ...rest,
            originalDestination: destination.airportId,
            position: clampToMap(projectUs(live.lon, live.lat)),
            headingDeg: projectedHeadingDeg(live.headingDeg, live.lat),
            speedKnots: CRUISE_SPEED_KNOTS,
        }
    })
}
