// Seeded world generation (design §4). Pure and deterministic for a given config.
import {
    AIRPORTS,
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
    type RunConfig,
} from "./contracts.js"
import { headingDeg, polarOffset } from "./geometry.js"

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

export function createWorld(config: RunConfig, options: WorldOptions): InitialWorld {
    const cfg = RunConfigSchema.parse(config)
    const { runId, operationId } = options
    const airports: AirportState[] = AIRPORTS.map(a => ({
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
        const destination = AIRPORTS[(i - 1) % AIRPORTS.length]
        // Consumption order is fixed by the spec: angle, distance, fuel.
        const angle = 2 * Math.PI * rand()
        const distance = SPAWN_DISTANCE_MIN_NM + SPAWN_DISTANCE_RANGE_NM * rand()
        const fuel = INITIAL_FUEL_BASE_SEC + Math.floor(INITIAL_FUEL_RANGE_SEC * rand())
        const position = polarOffset(destination.position, angle, distance)
        const flightId = flightIdFor(i)
        flights.push({
            ...common(runId, operationId),
            entityId: flightEntityId(flightId),
            flightId,
            callsign: `GHOST ${flightId.slice(1)}`,
            originalDestination: destination.airportId as AirportId,
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
    return { airports, flights }
}
