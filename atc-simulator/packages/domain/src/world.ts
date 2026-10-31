// Seeded world generation (design §4). Pure and deterministic for a given config.
import {
    airportsForNetwork,
    CRUISE_SPEED_KNOTS,
    INITIAL_FUEL_BASE_SEC,
    INITIAL_FUEL_RANGE_SEC,
    RUNWAY_IDS,
    RUNWAY_OCCUPANCY_SEC,
    SPAWN_DISTANCE_MIN_NM,
    SPAWN_DISTANCE_RANGE_NM,
} from "./constants.js"
import {
    RunConfigSchema,
    airportEntityId,
    flightEntityId,
    type AirportId,
    type AirportState,
    type FlightState,
    type InitialWorld,
    type LiveTrafficSeed,
    type RunConfig,
} from "./contracts.js"
import { headingDeg, polarOffset } from "./geometry.js"
import { applyLiveTraffic, isBayAreaFocus, liveFlightFor } from "./live-traffic.js"
import { applyDemoConfig } from "./bay-area.js"
import { applyNycConfig } from "./nyc.js"

export function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

export type WorldOptions = { runId: string; operationId: string }

const common = (runId: string, operationId: string) => ({
    runId,
    stateRevision: 0,
    decisionRevision: 0,
    lastTickId: null,
    lastAdvancedSimSec: 0,
    inbox: {},
    outbox: [],
    jobs: {},
    lastControllerSequence: 0,
    bufferedControllerMessages: [],
    fencing: { workerEpoch: 0, leaseToken: null },
    initializedByOperationId: operationId,
})

export function flightIdFor(index: number): string {
    return `F${String(index).padStart(3, "0")}`
}

// liveSeed: the run's stored OpenSky selection (SimulationState.liveTrafficSeed); absent keeps the seeded world.
export function createWorld(config: RunConfig, options: WorldOptions, liveSeed?: LiveTrafficSeed | null): InitialWorld {
    const cfg = RunConfigSchema.parse(config)
    const { runId, operationId } = options
    const directory = airportsForNetwork(cfg.airportNetwork)
    const airports: AirportState[] = directory.map(a => ({
        ...common(runId, operationId),
        entityId: airportEntityId(a.airportId),
        airportId: a.airportId,
        name: a.name,
        position: { x: a.position.x, y: a.position.y },
        incidents: {},
        restrictions: { arrivalsClosed: false, closedRunways: [], occupancySec: RUNWAY_OCCUPANCY_SEC, activeIncidentIds: [] },
        statusRevision: 0,
        operationalRevision: 0,
        runways: RUNWAY_IDS.map(runwayId => ({ runwayId, occupiedUntilSimSec: null })),
        offers: {},
        reservations: {},
        clearances: {},
        touchdowns: {},
    }))
    const rand = mulberry32(cfg.seed)
    const flights: FlightState[] = []
    for (let i = 1; i <= cfg.flightCount; i++) {
        const destination = directory[(i - 1) % directory.length]
        // Consumption order is fixed by the spec: angle, distance, fuel.
        const angle = 2 * Math.PI * rand()
        const distance = SPAWN_DISTANCE_MIN_NM + SPAWN_DISTANCE_RANGE_NM * rand()
        const fuel = INITIAL_FUEL_BASE_SEC + Math.floor(INITIAL_FUEL_RANGE_SEC * rand())
        const origin = cfg.continuousTraffic && !cfg.focusRegion ? directory[i % directory.length]! : null
        const position = origin ? { ...origin.position } : polarOffset(destination.position, angle, distance)
        const flightId = flightIdFor(i)
        flights.push({
            ...common(runId, operationId),
            entityId: flightEntityId(flightId),
            flightId,
            callsign: `GHOST ${flightId.slice(1)}`,
            originalDestination: destination.airportId as AirportId,
            ...(origin ? { originAirportId: origin.airportId as AirportId } : {}),
            position,
            headingDeg: headingDeg(position, destination.position),
            speedKnots: CRUISE_SPEED_KNOTS,
            fuelRemainingSec: fuel,
            phase: "ENROUTE",
            holdCenter: null,
            holdAngle: null,
            incidents: {},
            priority: "NORMAL",
            deadlineSimSec: null,
            knownAirportStatus: {},
            negotiation: null,
            negotiationCounter: 0,
            pendingAcceptance: null,
            activeAssignment: null,
            releaseObligations: [],
            landingReceipt: null,
            terminalReason: null,
        })
    }
    const world = applyNycConfig(cfg, applyDemoConfig(cfg, { airports, flights: applyLiveTraffic(cfg, flights, liveSeed) }))
    // One background departure is already rolling at the start; subsequent legs are paced by the scheduler.
    if (cfg.continuousTraffic && cfg.airportNetwork === "US" && cfg.focusRegion && cfg.flightCount >= 3) {
        const flight = [...world.flights].reverse().find(f => f.flightId !== cfg.featuredFlightId)!
        const origin = directory.find(a => a.airportId === (cfg.focusRegion === "NYC" ? "LGA" : "OAK"))!
        const destination = directory.find(a => a.airportId === (cfg.focusRegion === "NYC" ? "ORD" : "LAX"))!
        Object.assign(flight, { originAirportId: origin.airportId, originalDestination: destination.airportId,
            position: { ...origin.position }, headingDeg: headingDeg(origin.position, destination.position), fuelRemainingSec: 5400 })
    }
    return world
}

