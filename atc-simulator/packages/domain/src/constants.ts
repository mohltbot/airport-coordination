// Every numerical default from the design spec (§1, §4, §5, §6, §7, §8, §10).
// Simulation fields are seconds (…Sec); wall-clock fields are milliseconds (…Ms).

export const SIMULATION_ACTOR_ID = "ghost-tower"
export const SCHEMA_VERSION = 1

// Flights and runs
export const FLIGHT_COUNT_MIN = 1
export const FLIGHT_COUNT_MAX = 30
export const FLIGHT_COUNT_DEFAULT = 10
export const FLIGHT_COUNT_PRESETS = [5, 10, 20, 30] as const
export const DEFAULT_SEED = 20261031
export const SEED_MAX = 0xffffffff
export const SPEEDS = [1, 5, 10] as const
export const DEFAULT_SPEED = 10

// World
export const MAP_WIDTH_NM = 240
export const MAP_HEIGHT_NM = 160
export const AIRPORT_IDS = ["ALP", "BRV", "CHR", "ATL", "DFW", "DEN", "ORD", "LAX", "JFK", "CLT", "LAS", "MCO", "MIA", "SFO", "OAK", "SJC"] as const
export const RUNWAY_IDS = ["R1", "R2"] as const
export const AIRPORTS = [
    { airportId: "ALP", name: "Alpha", position: { x: 50, y: 50 } },
    { airportId: "BRV", name: "Bravo", position: { x: 110, y: 110 } },
    { airportId: "CHR", name: "Charlie", position: { x: 170, y: 50 } },
] as const
// Real US geography, compressed into the unchanged simulation coordinate space.
export const US_AIRPORTS = [
    {
        "airportId": "ATL",
        "name": "Hartsfield\u2013Jackson Atlanta International Airport",
        "city": "Atlanta",
        "latitude": 33.6367,
        "longitude": -84.428101,
        "rank": 1,
        "position": {
            "x": 160.0874,
            "y": 93.0893
        }
    },
    {
        "airportId": "DFW",
        "name": "Dallas Fort Worth International Airport",
        "city": "Dallas-Fort Worth",
        "latitude": 32.896801,
        "longitude": -97.038002,
        "rank": 2,
        "position": {
            "x": 114.0613,
            "y": 96.5299
        }
    },
    {
        "airportId": "DEN",
        "name": "Denver International Airport",
        "city": "Denver",
        "latitude": 39.860027,
        "longitude": -104.673792,
        "rank": 3,
        "position": {
            "x": 86.1907,
            "y": 64.1509
        }
    },
    {
        "airportId": "ORD",
        "name": "Chicago O'Hare International Airport",
        "city": "Chicago",
        "latitude": 41.9786,
        "longitude": -87.9048,
        "rank": 4,
        "position": {
            "x": 147.3975,
            "y": 54.2995
        }
    },
    {
        "airportId": "LAX",
        "name": "Los Angeles International Airport",
        "city": "Los Angeles",
        "latitude": 33.942501,
        "longitude": -118.407997,
        "rank": 5,
        "position": {
            "x": 36.0608,
            "y": 91.6674
        }
    },
    {
        "airportId": "JFK",
        "name": "John F. Kennedy International Airport",
        "city": "New York",
        "latitude": 40.639447,
        "longitude": -73.779317,
        "rank": 6,
        "position": {
            "x": 198.9555,
            "y": 60.5266
        }
    },
    {
        "airportId": "CLT",
        "name": "Charlotte Douglas International Airport",
        "city": "Charlotte",
        "latitude": 35.2140007019043,
        "longitude": -80.94309997558594,
        "rank": 7,
        "position": {
            "x": 172.8077,
            "y": 85.7549
        }
    },
    {
        "airportId": "LAS",
        "name": "Harry Reid International Airport",
        "city": "Las Vegas",
        "latitude": 36.083361,
        "longitude": -115.151817,
        "rank": 8,
        "position": {
            "x": 47.9459,
            "y": 81.7124
        }
    },
    {
        "airportId": "MCO",
        "name": "Orlando International Airport",
        "city": "Orlando",
        "latitude": 28.429399490356445,
        "longitude": -81.30899810791016,
        "rank": 9,
        "position": {
            "x": 171.4722,
            "y": 117.3033
        }
    },
    {
        "airportId": "MIA",
        "name": "Miami International Airport",
        "city": "Miami",
        "latitude": 25.796011,
        "longitude": -80.289751,
        "rank": 10,
        "position": {
            "x": 175.1924,
            "y": 129.5485
        }
    },
    {
        "airportId": "SFO",
        "name": "San Francisco International Airport",
        "city": "San Francisco",
        "latitude": 37.619806,
        "longitude": -122.374821,
        "rank": null,
        "position": {
            "x": 21.5819,
            "y": 74.5679
        }
    },
    {
        "airportId": "OAK",
        "name": "Oakland San Francisco Bay Airport",
        "city": "Oakland",
        "latitude": 37.720085,
        "longitude": -122.221184,
        "rank": null,
        "position": {
            "x": 22.1427,
            "y": 74.1016
        }
    },
    {
        "airportId": "SJC",
        "name": "Mineta San Jose International Airport",
        "city": "San Jose",
        "latitude": 37.362452,
        "longitude": -121.929188,
        "rank": null,
        "position": {
            "x": 23.2085,
            "y": 75.7646
        }
    }
] as const

