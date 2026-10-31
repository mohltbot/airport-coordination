import { describe, expect, test } from "bun:test"
import { AIRPORTS, US_AIRPORTS, RELAY_TIMING } from "../../packages/domain/src/constants.ts"
import { AirportStateSchema, FlightStateSchema, AirportEntityIdSchema, PublicSnapshotSchema, RunConfigSchema } from "../../packages/domain/src/contracts.ts"
import { createWorld } from "../../packages/domain/src/world.ts"
import { AIRPORT_POSITION } from "../../packages/domain/src/flight.ts"
import { negotiationTiming, planCandidates, reachableAirports } from "../../packages/domain/src/negotiation.ts"
import { registrations, newRun } from "../../actors/src/simulation.ts"
import { compactLocalState } from "../../server/src/agents/prompts.ts"
import { US_AIRPORTS as geographicAirports } from "../../web/src/lib/us-geography.ts"
import legacySnapshot from "../fixtures/public-snapshot.json"

const options = { runId: "6a1f0c2e-5b7d-4e8a-9c3f-2d4b6e8f0a1c", operationId: "us-test" }
const config = { flightCount: 23, seed: 20261031, speed: 5 as const, airportNetwork: "US" as const }

describe("opt-in US airport network", () => {
    test("sixteen canonical airports match geography and validate with deterministic round-robin flights", () => {
        const world = createWorld(config, options)
        expect(world).toEqual(createWorld(config, options))
        expect(US_AIRPORTS).toEqual(geographicAirports)
        expect(world.airports).toHaveLength(16)
        expect(world.airports.map(a => a.airportId)).toEqual(US_AIRPORTS.map(a => a.airportId))
        for (const airport of world.airports) {
            AirportStateSchema.parse(airport)
            expect(AIRPORT_POSITION[airport.airportId]).toEqual(airport.position)
            expect(AirportEntityIdSchema.safeParse(airport.entityId).success).toBe(true)
        }
        world.flights.forEach((flight, index) => {
            FlightStateSchema.parse(flight)
            expect(flight.originalDestination).toBe(US_AIRPORTS[index % US_AIRPORTS.length]!.airportId)
        })
        expect(AirportEntityIdSchema.safeParse("airport:UNKNOWN").success).toBe(false)
    })
    test("registrations opt in without modifying persisted legacy runs", () => {
        expect(registrations(options.runId, 23, "US")).toHaveLength(40)
        expect(newRun(options.runId, "request", config, 0).entities).toHaveLength(40)
        expect(registrations(options.runId, 23)).toHaveLength(27)
        const legacyConfig = { flightCount: 10, seed: 42, speed: 5 as const }
        expect(RunConfigSchema.parse(legacyConfig)).toEqual(legacyConfig)
        expect(createWorld(legacyConfig, options).airports.map(a => a.airportId)).toEqual(AIRPORTS.map(a => a.airportId))
        expect(createWorld({ ...legacyConfig, airportNetwork: "LEGACY" }, options)).toEqual(createWorld(legacyConfig, options))
        PublicSnapshotSchema.parse(legacySnapshot)
    })
    test("rules and model directories stay within the flight network and candidate limit", () => {
        const world = createWorld(config, options)
        const flight = { ...world.flights[0]!, fuelRemainingSec: 100_000, priority: "EMERGENCY" as const }
        const ctx = { simNowSec: 0, wallNowMs: 0, timing: negotiationTiming(RELAY_TIMING.LOCAL, 5) }
        expect(reachableAirports(flight, ctx)).toHaveLength(16)
        expect(planCandidates(flight, "EMERGENCY", ctx)).toHaveLength(3)
        expect(planCandidates({ ...flight, priority: "NORMAL" }, "INITIAL", ctx)).toEqual(["ATL"])
        const view = compactLocalState("PILOT", flight)
        expect((view.airportDirectory as Array<{ airportId: string }>).map(a => a.airportId)).toEqual(US_AIRPORTS.map(a => a.airportId))
        const legacy = createWorld({ flightCount: 1, seed: 42, speed: 5 }, options).flights[0]!
        expect(reachableAirports({ ...legacy, fuelRemainingSec: 100_000 }, ctx)).toHaveLength(3)
        expect(compactLocalState("PILOT", legacy).airportDirectory).toHaveLength(3)
    })
})
