// OpenSky live callsigns: parsing, projection, selection, world placement and fallback.
// Uses a trimmed recorded sample (tests/fixtures/opensky-states-sample.json); no network calls.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { US_AIRPORTS } from "../../packages/domain/src/constants.ts"
import { FlightStateSchema, LiveTrafficSeedSchema, RunConfigSchema, type RunConfig } from "../../packages/domain/src/contracts.ts"
import { distanceNm } from "../../packages/domain/src/geometry.ts"
import { projectUs, projectedHeadingDeg } from "../../packages/domain/src/live-traffic.ts"
import { createTrafficFlight, createWorld } from "../../packages/domain/src/world.ts"
import { bearingDeg, createOpenSkySource, parseStates, prepareLiveRun, selectLiveFlights, type LiveTrafficSource } from "../../server/src/live/opensky.ts"
import { createRun, emptyRoot, resetRun } from "../../actors/src/simulation.ts"

const sample = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/opensky-states-sample.json"), "utf8")) as { time: number; states: unknown[][] }
const candidates = parseStates(sample)
const opts = { runId: "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c", operationId: "op" }
const US: RunConfig = { flightCount: 10, seed: 20261031, speed: 5, airportNetwork: "US" }
const BAY: RunConfig = { ...US, focusRegion: "BAY_AREA" }
const fixed = (fetchedAtWallMs = 1_793_478_148_000): LiveTrafficSource => ({ states: async () => ({ fetchedAtWallMs, candidates }) })
const failing: LiveTrafficSource = { states: async () => null }
const airport = (id: string) => US_AIRPORTS.find(a => a.airportId === id)!
const angleDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

describe("OpenSky parsing and projection", () => {
    test("keeps airborne airline callsigns with a position and track", () => {
        expect(sample.states.length).toBe(50)
        expect(candidates.length).toBeGreaterThan(30)
        expect(candidates.length).toBeLessThan(sample.states.length)
        for (const c of candidates) expect(c.callsign).toMatch(/^[A-Z]{3}\d{1,4}[A-Z]?$/)
        const raw = new Set(sample.states.filter(s => s[8] === true || s[5] === null).map(s => String(s[1]).trim()))
        for (const c of candidates) expect(raw.has(c.callsign)).toBe(false)
    })
    test("projection matches the bundled airport positions", () => {
        for (const a of US_AIRPORTS) {
            const p = projectUs(a.longitude, a.latitude)
            expect(p.x).toBeCloseTo(a.position.x, 3)
            expect(p.y).toBeCloseTo(a.position.y, 3)
        }
    })
    test("true track converts to the map heading convention", () => {
        expect(projectedHeadingDeg(0, 37)).toBeCloseTo(0, 6)
        expect(projectedHeadingDeg(90, 37)).toBeCloseTo(90, 6)
        expect(projectedHeadingDeg(180, 37)).toBeCloseTo(180, 6)
        expect(projectedHeadingDeg(270, 37)).toBeCloseTo(270, 6)
        // East scales by 3.65 / cos(lat) map units per degree, north by 4.65.
        const east = 3.65 / Math.cos((37 * Math.PI) / 180)
        expect(projectedHeadingDeg(45, 37)).toBeCloseTo((Math.atan2(east, 4.65) * 180) / Math.PI, 6)
        expect(projectedHeadingDeg(45, 47)).toBeGreaterThan(45)
    })
})

describe("selection", () => {
    test("US: real arrivals spread across airports, each on a track toward its destination", () => {
        const flights = selectLiveFlights(candidates, US)
        LiveTrafficSeedSchema.parse({ source: "OpenSky Network", fetchedAtWallMs: 1, flights })
        const firstTen = flights.slice(0, 10)
        expect(new Set(firstTen.map(f => f.destinationAirportId)).size).toBeGreaterThanOrEqual(6)
        for (const f of firstTen) {
            const a = airport(f.destinationAirportId!)
            expect(angleDiff(bearingDeg(f.lat, f.lon, a.latitude, a.longitude), f.headingDeg)).toBeLessThanOrEqual(20)
            const units = distanceNm(projectUs(f.lon, f.lat), a.position)
            expect(units).toBeGreaterThanOrEqual(12)
            expect(units).toBeLessThanOrEqual(70)
        }
        expect(new Set(flights.map(f => f.callsign)).size).toBe(flights.length)
        expect(selectLiveFlights(candidates, US)).toEqual(flights)
    })
    test("BAY_AREA: F001 is south of Monterey heading north, then SFO/OAK/SJC arrivals", () => {
        const flights = selectLiveFlights(candidates, { ...BAY, featuredFlightId: "F001" })
        const mry = airport("MRY")
        expect(flights[0]!.lat).toBeLessThan(mry.latitude)
        expect(angleDiff(flights[0]!.headingDeg, 0)).toBeLessThanOrEqual(50)
        const inbound = flights.slice(1, 6)
        for (const f of inbound) expect(["SFO", "OAK", "SJC"]).toContain(f.destinationAirportId!)
    })
    test("BAY_AREA: a demo script's featured flight ID gets the featured aircraft", () => {
        const f001 = selectLiveFlights(candidates, BAY)[0]!
        const f004 = selectLiveFlights(candidates, { ...BAY, featuredFlightId: "F004" })
        expect(f004[3]!.callsign).toBe(f001.callsign)
    })
    test("BAY_AREA: no aircraft south of Monterey still lends real callsigns", () => {
        const north = candidates.filter(c => c.lat > 36.6)
        const flights = selectLiveFlights(north, BAY)
        expect(flights.length).toBe(north.length)
        expect(flights[0]!.lat).toBeGreaterThan(36.6)
    })
})

