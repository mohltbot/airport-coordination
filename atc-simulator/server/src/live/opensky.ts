// Live callsigns from OpenSky Network, fetched once per run creation (POST /api/runs, US network).
// Anonymous OpenSky allows a few hundred credits a day and a US-wide call costs about 4, so a
// fetch is cached in .data and reused for OPENSKY_CACHE_TTL_MS. Any failure falls back to the
// seeded world (config.liveTraffic null); run creation never waits more than the 5 s timeout.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { airportsForNetwork } from "@ghost-tower/domain/constants"
import { LIVE_TRAFFIC_MAX_FLIGHTS, type LiveFlight, type LiveTrafficSeed, type RunConfig } from "@ghost-tower/domain/contracts"
import { distanceNm } from "@ghost-tower/domain/geometry"
import { AIRLINE_CALLSIGN, LIVE_TRAFFIC_SOURCE, isBayAreaFocus, isNycFocus, projectUs } from "@ghost-tower/domain/live-traffic"

export const OPENSKY_URL = "https://opensky-network.org/api/states/all?lamin=24&lomin=-125&lamax=50&lomax=-66"
export const OPENSKY_TIMEOUT_MS = 5_000
const BOUNDS = { latMin: 24, latMax: 50, lonMin: -125, lonMax: -66 }
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_STALE_MAX_MS = 2 * 60 * 60_000
const FEATURED_DEFAULT_ID = "F001"

/** One airborne airline-style state vector, trimmed to what selection needs. */
export type LiveCandidate = {
    icao24: string
    callsign: string
    lat: number
    lon: number
    trackDeg: number
    groundSpeedKt: number
    altitudeFt: number
}
export type LiveStates = { fetchedAtWallMs: number; candidates: LiveCandidate[] }
export interface LiveTrafficSource {
    /** Null when live data is disabled or unavailable. Never throws. */
    states(): Promise<LiveStates | null>
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** OpenSky field order: 0 icao24, 1 callsign, 5 lon, 6 lat, 7 baro alt m, 8 on_ground, 9 m/s, 10 track, 13 geo alt m. */
export function parseStates(body: unknown): LiveCandidate[] {
    const states = (body as { states?: unknown } | null)?.states
    if (!Array.isArray(states)) return []
    const out: LiveCandidate[] = []
    for (const s of states) {
        if (!Array.isArray(s) || s[8] === true) continue
        const callsign = typeof s[1] === "string" ? s[1].trim() : ""
        const lon = num(s[5]), lat = num(s[6]), velocity = num(s[9]), track = num(s[10])
        if (!AIRLINE_CALLSIGN.test(callsign) || typeof s[0] !== "string" || lon === null || lat === null || velocity === null || track === null) continue
        if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lon < BOUNDS.lonMin || lon > BOUNDS.lonMax) continue
        const altitudeM = num(s[7]) ?? num(s[13]) ?? 0
        out.push({
            icao24: s[0].slice(0, 16),
            callsign,
            lat: Math.round(lat * 1e4) / 1e4,
            lon: Math.round(lon * 1e4) / 1e4,
            trackDeg: Math.round(track * 10) / 10,
            groundSpeedKt: Math.round(velocity * 1.943844),
            altitudeFt: Math.round(altitudeM * 3.28084),
        })
    }
    return out
}

// ---------------------------------------------------------------- selection

const rad = (d: number) => (d * Math.PI) / 180
/** Initial great-circle bearing, degrees clockwise from true north. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1)
    const y = Math.sin(dl) * Math.cos(p2)
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}
const angleDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

// "Arriving": the nearest network airport within ARRIVAL_CONE_DEG of the aircraft's track, between
// ARRIVAL_MIN and ARRIVAL_MAX map units away. One map unit is about 13 real NM; the seeded world
// spawns flights 25 to 40 units out, so selection prefers flights near that range.
const ARRIVAL_CONE_DEG = 20
const ARRIVAL_MIN_UNITS = 12
const ARRIVAL_MAX_UNITS = 70
const PREFERRED_UNITS = 32
const BAY_INBOUND = ["SFO", "OAK", "SJC"] as const
const NYC_INBOUND = ["JFK", "LGA", "EWR"] as const

type Airport = { airportId: string; latitude: number; longitude: number; position: { x: number; y: number } }
type Arrival = { c: LiveCandidate; airportId: string; units: number }

function arrivalFor(c: LiveCandidate, airports: readonly Airport[], minUnits: number): Arrival | null {
    const p = projectUs(c.lon, c.lat)
    let best: Arrival | null = null
    for (const a of airports) {
        const units = distanceNm(p, a.position)
        if (units < minUnits || units > ARRIVAL_MAX_UNITS) continue
        if (angleDiff(bearingDeg(c.lat, c.lon, a.latitude, a.longitude), c.trackDeg) > ARRIVAL_CONE_DEG) continue
        if (!best || units < best.units) best = { c, airportId: a.airportId, units }
    }
    return best
}

/** Round-robin across airports (directory order), so the first N flights spread over the network. */
function interleave(arrivals: Arrival[], airportOrder: readonly string[], rank: (a: Arrival) => number): Arrival[] {
    const groups = new Map<string, Arrival[]>(airportOrder.map(id => [id, []]))
    for (const a of arrivals) groups.get(a.airportId)?.push(a)
    for (const g of groups.values()) g.sort((x, y) => rank(x) - rank(y) || x.c.callsign.localeCompare(y.c.callsign))
    const out: Arrival[] = []
    const rounds = Math.max(0, ...[...groups.values()].map(g => g.length))
    for (let round = 0; round < rounds; round++) for (const g of groups.values()) if (g[round]) out.push(g[round]!)
    return out
}