export const airportsForNetwork = (network?: "US" | "LEGACY") => network === "US" ? US_AIRPORTS : AIRPORTS
export const airportsForDestination = (destination: unknown) => US_AIRPORTS.some(a => a.airportId === destination) ? US_AIRPORTS : AIRPORTS

export const SPAWN_DISTANCE_MIN_NM = 25
export const SPAWN_DISTANCE_RANGE_NM = 15
export const INITIAL_FUEL_BASE_SEC = 3600
export const INITIAL_FUEL_RANGE_SEC = 1800

// Flight performance
export const CRUISE_SPEED_KNOTS = 240
export const ENGINE_TROUBLE_SPEED_KNOTS = 180
export const FUEL_BURN_PER_SIM_SEC = 1
export const FUEL_RESERVE_SEC = 120
export const HOLDING_RADIUS_NM = 6
export const APPROACH_RADIUS_NM = 6
export const CLEARANCE_LEAD_SEC = 120

// Runways and slots
export const RUNWAY_OCCUPANCY_SEC = 60
export const REDUCED_CAPACITY_OCCUPANCY_SEC = 120
export const LANDING_GRACE_SEC = 30
export const SLOT_GRID_SEC = 30
export const SLOT_MIN_LEAD_SEC = 60
export const SLOT_SEARCH_HORIZON_SEC = 1800
export const PREEMPTION_MIN_LEAD_SEC = 120

// Incidents
export const SMOKE_DEADLINE_SEC = 900
export const ENGINE_TROUBLE_DEADLINE_SEC = 1200
export const LOW_FUEL_CAP_SEC = 900
export const LOW_FUEL_EMERGENCY_THRESHOLD_SEC = 900

// Negotiation (wall clock)
export const OFFER_TTL_MS = 20_000
export const COLLECTION_WINDOW_MS = 4_000
export const ACCEPT_TIMEOUT_MS = 5_000
export const NO_FEASIBLE_RETRY_MS = 5_000
export const ROUND_COALESCE_MS = 250
export const MAX_EMERGENCY_CANDIDATES = 3

// Clock and worker (wall clock)
export const SCHEDULER_INTERVAL_MS = 250
export const WORKER_LEASE_MS = 10_000
export const WORKER_RENEW_MS = 3_000

// Agents
export const JOB_LEASE_MS = 10_000
export const MODEL_TIMEOUT_MS = 6_000
export const MAX_CONCURRENT_MODEL_CALLS = 4
export const MAX_MODEL_CALLS_PER_ENTITY = 1
export const MAX_RELEVANT_MESSAGES = 12
export const MAX_MESSAGE_SUMMARY_CHARS = 512
export const MAX_DECISION_INPUT_BYTES = 16 * 1024
export const MAX_REASON_CHARS = 240

// Relay and delivery
export const MAX_RELAY_BODY_BYTES = 8 * 1024
export const OUTBOX_POLL_MS = 250
export const OUTBOX_RETRY_SCHEDULE_MS = [500, 1_000, 2_000, 4_000] as const
export const OUTBOX_RETRY_STEADY_MS = 5_000
export const RELAY_RECONCILE_INTERVAL_MS = 2_000
export const COMMAND_DELAYED_AFTER_MS = 15_000
export const COMMAND_EXPIRY_MS = 60_000

// HTTP, sessions, live view
export const INVITE_TTL_MS = 15 * 60 * 1000
export const INVITE_BYTES = 32
export const CONTROLLER_COMMANDS_PER_SEC_PER_SESSION = 5
export const CONTROLLER_COMMANDS_PER_SEC_PER_RUN = 20
export const SSE_MAX_HZ = 4
export const STALE_FRAME_MS = 2_000
export const TIMELINE_MAX_VISIBLE = 200

// Local services
export const ACTOR_PORT = 7100
export const RELAY_ENGINE_PORT = 8787
export const APP_PORT = 3000
export const VITE_PORT = 5173

