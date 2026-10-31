import { expect, test } from "bun:test"
import * as sim from "../../actors/src/simulation.ts"
import { createWorld, createTrafficFlight } from "../../packages/domain/src/world.ts"
import { FlightStateSchema, SimulationStateSchema } from "../../packages/domain/src/contracts.ts"
const runId = "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c"
const config = { flightCount: 2, seed: 42, speed: 5 as const, airportNetwork: "US" as const, continuousTraffic: true }
function setup() {
    const run = sim.newRun(runId, "request", config, 0); run.phase = "RUNNING"
    const claimed = sim.claimWorker({ ...sim.emptyRoot(), activeRunId: runId, runs: { [runId]: run } }, "test", 1, "token")
    return claimed
}
test("continuous initial aircraft originate at distinct real airports; legacy remains seeded in air", () => {
    const world = createWorld(config, { runId, operationId: "initial" })
    for (const flight of world.flights) {
        expect(flight.originAirportId).not.toBe(flight.originalDestination)
        expect(flight.position).toEqual(world.airports.find(a => a.airportId === flight.originAirportId)!.position)
        FlightStateSchema.parse(flight)
    }
    const legacy = createWorld({ flightCount: 2, seed: 42, speed: 5 }, { runId, operationId: "legacy" })
    expect(legacy.flights[0]!.originAirportId).toBeUndefined()
})
test("durable replacement saga maintains N, retries same fresh ID, and blocks partial ticks", () => {
    const { root, lease } = setup()
    const prepared = sim.prepareTraffic(root, lease, ["flight:F001"], 2, ["LAX"])
    expect(prepared.pending).toHaveLength(1)
    const flight = prepared.pending[0]!.flight
    expect(flight.flightId).toBe("F003")
    expect(flight.originAirportId).toBe("LAX")
    FlightStateSchema.parse(flight)
    expect(sim.prepareTraffic(prepared.root, lease, ["flight:F001"], 3, ["LAX"]).pending).toEqual(prepared.pending)
    expect(sim.beginTick(prepared.root, lease, 3).tick).toBeNull()
    const active = sim.activateTraffic(prepared.root, lease, 4)
    expect(active.runs[runId]!.entities.filter(e => e.entityId.startsWith("flight:"))).toHaveLength(2)
    expect(active.runs[runId]!.entities.map(e => e.entityId)).toContain("flight:F003")
    expect(active.runs[runId]!.entities.map(e => e.entityId)).not.toContain("flight:F001")
    expect(sim.activateTraffic(active, lease, 5)).toEqual(active)
    expect(sim.prepareTraffic(active, lease, ["flight:F001"], 5).pending).toHaveLength(0)
    SimulationStateSchema.parse(active.runs[runId])
})
test("paused, reset, fenced, unavailable origins, and legacy runs cannot spawn", () => {
    const { root, lease } = setup()
    expect(sim.prepareTraffic(root, lease, ["flight:F001"], 2, []).pending).toHaveLength(0)
    const paused = structuredClone(root); paused.runs[runId]!.phase = "PAUSED"
    expect(sim.prepareTraffic(paused, lease, ["flight:F001"], 2).pending).toHaveLength(0)
    const legacy = structuredClone(root); delete legacy.runs[runId]!.config.continuousTraffic
    expect(sim.prepareTraffic(legacy, lease, ["flight:F001"], 2).pending).toHaveLength(0)
    expect(() => sim.prepareTraffic(root, { ...lease, epoch: 0 }, ["flight:F001"], 2)).toThrow("INVALID_LEASE")
    const reset = structuredClone(root); reset.activeRunId = null
    expect(() => sim.prepareTraffic(reset, lease, ["flight:F001"], 2)).toThrow("WRONG_RUN")
})
test("bounded capacity emits one explicit event and never reuses an actor", () => {
    const { root, lease } = setup()
    root.runs[runId]!.traffic = { nextSequence: sim.MAX_TRAFFIC_LEGS, pending: [], capacityReached: false }
    const result = sim.prepareTraffic(root, lease, ["flight:F001", "flight:F002"], 2)
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]!.flight.flightId).toBe("F10000")
    expect(result.root.runs[runId]!.events.at(-1)!.type).toBe("TRAFFIC_CAPACITY_REACHED")
    const active = sim.activateTraffic(result.root, lease, 3)
    const again = sim.prepareTraffic(active, lease, ["flight:F002"], 4)
    expect(again.pending).toHaveLength(0)
    expect(again.root.runs[runId]!.events.filter(e => e.type === "TRAFFIC_CAPACITY_REACHED")).toHaveLength(1)
})