const toLive = (c: LiveCandidate, destinationAirportId: string | null): LiveFlight => ({
    callsign: c.callsign,
    icao24: c.icao24,
    lat: c.lat,
    lon: c.lon,
    headingDeg: c.trackDeg,
    groundSpeedKt: c.groundSpeedKt,
    altitudeFt: c.altitudeFt,
    destinationAirportId: destinationAirportId as LiveFlight["destinationAirportId"],
})

function uniqueByCallsign(candidates: LiveCandidate[]): LiveCandidate[] {
    const seen = new Set<string>()
    return [...candidates]
        .sort((a, b) => a.callsign.localeCompare(b.callsign) || a.icao24.localeCompare(b.icao24))
        .filter(c => (seen.has(c.callsign) ? false : (seen.add(c.callsign), true)))
}

/**
 * Ordered selection: flights[i] lends to F(i+1); entries past flightCount feed continuous departures.
 * US: real arrivals spread across the network, then callsign donors. BAY_AREA: the featured slot
 * gets a real aircraft south of Monterey heading north, the rest real arrivals to SFO, OAK or
 * SJC, then the airline flights nearest SFO. NYC: real arrivals to JFK, LGA or EWR, then the
 * airline flights nearest JFK. Deterministic for a given input.
 */
export function selectLiveFlights(candidates: LiveCandidate[], config: RunConfig, max = LIVE_TRAFFIC_MAX_FLIGHTS): LiveFlight[] {
    const directory = airportsForNetwork("US") as readonly Airport[]
    const pool = uniqueByCallsign(candidates)
    const used = new Set<string>()
    const take = (c: LiveCandidate) => (used.add(c.callsign), c)

    // NYC lends callsigns only: real arrivals to JFK, LGA or EWR, then the airline flights nearest JFK.
    if (isNycFocus(config)) {
        const at = (id: string) => directory.find(a => a.airportId === id)!
        const jfk = at("JFK")
        const arrivals = pool.map(c => arrivalFor(c, NYC_INBOUND.map(at), 1)).filter((a): a is Arrival => a !== null)
        const out = interleave(arrivals, NYC_INBOUND, a => a.units).map(a => toLive(take(a.c), a.airportId))
        const near = pool
            .filter(c => !used.has(c.callsign))
            .sort((a, b) => distanceNm(projectUs(a.lon, a.lat), jfk.position) - distanceNm(projectUs(b.lon, b.lat), jfk.position) || a.callsign.localeCompare(b.callsign))
        out.push(...near.map(c => toLive(c, null)))
        return out.slice(0, max)
    }

    if (!isBayAreaFocus(config)) {
        const arrivals = pool.map(c => arrivalFor(c, directory, ARRIVAL_MIN_UNITS)).filter((a): a is Arrival => a !== null)
        const ordered = interleave(arrivals, directory.map(a => a.airportId), a => Math.abs(a.units - PREFERRED_UNITS))
        const out = ordered.map(a => toLive(take(a.c), a.airportId))
        for (const c of pool) if (!used.has(c.callsign)) out.push(toLive(c, null))
        return out.slice(0, max)
    }

    const at = (id: string) => directory.find(a => a.airportId === id)!
    const mry = at("MRY"), sfo = at("SFO")
    const featured = pool
        .filter(c => c.lat < mry.latitude - 0.05 && c.lat > mry.latitude - 3 && c.lon > -124 && c.lon < -119.5 && angleDiff(c.trackDeg, 0) <= 50)
        .map(c => ({ c, aim: angleDiff(c.trackDeg, bearingDeg(c.lat, c.lon, sfo.latitude, sfo.longitude)), units: distanceNm(projectUs(c.lon, c.lat), mry.position) }))
        .sort((a, b) => a.aim - b.aim || a.units - b.units || a.c.callsign.localeCompare(b.c.callsign))[0]
    if (featured) take(featured.c)
    const bay = BAY_INBOUND.map(at)
    const arrivals = pool.filter(c => !used.has(c.callsign)).map(c => arrivalFor(c, bay, 1)).filter((a): a is Arrival => a !== null)
    const rest = interleave(arrivals, BAY_INBOUND, a => a.units).map(a => toLive(take(a.c), a.airportId))
    const nearSfo = pool
        .filter(c => !used.has(c.callsign))
        .sort((a, b) => distanceNm(projectUs(a.lon, a.lat), sfo.position) - distanceNm(projectUs(b.lon, b.lat), sfo.position) || a.callsign.localeCompare(b.callsign))
    rest.push(...nearSfo.map(c => toLive(c, null)))
    const featuredIndex = Math.max(0, Number((config.featuredFlightId ?? FEATURED_DEFAULT_ID).slice(1)) - 1 || 0)
    if (featured) rest.splice(Math.min(featuredIndex, rest.length), 0, toLive(featured.c, null))
    return rest.slice(0, max)
}

