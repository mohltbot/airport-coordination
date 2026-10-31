// Worker crashes at every tick phase, between the two touchdown writes, after a
// restart with wall time elapsed, and across a run reset (review focus case 4).
import { describe, expect, test } from "bun:test"
import { chooseValidAction } from "../../packages/domain/src/policy.ts"
import { RulesModelAdapter } from "../../server/src/agents/model.ts"
import { runTick } from "../../server/src/simulation/clock.ts"
import { reconcileLandings } from "../../server/src/simulation/landing.ts"
import { SimulationWorker } from "../../server/src/simulation/worker.ts"
import { RUN_A, RUN_B, driveTicks, makeWorld, type World } from "./sim-harness.ts"

const fuel = (w: World, id: string) => w.flights.get(id)!.state.fuelRemainingSec

async function crashOnceThenResume(point: string) {
    const w = makeWorld()
    const lease = await w.sim.claimWorker("w1", w.clock.now)
    await runTick(w.repo, lease) // t = 2.5
    const fuelBefore = fuel(w, "F002")
    w.faults.arm(point)
    await expect(runTick(w.repo, lease)).rejects.toThrow(/injected crash/)
    const pending = w.sim.pendingTick
    expect(pending).not.toBeNull()
    // The worker dies; a new one claims after the old lease expires and resumes.
    w.clock.now += 11_000
    const next = await w.sim.claimWorker("w2", w.clock.now)
    const out = await runTick(w.repo, next)
    expect(out!.tick.tickId).toBe(pending!.tickId)
    expect(w.sim.simNowSec).toBe(5)
    // One tick of 2.5 s burned exactly once.
    expect(fuel(w, "F002")).toBeCloseTo(fuelBefore - 2.5, 9)
    return w
}

describe("restart during a tick", () => {
    test.each([
        ["after airports advanced, before acking the first flight", "ack:flight:F001"],
        ["after a flight advanced, before its ack", "after-advance:F002"],
        ["after every entity acked, before completeTick", "complete"],
        ["after the first airport ack", "ack:airport:ALP"],
    ])("%s: the same tick ID resumes and nothing moves twice", async (_label, point) => {
        await crashOnceThenResume(point)
    })

    test("no wall-clock catch-up: a minute offline still advances one tick", async () => {
        const w = makeWorld()
        const lease = await w.sim.claimWorker("w1", w.clock.now)
        await runTick(w.repo, lease)
        w.clock.now += 60_000
        const next = await w.sim.claimWorker("w2", w.clock.now)
        await runTick(w.repo, next)
        expect(w.sim.simNowSec).toBe(5)
    })
})

describe("restart between airport and flight touchdown writes", () => {
    test("recovery lands the flight from the airport receipt, even after a later closure", async () => {
        const w = makeWorld()
        const lease = await w.sim.claimWorker("w1", w.clock.now)
        await driveTicks(() => runTick(w.repo, lease), w.sim, 297.5)
        w.faults.arm("flight-touchdown:F001")
        const { errors } = await driveTicks(() => runTick(w.repo, lease), w.sim, 300.1, 1)
        expect(errors.join()).toMatch(/injected crash at flight-touchdown/)
        expect(Object.keys(w.airports.get("ALP")!.state.touchdowns)).toHaveLength(1)
        expect(w.flights.get("F001")!.state.phase).toBe("APPROACH")

        // Weather closes Alpha while the worker is down.
        w.airports.get("ALP")!.state.closed = true
        w.clock.now += 11_000
        const next = await w.sim.claimWorker("w2", w.clock.now)
        const ctx = { runId: next.runId, workerEpoch: next.epoch, leaseToken: next.token, simNowSec: w.sim.simNowSec, wallNowMs: w.clock.now, operationId: "recover" }
        const recovered = await reconcileLandings(w.repo, ctx, ["ALP", "BRV", "CHR"])
        expect(recovered.map(r => r.receiptId)).toEqual(["rcpt-res-1"])
        expect(w.flights.get("F001")!.state.phase).toBe("LANDED")
        // Resuming the pending tick does not undo or repeat the landing.
        await driveTicks(() => runTick(w.repo, next), w.sim, 320)
        expect(w.flights.get("F001")!.state.phase).toBe("LANDED")
        expect(Object.keys(w.airports.get("ALP")!.state.touchdowns)).toHaveLength(1)
        expect(await reconcileLandings(w.repo, ctx, ["ALP"])).toEqual([])
    })

    test("crash after the airport write inside the same tick: resuming the tick completes the landing once", async () => {
        const w = makeWorld()
        const lease = await w.sim.claimWorker("w1", w.clock.now)
        await driveTicks(() => runTick(w.repo, lease), w.sim, 297.5)
        w.faults.arm("after-airport-touchdown:F001")
        await expect(runTick(w.repo, lease)).rejects.toThrow(/injected crash/)
        w.clock.now += 11_000
        const next = await w.sim.claimWorker("w2", w.clock.now)
        await runTick(w.repo, next)
        expect(w.flights.get("F001")!.state.phase).toBe("LANDED")
        expect(Object.keys(w.airports.get("ALP")!.state.touchdowns)).toHaveLength(1)
    })
})

