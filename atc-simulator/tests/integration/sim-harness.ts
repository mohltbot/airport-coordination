// In-process stand-ins for SimulationActor, AirportActor and FlightActor that run the
// real domain transitions (flight.ts) behind the same method shapes the worker calls.
// They exercise the clock saga, fencing and recovery logic without a Terse runtime;
// the real-actor path is covered once the generated clients land (see report).
import type {
    AirportId,
    AirportState,
    ClearanceCheck,
    ClearanceCheckResult,
    DomainResult,
    EntityId,
    FlightState,
    MutationContext,
    PendingTick,
    Tick,
    TouchdownInput,
    TouchdownReceipt,
    WorkerLease,
} from "../../packages/domain/src/contracts.ts"
import { LANDING_GRACE_SEC, RUNWAY_OCCUPANCY_SEC, WORKER_LEASE_MS } from "../../packages/domain/src/constants.ts"
import { advanceFlight, applyApproachGuard, checkFence, recordFlightTouchdown } from "../../packages/domain/src/flight.ts"
import type { AirportSimApi, FlightSimApi, SimulationClockApi } from "../../server/src/simulation/clock.ts"
import type { EntityWorkApi, OutboxAttempt, WorkerRepository } from "../../server/src/simulation/worker.ts"

export const RUN_A = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"
export const RUN_B = "7b2e1d3f-6c8e-4f9b-8d4a-3e5c7f9a1b2d"

export class Faults {
    private armed = new Map<string, number>()
    arm(point: string, times = 1) {
        this.armed.set(point, times)
    }
    hit(point: string) {
        const n = this.armed.get(point) ?? 0
        if (n > 0) {
            this.armed.set(point, n - 1)
            throw new Error(`injected crash at ${point}`)
        }
    }
}

const clone = <T>(v: T): T => structuredClone(v)
const rejected = (code: string, stateRevision = 0): DomainResult => ({ outcome: "REJECTED", code, stateRevision })

export class MemSimulation implements SimulationClockApi {
    phase: "RUNNING" | "PAUSED" = "RUNNING"
    simNowSec = 0
    tickCounter = 0
    pendingTick: PendingTick | null = null
    epoch = 0
    lease: WorkerLease | null = null
    completed: string[] = []
    constructor(
        public runId: string,
        public entityIds: EntityId[],
        public speed: 1 | 5 | 10,
        readonly faults: Faults,
        readonly now: () => number,
        readonly leaseMs = WORKER_LEASE_MS,
    ) {}

    private check(lease: WorkerLease) {
        if (lease.runId !== this.runId) throw new Error("WRONG_RUN: run was reset")
        if (!this.lease || lease.epoch !== this.lease.epoch || lease.token !== this.lease.token) throw new Error("INVALID_LEASE: stale epoch")
        if (this.now() > this.lease.expiresAtWallMs) throw new Error("INVALID_LEASE: expired lease")
    }
    async claimWorker(ownerId: string, nowWallMs: number) {
        if (this.lease && this.lease.expiresAtWallMs > this.now() && this.lease.ownerId !== ownerId) throw new Error("lease held by another worker")
        this.epoch += 1
        this.lease = { runId: this.runId, ownerId, epoch: this.epoch, token: `tok-${this.epoch}`, expiresAtWallMs: nowWallMs + this.leaseMs }
        return clone(this.lease)
    }
    async renewWorker(lease: WorkerLease) {
        this.check(lease)
        this.lease = { ...this.lease!, expiresAtWallMs: this.now() + this.leaseMs }
        return clone(this.lease)
    }
    async beginTick(lease: WorkerLease) {
        this.check(lease)
        if (this.pendingTick) return clone(this.pendingTick)
        if (this.phase !== "RUNNING") return null
        this.tickCounter += 1
        this.pendingTick = {
            tickId: `${this.runId.slice(0, 8)}-t${this.tickCounter}`,
            fromSimSec: this.simNowSec,
            toSimSec: this.simNowSec + 0.25 * this.speed,
            entityIds: [...this.entityIds],
            acknowledgedEntityIds: [],
        }
        return clone(this.pendingTick)
    }
    async ackTickEntity(lease: WorkerLease, tickId: string, entityId: EntityId) {
        this.faults.hit(`ack:${entityId}`)
        this.check(lease)
        if (this.pendingTick?.tickId !== tickId) return
        if (!this.pendingTick.acknowledgedEntityIds.includes(entityId)) this.pendingTick.acknowledgedEntityIds.push(entityId)
    }
    async completeTick(lease: WorkerLease, tickId: string) {
        this.faults.hit("complete")
        this.check(lease)
        const t = this.pendingTick
        if (!t || t.tickId !== tickId) return
        const missing = t.entityIds.filter(e => !t.acknowledgedEntityIds.includes(e))
        if (missing.length) throw new Error(`tick ${tickId} missing acks: ${missing.join(",")}`)
        this.simNowSec = t.toSimSec
        this.completed.push(tickId)
        this.pendingTick = null
    }
}