test("repository initializes before activation and recovers identical actors after transport failure", async () => {
    const { workerRepositoryFrom } = await import("../../server/src/simulation/repository.ts")
    let { root, lease } = setup()
    const world = createWorld(config, { runId, operationId: "initial" })
    const flights = new Map(world.flights.map(f => [f.entityId, f])); flights.get("flight:F001")!.phase = "LANDED"
    const calls: string[] = []
    let activationThrows = false
    const generated = { actors: {
        SimulationActor: { get: () => ({
            readRun: async () => root.runs[runId],
            prepareTraffic: async (_lease: typeof lease, ids: any, origins: any) => { const out = sim.prepareTraffic(root, _lease, ids, 2, origins); root = out.root; return out.pending },
            cancelTraffic: async (_lease: typeof lease) => { calls.push("cancel"); root = sim.cancelTraffic(root, _lease, 3) },
            activateTraffic: async (_lease: typeof lease) => { calls.push("activate"); root = sim.activateTraffic(root, _lease, 3); if (activationThrows) throw new Error("response lost") },
        }) },
        FlightActor: { get: (id: string) => ({
            read: async () => flights.get(`flight:${id.split(".flight.")[1]}` as any),
            initialize: async (_ctx: unknown, state: any) => { calls.push(`initialize:${state.flightId}`); if (!flights.has(state.entityId)) flights.set(state.entityId, state); return { outcome: "APPLIED" } },
        }) },
        AirportActor: { get: (id: string) => ({ read: async () => world.airports.find(a => id.endsWith(`.airport.${a.airportId}`)) }) },
    } }
    const repo = workerRepositoryFrom(generated as any)
    await expect(repo.replenishTraffic!(lease, async () => { calls.push("connect-failed"); throw new Error("offline") })).rejects.toThrow("offline")
    expect(root.runs[runId]!.entities.map(e => e.entityId)).toContain("flight:F001")
    const reserved = root.runs[runId]!.traffic!.pending[0]!.flight.flightId
    expect(await repo.replenishTraffic!(lease, async ids => { calls.push("connect"); expect(ids).toContain(`flight:${reserved}`) })).toBe(true)
    expect(calls).toEqual([`initialize:${reserved}`, "connect-failed", `initialize:${reserved}`, "connect", "activate"])
    expect(root.runs[runId]!.entities.filter(e => e.entityId.startsWith("flight:"))).toHaveLength(2)
    flights.get("flight:F002")!.phase = "LANDED"
    let connections = 0
    expect(await repo.replenishTraffic!(lease, async () => {
        connections++
        if (connections === 1) {
            const origin = root.runs[runId]!.traffic!.pending[0]!.flight.originAirportId
            world.airports.find(a => a.airportId === origin)!.restrictions.arrivalsClosed = true
        }
    })).toBe(false)
    expect(connections).toBe(2) // Restore active Relay identities after abandoning the new identity.
    expect(root.runs[runId]!.traffic!.pending).toHaveLength(0)
    expect(root.runs[runId]!.entities.map(e => e.entityId)).toContain("flight:F002")
    expect(sim.beginTick(root, lease, 4).tick).not.toBeNull()
    // A pause during pre-registration retains every authoritative identity.
    expect(await repo.replenishTraffic!(lease, async ids => {
        expect(ids).toContain("flight:F002")
        root.runs[runId]!.phase = "PAUSED"
    })).toBe(false)
    expect(await repo.messagingEntities!(runId)).toContain("flight:F002")
    root.runs[runId]!.phase = "RUNNING"
    // Activation commits, then the transport response is lost. The same running
    // worker reconciles directly from authority, without needing another spawn.
    const { reconcileWorkerMembership } = await import("../../server/src/simulation/worker.ts")
    const { registrationsFor } = await import("../../server/src/relay/transport.ts")
    const activeIds = await repo.entities(runId)
    const agentIds = activeIds.filter((id): id is `flight:${string}` | `airport:${string}` => id !== "controller")
    const registry = registrationsFor(runId, await repo.messagingEntities!(runId))
    activationThrows = true
    await expect(repo.replenishTraffic!(lease, async () => {})).rejects.toThrow("response lost")
    expect(await reconcileWorkerMembership(repo, runId, activeIds, agentIds, registry, null)).toBe(true)
    const fresh = root.runs[runId]!.entities.find(e => e.entityId.startsWith("flight:") && e.entityId !== reserved && !e.entityId.endsWith(reserved) && e.entityId !== "flight:F003")!
    expect(agentIds as string[]).toContain(fresh.entityId)
    expect(registry.map(e => e.entityId)).toContain("flight:F002")
    expect(await repo.replenishTraffic!(lease, async () => {})).toBe(false)
})