describe("run reset isolation", () => {
    test("old-run ticks and contexts never mutate the new run", async () => {
        const w = makeWorld(RUN_A)
        const oldLease = await w.sim.claimWorker("w1", w.clock.now)
        await runTick(w.repo, oldLease)

        // Reset: the registry fences RUN_A; RUN_B gets fresh entity actors.
        const b = makeWorld(RUN_B)
        const newLease = await b.sim.claimWorker("w1", b.clock.now)
        await runTick(b.repo, newLease)
        const fuelB = fuel(b, "F002")

        // An old-run lease against the new run's registry is refused.
        await expect(runTick(b.repo, oldLease)).rejects.toThrow(/WRONG_RUN|INVALID_LEASE/)
        // An old-run context delivered straight to a new-run entity is refused by the entity.
        const rogue = { tickId: "old-run-tick", fromSimSec: 0, toSimSec: 500 }
        const r = await b.flights.get("F002")!.advance(
            { runId: RUN_A, workerEpoch: 99, leaseToken: "tok-99", simNowSec: 500, wallNowMs: b.clock.now, operationId: "old" },
            rogue,
        )
        expect(r.code).toBe("WRONG_RUN")
        expect(fuel(b, "F002")).toBe(fuelB)
        expect(b.sim.simNowSec).toBe(2.5)
    })

    test("a running worker whose run is reset leaves the old lease and claims the new run", async () => {
        const w = makeWorld(RUN_A)
        w.clock.now = Date.now()
        const worker = new SimulationWorker({
            repo: w.repo,
            model: new RulesModelAdapter(chooseValidAction),
            fallback: chooseValidAction,
            tickIntervalMs: 5,
            renewIntervalMs: 20,
            now: () => Date.now(),
        })
        await worker.start()
        while (w.sim.simNowSec < 10) await Bun.sleep(5)
        const runAFuel = fuel(w, "F002")

        // Reset in place: the registry now points at RUN_B with fresh entities.
        const b = makeWorld(RUN_B)
        w.sim.runId = RUN_B
        w.sim.lease = null
        w.sim.pendingTick = null
        w.sim.simNowSec = 0
        w.airports.clear()
        w.flights.clear()
        for (const [k, v] of b.airports) w.airports.set(k, v)
        for (const [k, v] of b.flights) w.flights.set(k, v)

        const until = Date.now() + 2_000
        while (Date.now() < until && worker.current().lease?.runId !== RUN_B) await Bun.sleep(10)
        while (Date.now() < until && w.sim.simNowSec < 5) await Bun.sleep(10)
        await worker.stop()
        expect(worker.current().lease?.runId ?? RUN_B).toBe(RUN_B)
        expect(w.sim.simNowSec).toBeGreaterThanOrEqual(5)
        // The new run's flight burned only new-run ticks.
        expect(b.flights.get("F002")!.state.fuelRemainingSec).toBeCloseTo(3600 - w.sim.simNowSec, 6)
        expect(b.flights.get("F002")!.state.runId).toBe(RUN_B)
        expect(runAFuel).toBeLessThan(3600)
    })
})