// ---------------------------------------------------------------- fetch and cache

export type OpenSkyOptions = {
    dataDir: string
    env?: Record<string, string | undefined>
    fetchImpl?: typeof fetch
    now?: () => number
    timeoutMs?: number
    log?: (line: string) => void
}

const envMs = (raw: string | undefined, fallback: number) => {
    const n = Number(raw)
    return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * OPENSKY_LIVE=0 disables fetching; tests (NODE_ENV=test) are off unless OPENSKY_LIVE=1.
 * OPENSKY_CACHE_TTL_MS (default 5 min) reuses the last fetch without spending credits.
 * OPENSKY_STALE_MAX_MS (default 2 h, 0 disables) serves an older cache when a fetch fails;
 * the attribution then carries that older fetch time.
 */
export function createOpenSkySource(options: OpenSkyOptions): LiveTrafficSource {
    const env = options.env ?? process.env
    const now = options.now ?? Date.now
    const log = options.log ?? (line => console.log(`[opensky] ${line}`))
    const fetchImpl = options.fetchImpl ?? fetch
    const timeoutMs = options.timeoutMs ?? OPENSKY_TIMEOUT_MS
    const enabled = env.OPENSKY_LIVE === "1" || (env.OPENSKY_LIVE !== "0" && env.NODE_ENV !== "test")
    const ttlMs = envMs(env.OPENSKY_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS)
    const staleMaxMs = envMs(env.OPENSKY_STALE_MAX_MS, DEFAULT_STALE_MAX_MS)
    const cachePath = join(options.dataDir, "opensky-states.json")
    let inflight: Promise<LiveStates | null> | null = null

    const readCache = (): LiveStates | null => {
        try {
            const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as LiveStates
            return Number.isFinite(parsed.fetchedAtWallMs) && Array.isArray(parsed.candidates) ? parsed : null
        } catch {
            return null
        }
    }
    const writeCache = (states: LiveStates) => {
        try {
            mkdirSync(options.dataDir, { recursive: true })
            writeFileSync(`${cachePath}.tmp`, JSON.stringify(states))
            renameSync(`${cachePath}.tmp`, cachePath)
        } catch (err) {
            log(`cache write failed: ${(err as Error).message}`)
        }
    }

    async function load(): Promise<LiveStates | null> {
        const cached = readCache()
        const age = cached ? now() - cached.fetchedAtWallMs : Infinity
        if (cached && age >= 0 && age <= ttlMs) return cached
        try {
            const res = await fetchImpl(OPENSKY_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const states: LiveStates = { fetchedAtWallMs: now(), candidates: parseStates(await res.json()) }
            if (!states.candidates.length) throw new Error("no airborne airline flights in the response")
            writeCache(states)
            log(`fetched ${states.candidates.length} airborne airline flights`)
            return states
        } catch (err) {
            const reason = (err as Error).name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : (err as Error).message
            if (cached && age >= 0 && age <= staleMaxMs) {
                log(`fetch failed (${reason}); using the cache from ${Math.round(age / 60_000)} min ago`)
                return cached
            }
            log(`fetch failed (${reason}); seeded callsigns`)
            return null
        }
    }

    return {
        async states() {
            if (!enabled) return null
            inflight ??= load().finally(() => (inflight = null))
            return inflight
        },
    }
}

/**
 * Run creation: attach the public attribution to the config and return the server-only seed.
 * LEGACY runs drop any client-sent liveTraffic. BAY_AREA keeps a demo-script featuredFlightId
 * and otherwise sets F001. Never throws: a failed source yields liveTraffic null.
 */
export async function prepareLiveRun(config: RunConfig, source: LiveTrafficSource | null): Promise<{ config: RunConfig; seed: LiveTrafficSeed | null }> {
    const { liveTraffic: _clientValue, ...base } = config
    const prepared: RunConfig = isBayAreaFocus(base) && !base.featuredFlightId ? { ...base, featuredFlightId: FEATURED_DEFAULT_ID } : base
    if (prepared.airportNetwork !== "US") return { config: prepared, seed: null }
    const states = await (source?.states() ?? Promise.resolve(null)).catch(() => null)
    const flights = states ? selectLiveFlights(states.candidates, prepared) : []
    if (!states || !flights.length) return { config: { ...prepared, liveTraffic: null }, seed: null }
    const attribution = { source: LIVE_TRAFFIC_SOURCE, fetchedAtWallMs: Math.round(states.fetchedAtWallMs) }
    return { config: { ...prepared, liveTraffic: attribution }, seed: { ...attribution, flights } }
}