test("unavailable pending departure cancels durably and burns its ID so the clock can resume", () => {
    const { root, lease } = setup()
    const pending = sim.prepareTraffic(root, lease, ["flight:F001"], 2, ["LAX"])
    const cancelled = sim.cancelTraffic(pending.root, lease, 3)
    expect(cancelled.runs[runId]!.entities).toEqual(root.runs[runId]!.entities)
    expect(sim.beginTick(cancelled, lease, 4).tick).not.toBeNull()
    const replanned = sim.prepareTraffic(cancelled, lease, ["flight:F001"], 4, ["DEN"])
    expect(replanned.pending[0]!.flight.flightId).toBe("F004")
    expect(replanned.pending[0]!.flight.originAirportId).toBe("DEN")
})

test("accepted pre-landing commands and late airport replies remain routed to retired actors", async () => {
    const { submitLedgerCommand } = await import("../../actors/src/ledger.ts")
    const { receiveControllerCommand } = await import("../../packages/domain/src/incidents.ts")
    const { applyCommandResult } = await import("../../packages/domain/src/command-ledger.ts")
    const { routeReceived } = await import("../../server/src/relay/router.ts")
    const { registrationsFor } = await import("../../server/src/relay/transport.ts")
    const { entityHandle } = await import("../../packages/domain/src/contracts.ts")
    let { root, lease } = setup()
    const commandId = crypto.randomUUID()
    const accepted = await submitLedgerCommand(root, { runId, commandId, type: "INCIDENT_CREATE", payload: { incidentId: crypto.randomUUID(), target: "flight:F001", kind: "SMOKE", parameters: {} } }, { principalId: "controller", role: "CONTROLLER", runId, sessionId: "test" }, 2, null)
    root = accepted.root
    let old = createWorld(config, { runId, operationId: "initial" }).flights[0]!
    old.phase = "LANDED"
    const prepared = sim.prepareTraffic(root, lease, [old.entityId], 3)
    const fresh = structuredClone(prepared.pending[0]!.flight)
    root = sim.activateTraffic(prepared.root, lease, 4)
    const messagingIds = [...root.runs[runId]!.entities.map(e => e.entityId), ...root.runs[runId]!.traffic!.retiredIds!]
    const registry = registrationsFor(runId, messagingIds)
    const received = (envelope: any) => ({ ...envelope, transportMessageId: `transport-${envelope.messageId}`, senderHandle: entityHandle(runId, envelope.fromEntityId), recipientHandle: entityHandle(runId, envelope.toEntityId), receivedAtWallMs: 5 })
    const command = root.runs[runId]!.controllerOutbox[0]!.envelope
    const result = await routeReceived(received(command), { runId, registry, inbox: { receive: async (id, message) => {
        expect(id).toBe(old.entityId)
        const step = receiveControllerCommand(old, message as any, { runId, simNowSec: 0, wallNowMs: 5 })
        old = step.state
        return step.result
    } } })
    expect(result.code).toBe("ALREADY_TERMINAL")
    const reply = old.outbox.find(entry => entry.envelope.type === "COMMAND_RESULT")!.envelope
    expect(messagingIds).toContain(old.entityId) // Same membership used by outbox dispatch.
    await routeReceived(received(reply), { runId, registry, inbox: { receive: async (_id, message) => {
        const out = applyCommandResult(root.runs[runId]!, message as any, 6)
        root.runs[runId] = out.state
        return out.result
    } } })
    expect(root.runs[runId]!.commands[commandId]!.receipt).toMatchObject({ status: "REJECTED", code: "ALREADY_TERMINAL" })
    const airportReply = { messageId: crypto.randomUUID(), runId, fromEntityId: "airport:ATL", toEntityId: old.entityId, type: "DOMAIN_ACK", correlationId: commandId, causationId: null, createdAtWallMs: 6, simTimeSec: 0, payload: { messageId: crypto.randomUUID() } }
    let routedTo: string | undefined
    await routeReceived(received(airportReply), { runId, registry, inbox: { receive: async id => { routedTo = id; return { outcome: "APPLIED", code: "OK", stateRevision: 1 } } } })
    expect(routedTo).toBe("flight:F001")
    expect(fresh.incidents).toEqual({})
    expect(fresh.entityId).toBe("flight:F003")
})