const noWork = {
    async receive(): Promise<DomainResult> {
        return rejected("UNAUTHORIZED")
    },
    async claimWork() {
        return null
    },
    async commitDecision(): Promise<DomainResult> {
        return rejected("STALE_STATE")
    },
    async markTransportAccepted(_ctx: MutationContext, _a: OutboxAttempt) {},
}

export type MemAirportState = Pick<AirportState, "runId" | "entityId" | "airportId" | "touchdowns" | "jobs" | "outbox" | "fencing" | "lastTickId"> & {
    closed: boolean
    clearances: Record<string, { reservationId: string; flightId: string; slotStartSimSec: number; runwayId: "R1" | "R2" }>
}

export class MemAirport implements AirportSimApi, EntityWorkApi {
    advances = 0
    receive = noWork.receive
    claimWork = noWork.claimWork
    commitDecision = noWork.commitDecision
    markTransportAccepted = noWork.markTransportAccepted
    constructor(
        public state: MemAirportState,
        readonly faults: Faults,
    ) {}
    async read() {
        return clone(this.state) as unknown as AirportState
    }
    async advance(ctx: MutationContext, tick: Tick): Promise<DomainResult> {
        const fenced = checkFence(this.state, ctx)
        if (fenced.code) return rejected(fenced.code)
        this.state = fenced.state
        if (this.state.lastTickId === tick.tickId) return { outcome: "DUPLICATE", code: "OK", stateRevision: 0, original: { outcome: "APPLIED", code: "OK", stateRevision: 0 } }
        this.advances += 1
        this.state = { ...this.state, lastTickId: tick.tickId }
        return { outcome: "APPLIED", code: "OK", stateRevision: 0 }
    }
    async validateClearance(ctx: MutationContext, check: ClearanceCheck): Promise<ClearanceCheckResult> {
        const c = this.state.clearances[check.clearanceId]
        const valid = !this.state.closed && c !== undefined && c.reservationId === check.reservationId && c.flightId === check.flightId
        return { valid, reason: valid ? "OK" : this.state.closed ? "CLOSED" : "STALE_STATE", reservationId: check.reservationId, clearanceId: check.clearanceId }
    }
    async recordTouchdown(ctx: MutationContext, input: TouchdownInput): Promise<TouchdownReceipt> {
        const fenced = checkFence(this.state, ctx)
        if (fenced.code) throw new Error(fenced.code)
        const existing = Object.values(this.state.touchdowns).find(r => r.reservationId === input.reservationId)
        if (existing) return clone(existing)
        if (this.state.closed) throw new Error("CLOSED: arrivals closed")
        const c = this.state.clearances[input.clearanceId]
        if (!c || c.flightId !== input.flightId) throw new Error("STALE_STATE: unknown clearance")
        if (ctx.simNowSec < c.slotStartSimSec || ctx.simNowSec > c.slotStartSimSec + LANDING_GRACE_SEC) throw new Error("OFFER_EXPIRED: outside landing window")
        const receipt: TouchdownReceipt = {
            receiptId: `rcpt-${input.reservationId}`,
            runId: this.state.runId,
            flightId: input.flightId,
            airportId: this.state.airportId,
            runwayId: c.runwayId,
            reservationId: input.reservationId,
            clearanceId: input.clearanceId,
            touchdownAtSimSec: ctx.simNowSec,
            occupiedUntilSimSec: ctx.simNowSec + RUNWAY_OCCUPANCY_SEC,
        }
        this.state = { ...this.state, touchdowns: { ...this.state.touchdowns, [ctx.operationId]: receipt } }
        this.faults.hit(`after-airport-touchdown:${input.flightId}`)
        return clone(receipt)
    }
}