describe("run config and fallback", () => {
    test("US run: public attribution in the config, flights only in the seed", async () => {
        const out = await prepareLiveRun(US, fixed())
        expect(out.config.liveTraffic).toEqual({ source: "OpenSky Network", fetchedAtWallMs: 1_793_478_148_000 })
        RunConfigSchema.parse(out.config)
        expect(JSON.stringify(out.config)).not.toContain("icao24")
        expect(out.seed!.flights.length).toBeGreaterThan(10)
    })
    test("failure falls back to the seeded world with liveTraffic null", async () => {
        const out = await prepareLiveRun(US, failing)
        expect(out).toEqual({ config: { ...US, liveTraffic: null }, seed: null })
        const thrown = await prepareLiveRun(US, { states: () => Promise.reject(new Error("boom")) })
        expect(thrown.seed).toBeNull()
        expect(createWorld(out.config, opts, out.seed).flights[0]!.callsign).toBe("GHOST 001")
    })
    test("LEGACY drops a client liveTraffic and never fetches", async () => {
        let called = false
        const out = await prepareLiveRun({ flightCount: 3, seed: 1, speed: 10, liveTraffic: { source: "OpenSky Network", fetchedAtWallMs: 5 } }, { states: async () => ((called = true), null) })
        expect(called).toBe(false)
        expect(out).toEqual({ config: { flightCount: 3, seed: 1, speed: 10 }, seed: null })
    })
    test("BAY_AREA sets featuredFlightId F001 unless the demo script set one", async () => {
        expect((await prepareLiveRun(BAY, failing)).config.featuredFlightId).toBe("F001")
        expect((await prepareLiveRun({ ...BAY, featuredFlightId: "F004" }, failing)).config.featuredFlightId).toBe("F004")
        expect((await prepareLiveRun(US, failing)).config.featuredFlightId).toBeUndefined()
    })
})

describe("world generation with a live seed", () => {
    test("US: real callsign, projected position, destination; IDs, speed and fuel stay simulator values", async () => {
        const { config, seed } = await prepareLiveRun(US, fixed())
        const seeded = createWorld(config, opts)
        const live = createWorld(config, opts, seed)
        expect(live.flights.map(f => f.entityId)).toEqual(seeded.flights.map(f => f.entityId))
        live.flights.forEach((f, i) => {
            FlightStateSchema.parse(f)
            const src = seed!.flights[i]!
            expect(f.callsign).toBe(src.callsign)
            expect(f.originalDestination).toBe(src.destinationAirportId!)
            expect(f.position).toEqual(projectUs(src.lon, src.lat))
            expect(f.speedKnots).toBe(240)
            expect(f.fuelRemainingSec).toBe(seeded.flights[i]!.fuelRemainingSec)
        })
        expect(createWorld(config, opts, seed)).toEqual(live)
    })
    test("BAY_AREA: only callsigns change", async () => {
        const { config, seed } = await prepareLiveRun(BAY, fixed())
        const seeded = createWorld(config, opts)
        const live = createWorld(config, opts, seed)
        live.flights.forEach((f, i) => {
            expect({ ...f, callsign: "" }).toEqual({ ...seeded.flights[i]!, callsign: "" })
            expect(f.callsign).toBe(seed!.flights[i]!.callsign)
        })
    })
    test("continuous departures take the next unused callsign, then seeded ones", async () => {
        const { config, seed } = await prepareLiveRun({ ...US, continuousTraffic: true }, fixed())
        const next = createTrafficFlight(config, opts, 11, 100, seed)
        expect(next).toMatchObject({ flightId: "F011", entityId: "flight:F011", callsign: seed!.flights[10]!.callsign })
        expect(next.originAirportId).not.toBe(next.originalDestination)
        const beyond = createTrafficFlight(config, opts, seed!.flights.length + 1, 100, seed)
        expect(beyond.callsign).toBe(`GHOST ${String(seed!.flights.length + 1).padStart(3, "0")}`)
        expect(createTrafficFlight(config, opts, 11, 100)).toMatchObject({ callsign: "GHOST 011" })
    })
})