test("ended worker cannot reconnect old run after deferred initialization finishes", async () => {
    const { SimulationWorker } = await import("../../server/src/simulation/worker.ts")
    const { RulesModelAdapter } = await import("../../server/src/agents/model.ts")
    const { chooseValidAction } = await import("../../packages/domain/src/policy.ts")
    const { makeWorld } = await import("../integration/sim-harness.ts")
    const w = makeWorld()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const connected: string[] = []
    const transport = { connect: async (id: string) => { connected.push(id) }, onMessage: () => () => {}, disconnect: async () => {}, health: async () => ({ status: "READY" }), send: async () => ({ transportMessageId: "unused" }), reconcile: async () => {} }
    w.repo.replenishTraffic = async (_lease, connect) => { entered(); await gate; await connect(await w.repo.entities(_lease.runId)); return false }
    const worker = new SimulationWorker({ repo: w.repo, model: new RulesModelAdapter(chooseValidAction), fallback: chooseValidAction, transport: transport as any, now: () => w.clock.now, tickIntervalMs: 1 })
    await worker.start()
    await started
    await worker.stop()
    await transport.connect("new-run")
    release()
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(connected.at(-1)).toBe("new-run")
    expect(connected).toHaveLength(2)
})

test("membership reconciliation rechecks fencing after its awaited authority reads", async () => {
    const { reconcileWorkerMembership } = await import("../../server/src/simulation/worker.ts")
    let current = true, connects = 0
    const active: any[] = ["flight:F001"], agents: any[] = ["flight:F001"], registry: any[] = []
    const repo = { entities: async () => { current = false; return ["flight:F002"] } }
    expect(await reconcileWorkerMembership(repo as any, runId, active, agents, registry, { connect: async () => { connects++ } } as any, () => current)).toBe(false)
    expect(connects).toBe(0)
    expect(active).toEqual(["flight:F001"])
})


test("both regional streams preserve featured arrivals, add outbound traffic, and vary new inbound legs", () => {
    for (const focusRegion of ["BAY_AREA", "NYC"] as const) {
        const cfg = { ...config, flightCount: 8, focusRegion, featuredFlightId: focusRegion === "BAY_AREA" ? "F001" : null }
        const world = createWorld(cfg, { runId, operationId: "initial" })
        expect(world.flights.filter(f => f.originAirportId)).toHaveLength(1)
        expect(world.flights[0]!.originAirportId).toBeUndefined()
        if (focusRegion === "BAY_AREA") expect(world.flights[0]!.position).toEqual({ x: 23.6, y: 87.4 })
        const outbound = createTrafficFlight(cfg, { runId, operationId: "traffic" }, 9, 500)
        const incoming = createTrafficFlight(cfg, { runId, operationId: "traffic" }, 10, 600)
        const nextIncoming = createTrafficFlight(cfg, { runId, operationId: "traffic" }, 12, 700)
        expect(outbound.originAirportId).toBe(focusRegion === "NYC" ? "JFK" : "SFO")
        expect(incoming.originAirportId).toBeUndefined()
        expect(incoming.originalDestination).toBe(focusRegion === "NYC" ? "JFK" : "SFO")
        expect(incoming.position).not.toEqual(nextIncoming.position)
        expect(incoming.lastAdvancedSimSec).toBe(600)
        for (const flight of [outbound, incoming, nextIncoming]) FlightStateSchema.parse(flight)
    }
})

test("regional traffic retains landings, paces single replacements, preserves featured history, and avoids closed origins", () => {
    let { root, lease } = setup()
    const run = root.runs[runId]!
    run.config = { ...run.config, focusRegion: "NYC" }
    let out = sim.prepareTraffic(root, lease, ["flight:F001", "flight:F002"], 2, ["EWR"])
    expect(out.pending).toHaveLength(0) // Landing stays visible for 90 simulated seconds.
    root = out.root; root.runs[runId]!.simNowSec = 91
    out = sim.prepareTraffic(root, lease, ["flight:F001", "flight:F002"], 3, ["EWR"])
    expect(out.pending).toHaveLength(1)
    expect(out.pending[0]!.flight.originAirportId).toBe("EWR") // JFK/LGA unavailable.
    root = sim.activateTraffic(out.root, lease, 4)
    expect(sim.prepareTraffic(root, lease, ["flight:F002"], 5, []).pending).toHaveLength(0)
    root.runs[runId]!.simNowSec = root.runs[runId]!.traffic!.nextSpawnSimSec!
    out = sim.prepareTraffic(root, lease, ["flight:F002"], 6, [])
    expect(out.pending).toHaveLength(1) // Incoming traffic needs no departure runway.
    expect(out.pending[0]!.flight.originAirportId).toBeUndefined()
    SimulationStateSchema.parse(out.root.runs[runId])
    const bay = setup(); bay.root.runs[runId]!.config = { ...config, focusRegion: "BAY_AREA", featuredFlightId: "F001" }
    const seen = sim.prepareTraffic(bay.root, bay.lease, ["flight:F001"], 2)
    seen.root.runs[runId]!.simNowSec = 1000
    expect(sim.prepareTraffic(seen.root, bay.lease, ["flight:F001"], 3).pending).toHaveLength(0)
})
