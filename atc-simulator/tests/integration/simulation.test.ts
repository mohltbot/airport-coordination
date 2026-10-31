// Clock saga, approach guard and touchdown through runTick and the worker loop.
// Uses the in-process actor stand-ins in sim-harness.ts (real domain transitions).
import { describe, expect, test } from "bun:test"
import { chooseValidAction } from "../../packages/domain/src/policy.ts"
import { RulesModelAdapter } from "../../server/src/agents/model.ts"
import { runTick } from "../../server/src/simulation/clock.ts"
import { SimulationWorker, workerHealth } from "../../server/src/simulation/worker.ts"
import { driveTicks, makeWorld } from "./sim-harness.ts"

describe("simulation clock", () => {
    test("a cleared flight lands exactly once inside its window and stops burning fuel", async () => {
        const w = makeWorld()
        const lease = await w.sim.claimWorker("w1", w.clock.now)
        const touchdowns: string[] = []
        const { errors } = await driveTicks(
            async () => {
                const out = await runTick(w.repo, lease)
                for (const r of out?.touchdowns ?? []) touchdowns.push(r.receiptId)
            },
            w.sim,
            400,
        )
        expect(errors).toEqual([])
        const f = w.flights.get("F001")!.state
        expect(f.phase).toBe("LANDED")
        expect(touchdowns).toEqual(["rcpt-res-1"])
        expect(Object.keys(w.airports.get("ALP")!.state.touchdowns)).toHaveLength(1)
        const receipt = f.landingReceipt!
        expect(receipt.touchdownAtSimSec).toBeGreaterThanOrEqual(300)
        expect(receipt.touchdownAtSimSec).toBeLessThanOrEqual(330)
        // Fuel burned only while airborne.
        expect(f.fuelRemainingSec).toBeCloseTo(3600 - receipt.touchdownAtSimSec, 6)
        // Every entity saw every tick once.
        expect(w.airports.get("ALP")!.advances).toBe(w.sim.completed.length)
    })

    test("each tick advances at most 0.25 s x speed and pause stops time, fuel and movement", async () => {
        const w = makeWorld(undefined, { speed: 5 })
        const lease = await w.sim.claimWorker("w1", w.clock.now)
        await runTick(w.repo, lease)
        expect(w.sim.simNowSec).toBe(1.25)
        const before = structuredClone(w.flights.get("F002")!.state)
        w.sim.phase = "PAUSED"
        for (let i = 0; i < 10; i++) expect(await runTick(w.repo, lease)).toBeNull()
        const after = w.flights.get("F002")!.state
        expect(after.position).toEqual(before.position)
        expect(after.fuelRemainingSec).toBe(before.fuelRemainingSec)
        expect(w.sim.simNowSec).toBe(1.25)
        w.sim.phase = "RUNNING"
        await runTick(w.repo, lease)
        expect(w.flights.get("F002")!.state.fuelRemainingSec).toBeCloseTo(before.fuelRemainingSec - 1.25, 6)
    })

    test("closure after clearance: guard drops the clearance and no landing is recorded", async () => {
        const w = makeWorld()
        const lease = await w.sim.claimWorker("w1", w.clock.now)
        await driveTicks(() => runTick(w.repo, lease), w.sim, 250)
        expect(w.flights.get("F001")!.state.phase).toBe("APPROACH")
        w.airports.get("ALP")!.state.closed = true
        const out = await runTick(w.repo, lease)
        expect(out!.guardsFailed).toEqual(["F001"])
        await driveTicks(() => runTick(w.repo, lease), w.sim, 400)
        const f = w.flights.get("F001")!.state
        expect(f.phase).toBe("HOLDING")
        expect(f.activeAssignment).toBeNull()
        expect(f.outbox.map(e => e.envelope.type)).toEqual(["RESERVATION_RELEASE"])
        expect(Object.values(f.jobs).some(j => j.input.trigger === "CLEARANCE_INVALID" && j.status === "QUEUED")).toBe(true)
        expect(Object.keys(w.airports.get("ALP")!.state.touchdowns)).toHaveLength(0)
    })

    test("a closed runway at touchdown time refuses the landing and forces renegotiation", async () => {
        const w = makeWorld()
        const lease = await w.sim.claimWorker("w1", w.clock.now)
        await driveTicks(() => runTick(w.repo, lease), w.sim, 297.5)
        // Clearance stays valid on the guard check but the airport refuses the touchdown.
        const airport = w.airports.get("ALP")!
        const original = airport.recordTouchdown.bind(airport)
        airport.recordTouchdown = async () => {
            throw new Error("CLOSED: runway R1 closed")
        }
        await driveTicks(() => runTick(w.repo, lease), w.sim, 310)
        airport.recordTouchdown = original
        const f = w.flights.get("F001")!.state
        expect(f.phase).not.toBe("LANDED")
        expect(f.activeAssignment).toBeNull()
        expect(Object.keys(airport.state.touchdowns)).toHaveLength(0)
    })

    test("an older worker epoch cannot advance the run after a newer worker claims it", async () => {
        const w = makeWorld()
        const old = await w.sim.claimWorker("w1", w.clock.now)
        await runTick(w.repo, old)
        w.clock.now += 11_000 // old lease expires
        const fresh = await w.sim.claimWorker("w2", w.clock.now)
        await runTick(w.repo, fresh)
        const fuel = w.flights.get("F002")!.state.fuelRemainingSec
        await expect(runTick(w.repo, old)).rejects.toThrow(/INVALID_LEASE/)
        // Even a direct entity call with the old epoch is refused by the entity fence.
        const tick = { tickId: "rogue", fromSimSec: w.sim.simNowSec, toSimSec: w.sim.simNowSec + 100 }
        const r = await w.flights.get("F002")!.advance(
            { runId: old.runId, workerEpoch: old.epoch, leaseToken: old.token, simNowSec: tick.toSimSec, wallNowMs: w.clock.now, operationId: "rogue" },
            tick,
        )
        expect(r.code).toBe("INVALID_LEASE")
        expect(w.flights.get("F002")!.state.fuelRemainingSec).toBe(fuel)
    })
})

describe("worker process", () => {
    test("runs ticks on its interval, reports health, and stops cleanly", async () => {
        const w = makeWorld()
        w.clock.now = Date.now()
        const statuses: string[] = []
        let published = 0
        const worker = new SimulationWorker({
            repo: w.repo,
            model: new RulesModelAdapter(chooseValidAction),
            fallback: chooseValidAction,
            tickIntervalMs: 5,
            renewIntervalMs: 50,
            now: () => Date.now(),
            publish: async () => void published++,
            onStatus: s => statuses.push(s.state),
        })
        await worker.start()
        const until = Date.now() + 3_000
        while (Date.now() < until && w.flights.get("F001")!.state.phase !== "LANDED") await Bun.sleep(20)
        await worker.stop()
        expect(w.flights.get("F001")!.state.phase).toBe("LANDED")
        expect(statuses).toContain("RECOVERING")
        expect(statuses).toContain("RUNNING")
        expect(published).toBeGreaterThan(0)
        expect(workerHealth(worker.current()).status).toBe("UNAVAILABLE")
    })
})
