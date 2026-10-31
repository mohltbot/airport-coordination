// Fenced, resumable simulation ticks (design §4 clock behavior, plan Task 8).
//
// One tick is a saga persisted in SimulationActor.pendingTick:
//   beginTick -> advance airports -> advance flights -> approach guard and touchdown
//   -> completeTick -> publish projection.
// Every entity applies a tick ID once (advanceFlight compares lastTickId and
// lastAdvancedSimSec), so a worker that dies anywhere in the saga retries the
// exact pending tick on restart and nothing moves or burns fuel twice. There is
// no wall-clock catch-up: beginTick advances at most 0.25 s x speed per tick.
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
} from "@ghost-tower/domain/contracts"
import { touchdownReady } from "../../../packages/domain/src/flight.ts"
import { attemptTouchdown } from "./landing.ts"

// ------------------------------------------------------------ actor surface used here
// Structural slices of the generated Terse clients (plan §3 public actor APIs).

export interface SimulationClockApi {
    claimWorker(ownerId: string, nowWallMs: number): Promise<WorkerLease>
    renewWorker(lease: WorkerLease): Promise<WorkerLease>
    beginTick(lease: WorkerLease): Promise<PendingTick | null>
    ackTickEntity(lease: WorkerLease, tickId: string, entityId: EntityId): Promise<void>
    completeTick(lease: WorkerLease, tickId: string): Promise<void>
}

export interface AirportSimApi {
    read(): Promise<AirportState>
    advance(context: MutationContext, tick: Tick): Promise<DomainResult>
    validateClearance(context: MutationContext, input: ClearanceCheck): Promise<ClearanceCheckResult>
    recordTouchdown(context: MutationContext, input: TouchdownInput): Promise<TouchdownReceipt>
}

export interface FlightSimApi {
    read(): Promise<FlightState>
    advance(context: MutationContext, tick: Tick): Promise<DomainResult>
    applyApproachGuard(context: MutationContext, result: ClearanceCheckResult): Promise<DomainResult>
    recordTouchdown(context: MutationContext, receipt: TouchdownReceipt): Promise<DomainResult>
}

export interface SimulationRepository {
    simulation: SimulationClockApi
    airport(runId: string, airportId: AirportId): AirportSimApi
    flight(runId: string, flightId: string): FlightSimApi
}

export type TickOutcome = {
    tick: PendingTick
    airports: AirportState[]
    flights: FlightState[]
    touchdowns: TouchdownReceipt[]
    guardsFailed: string[]
}

// Codes that mean "this entity has already taken this tick" or "this tick does not
// apply to it": safe to acknowledge. Anything else leaves the tick pending.
const ACKABLE = new Set(["OK", "STALE_STATE", "ALREADY_TERMINAL"])

export class FencedError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message)
    }
}

export function tickContext(lease: WorkerLease, tick: Tick, operationId: string, wallNowMs = Date.now()): MutationContext {
    return {
        runId: lease.runId,
        workerEpoch: lease.epoch,
        leaseToken: lease.token,
        simNowSec: tick.toSimSec,
        wallNowMs,
        operationId: operationId.slice(0, 128),
    }
}

function parseEntity(entityId: EntityId): { kind: "airport"; id: AirportId } | { kind: "flight"; id: string } | null {
    if (entityId.startsWith("airport:")) return { kind: "airport", id: entityId.slice(8) as AirportId }
    if (entityId.startsWith("flight:")) return { kind: "flight", id: entityId.slice(7) }
    return null
}

async function advanceEntity(repo: SimulationRepository, lease: WorkerLease, tick: PendingTick, entityId: EntityId): Promise<void> {
    const parsed = parseEntity(entityId)
    if (!parsed) return
    const ctx = tickContext(lease, tick, `${tick.tickId}:${entityId}`)
    const actor = parsed.kind === "airport" ? repo.airport(lease.runId, parsed.id) : repo.flight(lease.runId, parsed.id)
    const result = await actor.advance(ctx, tick)
    const code = result.outcome === "DUPLICATE" ? result.original.code : result.code
    if (result.outcome === "REJECTED" && !ACKABLE.has(code)) {
        // INVALID_LEASE / WRONG_RUN: a newer worker or a new run owns this entity.
        throw new FencedError(code, `${entityId} rejected tick ${tick.tickId}: ${code}`)
    }
    await repo.simulation.ackTickEntity(lease, tick.tickId, entityId)
}

// Run (or resume) one tick. Returns null when the run is not RUNNING.
export async function runTick(repo: SimulationRepository, lease: WorkerLease): Promise<TickOutcome | null> {
    const tick = await repo.simulation.beginTick(lease)
    if (!tick) return null
    if (tick.toSimSec < tick.fromSimSec) throw new Error(`tick ${tick.tickId} goes backwards`)

    const done = new Set(tick.acknowledgedEntityIds)
    const airportIds = tick.entityIds.filter(e => e.startsWith("airport:") && !done.has(e))
    const flightIds = tick.entityIds.filter(e => e.startsWith("flight:") && !done.has(e))

    // Airports first, then flights (design §4). Entities within a phase are independent.
    await Promise.all(airportIds.map(e => advanceEntity(repo, lease, tick, e)))
    await Promise.all(flightIds.map(e => advanceEntity(repo, lease, tick, e)))

    // Touchdown phase. Idempotent by construction: guard and touchdown both key on
    // the flight's current assignment and the airport's touchdown receipts.
    const allFlightIds = tick.entityIds.flatMap(e => (e.startsWith("flight:") ? [e.slice(7)] : []))
    const allAirportIds = tick.entityIds.flatMap(e => (e.startsWith("airport:") ? [e.slice(8) as AirportId] : []))
    let flights = await Promise.all(allFlightIds.map(id => repo.flight(lease.runId, id).read()))
    const touchdowns: TouchdownReceipt[] = []
    const guardsFailed: string[] = []
    const changed = new Set<string>()

    for (const f of flights) {
        const a = f.activeAssignment
        if (!a || a.clearanceId === null || f.landingReceipt) continue
        if (f.phase !== "APPROACH" && f.phase !== "HOLDING") continue
        const ctx = tickContext(lease, tick, `${tick.tickId}:guard:${f.flightId}`)
        const airport = repo.airport(lease.runId, a.airportId)
        const check = await airport.validateClearance(ctx, { flightId: f.flightId, reservationId: a.reservationId, clearanceId: a.clearanceId })
        if (!check.valid) {
            await repo.flight(lease.runId, f.flightId).applyApproachGuard(ctx, check)
            guardsFailed.push(f.flightId)
            changed.add(f.flightId)
            continue
        }
        if (touchdownReady(f, tick.toSimSec)) {
            const outcome = await attemptTouchdown(repo, tickContext(lease, tick, `${tick.tickId}:touchdown:${f.flightId}`), {
                airportId: a.airportId,
                flightId: f.flightId,
                reservationId: a.reservationId,
                clearanceId: a.clearanceId,
                position: f.position,
                tickId: tick.tickId,
            })
            if (outcome.receipt) touchdowns.push(outcome.receipt)
            if (outcome.receipt || outcome.guarded) changed.add(f.flightId)
            if (outcome.guarded) guardsFailed.push(f.flightId)
        }
    }

    if (changed.size > 0) {
        flights = await Promise.all(flights.map(f => (changed.has(f.flightId) ? repo.flight(lease.runId, f.flightId).read() : f)))
    }
    const airports = await Promise.all(allAirportIds.map(id => repo.airport(lease.runId, id).read()))

    await repo.simulation.completeTick(lease, tick.tickId)
    return { tick, airports, flights, touchdowns, guardsFailed }
}
