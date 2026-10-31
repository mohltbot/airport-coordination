// Task 2: durable run registry and entity actors on the real local Terse runtime.
// Needs `bun run actors:dev` (port 7100) and `bun run actors:generate`.
// Each test uses its own SimulationActor ID, so it never touches the demo registry ("ghost-tower").
//   bun run test:integration -- --filter=actors
import { beforeAll, describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { entityActorId, type MutationContext } from "../../packages/domain/src/contracts.ts"
import { createWorld } from "../../packages/domain/src/world.ts"
import { initializeRun, type InitDeps } from "../../server/src/simulation/initialize.ts"

const ROOT = resolve(import.meta.dir, "../..")
process.env.TERSE_ACTOR_URL ??= "http://127.0.0.1:7100/v1/projects/local/actors"
let actors: any

beforeAll(async () => {
    actors = (await import(join(ROOT, "server/generated/index.js"))).actors
})

const config = { flightCount: 5, seed: 20261031, speed: 10 as const }
const op = () => crypto.randomUUID()

function deps(sim: any, calls?: string[]): InitDeps {
    return {
        sim,
        airport: id => ({ initialize: (c, s) => (calls?.push(id), actors.AirportActor.get(id).initialize(c, s)) }),
        flight: id => ({ initialize: (c, s) => (calls?.push(id), actors.FlightActor.get(id).initialize(c, s)) }),
    }
}

async function startedRun(flightCount = config.flightCount) {
    const sim = actors.SimulationActor.get(`test-${crypto.randomUUID()}`)
    const run = await sim.createRun(op(), { ...config, flightCount })
    await sim.setRunPhase(run.runId, "STARTING", op())
    return { sim, runId: run.runId as string }
}

const ctx = (runId: string, workerEpoch: number, leaseToken: string, operationId = op()): MutationContext => ({
    runId,
    workerEpoch,
    leaseToken,
    simNowSec: 0,
    wallNowMs: Date.now(),
    operationId,
})

describe("actors", () => {
    test("createRun is idempotent per request ID and configuring again edits the same run", async () => {
        const sim = actors.SimulationActor.get(`test-${crypto.randomUUID()}`)
        const req = op()
        const a = await sim.createRun(req, config)
        expect(await sim.createRun(req, config)).toEqual(a)
        const b = await sim.createRun(op(), { ...config, flightCount: 7 })
        expect(b.runId).toBe(a.runId)
        expect(b.config.flightCount).toBe(7)
        expect((await sim.readRun(a.runId)).entities).toHaveLength(1 + 3 + 7)
        await expect(sim.createRun(req, { ...config, flightCount: 9 })).rejects.toThrow(/REVISION_CONFLICT/)
    }, 30_000)

    test("initialize twice leaves exactly N flights and three airports", async () => {
        const { sim, runId } = await startedRun()
        const first = await initializeRun(deps(sim), runId)
        expect(first.steps).toEqual(["WORLD_CREATED", "AIRPORTS_INITIALIZED", "FLIGHTS_INITIALIZED", "READY"])
        expect(first.results.every(r => r.outcome === "APPLIED")).toBe(true)
        // A second full pass straight against the actors returns DUPLICATE everywhere.
        const world = createWorld(config, { runId, operationId: "again" })
        const c = ctx(runId, 0, `init-${runId}`)
        for (const a of world.airports) expect((await actors.AirportActor.get(entityActorId(runId, a.entityId)).initialize(c, a)).outcome).toBe("DUPLICATE")
        for (const f of world.flights) expect((await actors.FlightActor.get(entityActorId(runId, f.entityId)).initialize(c, f)).outcome).toBe("DUPLICATE")
        const airports = await Promise.all(["ALP", "BRV", "CHR"].map(id => actors.AirportActor.get(`${runId}.airport.${id}`).read()))
        expect(airports.every(a => a !== null && a.stateRevision === 1)).toBe(true)
        const flights = await Promise.all([1, 2, 3, 4, 5, 6].map(i => actors.FlightActor.get(`${runId}.flight.F00${i}`).read()))
        expect(flights.filter(f => f !== null)).toHaveLength(5)
        expect(flights[5]).toBeNull()
        expect((await sim.setRunPhase(runId, "PAUSED", op())).phase).toBe("PAUSED")
    }, 60_000)

    test("a crashed initializer resumes from its recorded steps", async () => {
        const { sim, runId } = await startedRun(3)
        // Crash after airports were initialized and the step recorded, before any flight.
        const crashing: InitDeps = {
            ...deps(sim),
            flight: () => ({
                initialize: async () => {
                    throw new Error("worker crashed")
                },
            }),
        }
        await expect(initializeRun(crashing, runId)).rejects.toThrow("worker crashed")
        expect((await sim.readRun(runId)).initialization.steps).toEqual(["WORLD_CREATED", "AIRPORTS_INITIALIZED"])
        await expect(sim.setRunPhase(runId, "RUNNING", op())).rejects.toThrow(/WRONG_PHASE/)
        const calls: string[] = []
        const resumed = await initializeRun(deps(sim, calls), runId)
        expect(calls.every(id => id.includes(".flight."))).toBe(true)
        expect(calls).toHaveLength(3)
        expect(resumed.steps.at(-1)).toBe("READY")
        expect((await sim.setRunPhase(runId, "RUNNING", op())).phase).toBe("RUNNING")
    }, 60_000)

    test("stale worker epochs are rejected by the registry and by entity actors", async () => {
        const { sim, runId } = await startedRun(1)
        await initializeRun(deps(sim), runId)
        await sim.setRunPhase(runId, "RUNNING", op())
        const lease = await sim.claimWorker("worker-a", Date.now())
        expect(lease.epoch).toBe(1)
        await expect(sim.claimWorker("worker-b", Date.now())).rejects.toThrow(/INVALID_LEASE/)
        await expect(sim.renewWorker({ ...lease, token: "forged" })).rejects.toThrow(/INVALID_LEASE/)
        const tick = await sim.beginTick(lease)
        expect(await sim.beginTick(lease)).toEqual(tick) // retry returns the same pending tick
        const airport = actors.AirportActor.get(`${runId}.airport.ALP`)
        expect((await airport.advance(ctx(runId, 1, lease.token), tick)).outcome).toBe("APPLIED")
        expect((await airport.advance(ctx(runId, 1, lease.token), tick)).outcome).toBe("DUPLICATE")
        // A newer epoch is adopted; the older one is then rejected for good.
        const next = { tickId: `${runId}:x`, fromSimSec: tick.toSimSec, toSimSec: tick.toSimSec + 2.5 }
        expect((await airport.advance(ctx(runId, 2, "token-2"), next)).outcome).toBe("APPLIED")
        const stale = await airport.advance(ctx(runId, 1, lease.token), { ...next, tickId: `${runId}:y`, toSimSec: next.toSimSec + 2.5 })
        expect(stale).toMatchObject({ outcome: "REJECTED", code: "INVALID_LEASE" })
        const sameEpochOtherToken = await airport.advance(ctx(runId, 2, "other"), { ...next, tickId: `${runId}:z`, toSimSec: next.toSimSec + 5 })
        expect(sameEpochOtherToken).toMatchObject({ outcome: "REJECTED", code: "INVALID_LEASE" })
    }, 60_000)

    test("reset creates a new run; old-run operations cannot touch it", async () => {
        const { sim, runId } = await startedRun(2)
        await initializeRun(deps(sim), runId)
        const resetOp = op()
        const fresh = await sim.resetRun(runId, resetOp)
        expect(fresh.runId).not.toBe(runId)
        expect(fresh.phase).toBe("CONFIGURING")
        expect(await sim.resetRun(runId, resetOp)).toEqual(fresh) // the same reset retried
        expect((await sim.getRun(runId)).phase).toBe("RESETTING") // old run kept for inspection
        await expect(sim.setRunPhase(runId, "RUNNING", op())).rejects.toThrow(/WRONG_RUN/)
        await expect(sim.claimWorker("w", Date.now())).resolves.toMatchObject({ runId: fresh.runId })
        await sim.setRunPhase(fresh.runId, "STARTING", op()).catch(() => null)
        // Initialize the new run, then hit its actor with the old run's context.
        await sim.setRunPhase(fresh.runId, "STARTING", op()).catch(() => null)
        await initializeRun(deps(sim), fresh.runId)
        const newAirport = actors.AirportActor.get(`${fresh.runId}.airport.ALP`)
        const before = await newAirport.read()
        const oldCtx = ctx(runId, 0, `init-${runId}`)
        expect(await newAirport.advance(oldCtx, { tickId: "old", fromSimSec: 0, toSimSec: 2.5 })).toMatchObject({ outcome: "REJECTED", code: "WRONG_RUN" })
        expect(await newAirport.read()).toEqual(before)
        const oldAirport = await actors.AirportActor.get(`${runId}.airport.ALP`).read()
        expect(oldAirport.runId).toBe(runId)
    }, 60_000)
})