// Timing profiles keyed by transport. LOCAL (fake/in-process transport) keeps the spec values.
// HOSTED (real hosted Relay, used by live and rules agents) absorbs 2.5 to 4 s per send and
// 3 to 7 s until an event is readable. Agreed with the UI teammate 2026-10-31.
export type TransportProfile = "HOSTED" | "LOCAL"
export type RelayTiming = {
    replyCollectionWindowMs: number
    offerAcceptTimeoutMs: number
    offerTtlMs: number // proposal expiresAtWallMs = now + offerTtlMs
    ackRetryBackoffMs: readonly number[]
    ackRetrySteadyMs: number
    commandDelayedAfterMs: number
    defaultSpeed: 1 | 5 | 10 // 1, 5 and 10 stay selectable
    expectedBookingWallSec: number
}
export const RELAY_TIMING: { readonly [K in TransportProfile]: RelayTiming } = {
    LOCAL: {
        replyCollectionWindowMs: COLLECTION_WINDOW_MS,
        offerAcceptTimeoutMs: ACCEPT_TIMEOUT_MS,
        offerTtlMs: OFFER_TTL_MS,
        ackRetryBackoffMs: OUTBOX_RETRY_SCHEDULE_MS,
        ackRetrySteadyMs: OUTBOX_RETRY_STEADY_MS,
        commandDelayedAfterMs: COMMAND_DELAYED_AFTER_MS,
        defaultSpeed: DEFAULT_SPEED,
        // 6 s × 10× = 60 sim s, the spec's slot lead at the default speed.
        expectedBookingWallSec: 6,
    },
    HOSTED: {
        // Raised 2026-10-31 from 30/30/90 s: at 10 flights hosted hops measured 5 to 70 s, so
        // offers arrived after the window and flights re-asked every airport. A round still
        // closes as soon as every candidate has answered.
        replyCollectionWindowMs: 60_000,
        offerAcceptTimeoutMs: 45_000,
        offerTtlMs: 120_000,
        ackRetryBackoffMs: [5_000, 10_000, 20_000, 40_000],
        ackRetrySteadyMs: 40_000,
        commandDelayedAfterMs: 15_000,
        defaultSpeed: 5,
        // 45 s raised to 90 s: a hosted booking measured 80 s at 3 flights, so confirmations
        // failed revalidation (INFEASIBLE_CONFIRMATION) and flights needed a second round.
        expectedBookingWallSec: 90,
    },
}

// Earliest slot lead in simulated seconds: booking takes wall time, which runs `speed`× faster in sim.
export function minSlotLeadSimSec(speed: number, profile: RelayTiming): number {
    return Math.max(SLOT_MIN_LEAD_SEC, profile.expectedBookingWallSec * speed)
}

// Env names that override a profile field. Pass process.env from server code;
// this module stays browser-safe and never reads process.env itself.
export const RELAY_TIMING_ENV = {
    replyCollectionWindowMs: "RELAY_REPLY_COLLECTION_WINDOW_MS",
    offerAcceptTimeoutMs: "RELAY_OFFER_ACCEPT_TIMEOUT_MS",
    offerTtlMs: "RELAY_OFFER_TTL_MS",
    ackRetryBackoffMs: "RELAY_ACK_RETRY_BACKOFF_MS", // comma-separated
    ackRetrySteadyMs: "RELAY_ACK_RETRY_STEADY_MS",
    commandDelayedAfterMs: "RELAY_COMMAND_DELAYED_AFTER_MS",
    defaultSpeed: "SIM_DEFAULT_SPEED",
    expectedBookingWallSec: "RELAY_EXPECTED_BOOKING_WALL_SEC",
} as const

export function resolveRelayTiming(profile: TransportProfile, env: Record<string, string | undefined> = {}): RelayTiming {
    const base = RELAY_TIMING[profile]
    const num = (name: string, fallback: number) => {
        const raw = env[name]
        if (raw === undefined || raw.trim() === "") return fallback
        const n = Number(raw)
        if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`)
        return n
    }
    const listRaw = env[RELAY_TIMING_ENV.ackRetryBackoffMs]
    const ackRetryBackoffMs = listRaw?.trim()
        ? listRaw.split(",").map(v => {
              const n = Number(v.trim())
              if (!Number.isInteger(n) || n <= 0) throw new Error(`${RELAY_TIMING_ENV.ackRetryBackoffMs} must list positive integers`)
              return n
          })
        : base.ackRetryBackoffMs
    const speed = num(RELAY_TIMING_ENV.defaultSpeed, base.defaultSpeed)
    if (speed !== 1 && speed !== 5 && speed !== 10) throw new Error(`${RELAY_TIMING_ENV.defaultSpeed} must be 1, 5 or 10`)
    return {
        replyCollectionWindowMs: num(RELAY_TIMING_ENV.replyCollectionWindowMs, base.replyCollectionWindowMs),
        offerAcceptTimeoutMs: num(RELAY_TIMING_ENV.offerAcceptTimeoutMs, base.offerAcceptTimeoutMs),
        offerTtlMs: num(RELAY_TIMING_ENV.offerTtlMs, base.offerTtlMs),
        ackRetryBackoffMs,
        ackRetrySteadyMs: num(RELAY_TIMING_ENV.ackRetrySteadyMs, base.ackRetrySteadyMs),
        commandDelayedAfterMs: num(RELAY_TIMING_ENV.commandDelayedAfterMs, base.commandDelayedAfterMs),
        defaultSpeed: speed,
        expectedBookingWallSec: num(RELAY_TIMING_ENV.expectedBookingWallSec, base.expectedBookingWallSec),
    }
}