// Fresh legs have a fresh actor identity and start at the current authoritative sim time.
// Replacement legs take the next unused live callsign (and, outside BAY_AREA, its destination),
// then fall back to seeded callsigns once the stored selection runs out.
export function createTrafficFlight(config: RunConfig, options: WorldOptions, sequence: number, simNowSec: number, liveSeed?: LiveTrafficSeed | null): FlightState {
    const directory = airportsForNetwork(config.airportNetwork)
    const initial = createWorld({ ...config, flightCount: 1, seed: (config.seed + sequence) >>> 0, continuousTraffic: true }, options).flights[0]!
    const flightId = flightIdFor(sequence)
    const live = liveFlightFor(config, liveSeed, flightId)
    if (config.airportNetwork === "US" && config.focusRegion) {
        const regionalIds = regionalAirports(config)
        const offset = sequence - config.flightCount - 1
        const regional = directory.find(a => a.airportId === regionalIds[Math.floor(offset / 2) % regionalIds.length])!
        const outbound = offset % 2 === 0
        const remoteIds = config.focusRegion === "NYC" ? ["ORD", "CLT", "MIA"] : ["LAX", "LAS", "DEN"]
        const remote = directory.find(a => a.airportId === remoteIds[Math.floor(offset / 2) % remoteIds.length])!
        const rand = mulberry32(config.seed + sequence * 7919)
        const destination = outbound ? remote : regional
        const position = outbound ? { ...regional.position } : polarOffset(regional.position, sequence * 2.39996, 18 + rand() * 16)
        // Callsigns are borrowed from the live seed; routes and timing remain simulated.
        const { originAirportId: _origin, ...base } = initial
        return { ...base, flightId, entityId: flightEntityId(flightId), callsign: live?.callsign ?? `GHOST ${flightId.slice(1)}`,
            originalDestination: destination.airportId, ...(outbound ? { originAirportId: regional.airportId } : {}),
            position, headingDeg: headingDeg(position, destination.position), fuelRemainingSec: 5400,
            lastAdvancedSimSec: simNowSec }
    }
    const liveDestination = live && !isBayAreaFocus(config) ? directory.find(a => a.airportId === live.destinationAirportId) : undefined
    const destination = liveDestination ?? directory[(sequence - 1) % directory.length]!
    let origin = directory[sequence % directory.length]!
    if (origin.airportId === destination.airportId) origin = directory[(sequence + 1) % directory.length]!
    return { ...initial, flightId, entityId: flightEntityId(flightId), callsign: live?.callsign ?? `GHOST ${flightId.slice(1)}`, originalDestination: destination.airportId, originAirportId: origin.airportId, position: { ...origin.position }, headingDeg: headingDeg(origin.position, destination.position), lastAdvancedSimSec: simNowSec }
}

// Local departures stay within the chosen region. MRY remains available to the featured story.
export function regionalAirports(config: RunConfig): AirportId[] {
    return config.focusRegion === "NYC" ? ["JFK", "LGA", "EWR"] : ["SFO", "OAK", "SJC"]
}