export class MemFlight implements FlightSimApi, EntityWorkApi {
    receive = noWork.receive
    claimWork = noWork.claimWork
    commitDecision = noWork.commitDecision
    markTransportAccepted = noWork.markTransportAccepted
    constructor(
        public state: FlightState,
        readonly faults: Faults,
    ) {}
    async read() {
        return clone(this.state)
    }
    private fence(ctx: MutationContext): string | null {
        const f = checkFence(this.state, ctx)
        if (f.code) return f.code
        this.state = f.state
        return null
    }
    async advance(ctx: MutationContext, tick: Tick) {
        const code = this.fence(ctx)
        if (code) return rejected(code, this.state.stateRevision)
        const t = advanceFlight(this.state, tick, ctx)
        this.state = t.state
        this.faults.hit(`after-advance:${this.state.flightId}`)
        return t.result
    }
    async applyApproachGuard(ctx: MutationContext, result: ClearanceCheckResult) {
        const code = this.fence(ctx)
        if (code) return rejected(code, this.state.stateRevision)
        const t = applyApproachGuard(this.state, result, ctx)
        this.state = t.state
        return t.result
    }
    async recordTouchdown(ctx: MutationContext, receipt: TouchdownReceipt) {
        this.faults.hit(`flight-touchdown:${this.state.flightId}`)
        const code = this.fence(ctx)
        if (code) return rejected(code, this.state.stateRevision)
        const t = recordFlightTouchdown(this.state, receipt, ctx)
        this.state = t.state
        return t.result
    }
}

export function memFlight(runId: string, flightId: string, overrides: Partial<FlightState> = {}): FlightState {
    return {
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
        initializedByOperationId: "init",
        entityId: `flight:${flightId}`,
        flightId,
        callsign: `GHOST ${flightId.slice(1)}`,
        originalDestination: "ALP",
        position: { x: 90, y: 50 },
        headingDeg: 270,
        speedKnots: 240,
        fuelRemainingSec: 3600,
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
        ...overrides,
    }
}

export function memAirport(runId: string, airportId: AirportId): MemAirportState {
    return {
        runId,
        entityId: `airport:${airportId}`,
        airportId,
        touchdowns: {},
        jobs: {},
        outbox: [],
        fencing: { workerEpoch: 0, leaseToken: null },
        lastTickId: null,
        closed: false,
        clearances: {},
    }
}

export type World = {
    faults: Faults
    sim: MemSimulation
    airports: Map<string, MemAirport>
    flights: Map<string, MemFlight>
    repo: WorkerRepository
    clock: { now: number }
}

// Alpha plus a cleared flight holding 6 NM east, slot at 300, and a second flight en route.
export function makeWorld(runId = RUN_A, opts: { speed?: 1 | 5 | 10; leaseMs?: number } = {}): World {
    const faults = new Faults()
    const clock = { now: 1_000_000 }
    const airports = new Map<string, MemAirport>()
    for (const id of ["ALP", "BRV", "CHR"] as const) airports.set(id, new MemAirport(memAirport(runId, id), faults))
    airports.get("ALP")!.state.clearances["clr-1"] = { reservationId: "res-1", flightId: "F001", slotStartSimSec: 300, runwayId: "R1" }
    const flights = new Map<string, MemFlight>()
    flights.set(
        "F001",
        new MemFlight(
            memFlight(runId, "F001", {
                position: { x: 56, y: 50 },
                phase: "HOLDING",
                holdCenter: { x: 50, y: 50 },
                holdAngle: 0,
                activeAssignment: { airportId: "ALP", runwayId: "R1", reservationId: "res-1", slotStartSimSec: 300, occupancySec: 60, clearanceId: "clr-1" },
            }),
            faults,
        ),
    )
    flights.set("F002", new MemFlight(memFlight(runId, "F002", { originalDestination: "CHR", position: { x: 170, y: 90 } }), faults))
    const entityIds: EntityId[] = ["airport:ALP", "airport:BRV", "airport:CHR", "flight:F001", "flight:F002"]
    const sim = new MemSimulation(runId, entityIds, opts.speed ?? 10, faults, () => clock.now, opts.leaseMs)
    const repo: WorkerRepository = {
        simulation: sim,
        airport: (r, id) => {
            if (r !== sim.runId) throw new Error(`WRONG_RUN: ${r}`)
            return airports.get(id)!
        },
        flight: (r, id) => {
            if (r !== sim.runId) throw new Error(`WRONG_RUN: ${r}`)
            return flights.get(id)!
        },
        entities: async () => [...sim.entityIds, "controller"],
    }
    return { faults, sim, airports, flights, repo, clock }
}

// Drive ticks until simulated time reaches `untilSimSec`, swallowing injected crashes.
export async function driveTicks(
    run: () => Promise<unknown>,
    sim: MemSimulation,
    untilSimSec: number,
    maxTicks = 10_000,
): Promise<{ errors: string[] }> {
    const errors: string[] = []
    for (let i = 0; i < maxTicks && sim.simNowSec < untilSimSec - 1e-9; i++) {
        try {
            await run()
        } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err))
        }
    }
    return { errors }
}