describe("SimulationActor keeps the seed server-side", () => {
    test("stored on the run, replayed by reset, dropped from the fenced run; retries ignore the fetch time", async () => {
        const { config, seed } = await prepareLiveRun(US, fixed())
        const created = createRun(emptyRoot(), "req-1", config, opts.runId, 1000, seed)
        expect(created.run.liveTrafficSeed).toEqual(seed!)
        const retry = await prepareLiveRun(US, fixed(1_793_478_200_000))
        expect(createRun(created.root, "req-1", retry.config, "7b2f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c", 2000, retry.seed).run).toBe(created.run)
        const reset = resetRun(created.root, opts.runId, "op-reset", "8c3f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c", 3000)
        expect(reset.run.liveTrafficSeed).toEqual(seed!)
        expect(reset.root.runs[opts.runId]!.liveTrafficSeed).toBeUndefined()
        expect(createRun(emptyRoot(), "req-2", US, opts.runId, 1000).run.liveTrafficSeed).toBeUndefined()
    })
})

describe("createOpenSkySource", () => {
    const body = JSON.stringify(sample)
    const withDir = async (fn: (dir: string) => Promise<void>) => {
        const dir = mkdtempSync(join(tmpdir(), "opensky-"))
        try {
            await fn(dir)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }
    const quiet = () => {}

    test("fetches once, then serves the .data cache inside the TTL", () =>
        withDir(async dir => {
            let calls = 0
            let t = 1_000_000
            const fetchImpl = (async () => ((calls++), new Response(body))) as unknown as typeof fetch
            const src = createOpenSkySource({ dataDir: dir, env: { OPENSKY_LIVE: "1" }, fetchImpl, now: () => t, log: quiet })
            expect((await src.states())!.candidates).toEqual(candidates)
            t += 60_000
            expect((await src.states())!.fetchedAtWallMs).toBe(1_000_000)
            expect(calls).toBe(1)
            t += 10 * 60_000
            await src.states()
            expect(calls).toBe(2)
        }))
    test("timeout or HTTP error: null without a cache, the stale cache when one is recent", () =>
        withDir(async dir => {
            const hang = ((_: unknown, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch
            const slow = createOpenSkySource({ dataDir: dir, env: { OPENSKY_LIVE: "1" }, fetchImpl: hang, timeoutMs: 20, log: quiet })
            expect(await slow.states()).toBeNull()
            let t = 5_000_000
            const ok = createOpenSkySource({ dataDir: dir, env: { OPENSKY_LIVE: "1" }, fetchImpl: (async () => new Response(body)) as unknown as typeof fetch, now: () => t, log: quiet })
            await ok.states()
            t += 30 * 60_000
            const limited = createOpenSkySource({ dataDir: dir, env: { OPENSKY_LIVE: "1" }, fetchImpl: (async () => new Response("", { status: 429 })) as unknown as typeof fetch, now: () => t, log: quiet })
            expect((await limited.states())!.fetchedAtWallMs).toBe(5_000_000)
            const strict = createOpenSkySource({ dataDir: dir, env: { OPENSKY_LIVE: "1", OPENSKY_STALE_MAX_MS: "0" }, fetchImpl: (async () => new Response("", { status: 429 })) as unknown as typeof fetch, now: () => t, log: quiet })
            expect(await strict.states()).toBeNull()
        }))
    test("disabled under bun test and with OPENSKY_LIVE=0", async () => {
        const fetchImpl = (async () => {
            throw new Error("must not fetch")
        }) as unknown as typeof fetch
        expect(await createOpenSkySource({ dataDir: "/nonexistent", env: { NODE_ENV: "test" }, fetchImpl, log: quiet }).states()).toBeNull()
        expect(await createOpenSkySource({ dataDir: "/nonexistent", env: { OPENSKY_LIVE: "0" }, fetchImpl, log: quiet }).states()).toBeNull()
    })
})
