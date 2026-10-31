# Multi Airport Agent Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, or superpowers:subagent-driven-development if the user chooses delegation. Steps use checkbox (`- [ ]`) syntax for tracking. This document requests no implementation during the planning turn.

**Goal:** Build Ghost Tower, a multi-airport simulator in which a configurable population of flight agents negotiates landing arrangements with durable ATC agents, and phone users activate and resolve incidents through AgentRelay.

**Architecture:** Terse airport and flight actors own authoritative state, durable inboxes, decisions, and outboxes. A stateless worker executes actor-owned agent jobs and AgentRelay messaging; a separate deterministic coordinator advances the simulation. A React display and phone controller use an authenticated gateway, durable command receipts, and server-sent snapshots.

**Tech Stack:** Bun 1.4.4, TypeScript 5.9.3, Terse SDK/CLI 0.14.9, AgentRelay SDK 15.0.0-next.10, OpenAI SDK 6.26.0, React 19, Vite 7, Zod 4, SVG/CSS, Bun tests, Playwright.

**Spec:** [Multi Airport Agent Simulator Design](../specs/2026-10-31-atc-simulator-design.md). Read the whole spec before implementation. All new application paths below are relative to `atc-simulator/`; the plan and spec remain in the parent repository's `docs/superpowers/` directories.

## Global Constraints

- Integer 1–30; default 10; presets 5, 10, 20, 30.
- Three fictional airports: ALP / Alpha, BRV / Bravo, CHR / Charlie.
- Fictional planar map, 240 × 160 nautical miles; no map provider or live data.
- 250 ms wall-clock scheduler interval; speed choices 1×, 5×, 10×; default 10×.
- Initial seed 20261031; deterministic scenario generation.
- Both activating and clearing incidents must travel through AgentRelay, including commands initiated on a phone.
- The gateway must not directly apply an incident to an airport/flight actor.
- One durable actor and one logical LLM agent per flight; one durable actor and one logical LLM agent per airport.
- Actors own inbox, work, decisions, and outbox; a stateless worker executes LLM/network I/O.
- Pause stops simulated time, movement, fuel, and incident deadlines; messaging and wall-clock leases continue.
- Never use `@Interleave` on a domain mutation.
- Maximum four concurrent model calls and one call per entity.
- Max encoded Relay body: 8 KiB. All commands and messages are typed, authenticated, run-scoped, and idempotent.
- Keep model/Relay credentials server-side; never include them in a public actor projection, frontend bundle, URL query, or log.
- A mock-only demo is not complete. Acceptance requires real Terse persistence, real Relay transport, and a live model scenario.

## Review Focus

1. A create/clear sequence is duplicated, delayed, or received out of order: it must never resurrect a cleared incident. Covered in Tasks 3, 5, 7, and 11.
2. A landing acceptance succeeds but its confirmation is lost: the flight must reconcile the same reservation rather than accept multiple destinations. Covered in Tasks 4, 5, and 11.
3. Airport conditions change while a model is reasoning or a flight is approaching: stale proposals and invalid clearances must not produce a landing. Covered in Tasks 4, 6, 8, and 11.
4. A worker or browser reconnects during reset: old run messages, ticks, and model outputs must not mutate the new run. Covered in Tasks 2, 7, 8, 9, and 11.
5. All airports are unavailable or the model/Relay is unavailable: show pending, holding, fallback, or unresolved status truthfully, with bounded retries and no false success. Covered in Tasks 4, 5, 6, 9, and 11.

## 1. Reading order and implementation policy

Read the design, then the contracts below, then execute Tasks 1–12 in dependency order. The design states which choices are implementation defaults. Do not interpret those as tested capabilities or previously approved implementation details.

Write focused behavioral tests before domain/protocol code. Do not add tests that merely mirror CSS or component internals. Review rendered UI at the specified desktop and phone sizes. Commit a completed task only after its relevant checks pass; stage named project files, never unrelated workspace content. Do not push or deploy merely because a task says “commit.”

If a documented package capability does not work on the pinned version, preserve the product contract and fix the adapter. Record the actual limitation and the verified replacement; do not silently bypass Relay or substitute in-memory state for Terse. The first task deliberately proves integration seams before the bulk of implementation.

This project has one integrated implementation plan because the phone path, actor state, negotiations, and UI jointly define the demo. Each task below still produces a separately testable deliverable.

## 2. File map

```text
atc-simulator/
  package.json, bun.lock, tsconfig.json, .gitignore, .env.example
  README.md, PRODUCT.md, DESIGN.md
  scripts/
    doctor.ts                 # dependency and service checks; redact secrets
    actors-generate.ts        # generate typed clients using local Terse CLI
    dev.ts                    # supervise only project-owned processes
    bootstrap-relay.ts        # provision project identities, persist tokens
    demo-reset.ts             # authenticated new-run operation
  packages/domain/src/
    contracts.ts              # shared Zod schemas and inferred types
    constants.ts              # all specified numerical defaults
    world.ts                  # seeded airports and flights
    geometry.ts               # distance, travel time, movement, holding
    incidents.ts              # apply/resolve/derive effective conditions
    scheduling.ts             # slot search, conflicts, emergency preemption
    negotiation.ts            # round/offer/assignment transitions
    flight.ts                 # movement, fuel, approach and terminal outcomes
    policy.ts                 # deterministic valid-action policy/fallback
    projections.ts            # redacted actor views and timeline summaries
  actors/
    package.json, tsconfig.json, bunfig.toml
    src/actors.ts             # public actor exports
    src/SimulationActor.ts    # run registry, clock, controller ledger, projection
    src/AirportActor.ts       # airport aggregate and public actor methods
    src/FlightActor.ts        # flight aggregate and public actor methods
    src/durability.ts         # inbox/outbox/job helpers, fencing, aggregate writes
  server/
    generated/                # generated Terse clients; no hand edits
    src/main.ts               # API/static/SSE server
    src/config.ts             # strict environment parser
    src/auth.ts               # operator/controller/viewer roles, invites, CSRF
    src/routes.ts             # API contract from spec
    src/stream.ts             # full-snapshot SSE and connection cleanup
    src/actors.ts             # typed ActorRepository wrapper
    src/projection.ts         # gather/redact/publish actor state
    src/relay/transport.ts    # RelayTransport interface
    src/relay/agent-relay.ts  # real SDK adapter, identities, recovery
    src/relay/router.ts       # verify sender/schema/run and invoke target
    src/relay/outbox.ts       # retry, transport receipt, domain ACK
    src/agents/model.ts       # model adapter interface and OpenAI implementation
    src/agents/prompts.ts     # role instructions and allowed action schemas
    src/agents/runner.ts      # job leasing, concurrency and fallback
    src/agents/tools.ts       # permitted proposal-to-domain mapping
    src/simulation/worker.ts  # orchestration loops and recovery startup
    src/simulation/clock.ts   # fenced, resumable ticks
    src/simulation/landing.ts # final authoritative touchdown/recovery
  web/
    package.json, index.html, vite.config.ts
    src/main.tsx, App.tsx
    src/api.ts, useRunStream.ts
    src/styles/tokens.css, app.css
    src/components/WorldMap.tsx, FlightList.tsx, EntityInspector.tsx
    src/components/Timeline.tsx, RunToolbar.tsx, RunSetup.tsx
    src/components/IncidentControls.tsx, CommandStatus.tsx, PhoneInvite.tsx
    src/pages/Display.tsx, Controller.tsx, Join.tsx
  tests/
    fixtures.ts, helpers.ts
    unit/contracts.test.ts, world.test.ts, geometry.test.ts
    unit/incidents.test.ts, scheduling.test.ts, negotiation.test.ts
    unit/flight.test.ts, policy.test.ts, projections.test.ts
    integration/terse.test.ts, relay.test.ts, actors.test.ts
    integration/commands.test.ts, agents.test.ts, simulation.test.ts
    integration/recovery.test.ts, scenarios.test.ts
    e2e/display.spec.ts, controller.spec.ts, reconnect.spec.ts
    live/demo.test.ts
  docs/
    integration-evidence.md
    deployment.md
    demo-runbook.md
    acceptance-results.md
```

Ignore `.env`, `.env.local`, `.data/`, `actors/.durable-actors/`, generated runtime credentials, logs, test videos, and browser traces. Commit `.env.example` with names and descriptions but no usable secrets. Generated actor clients may be committed for reproducibility only if inspection confirms they contain no secrets or environment-specific credentials; generation is still part of build/check.

## 3. Shared contracts to implement first

The following names are application interfaces to create, not claims that Terse or Relay already exports them. Infer JSON types from Zod schemas wherever possible. Reject unknown properties on control messages. Use seconds for simulation fields and milliseconds for wall-clock fields.

### Core types

```ts
type EntityId = `airport:${string}` | `flight:${string}` | 'controller';
type RunPhase = 'CONFIGURING' | 'STARTING' | 'PAUSED' | 'RUNNING'
  | 'COMPLETED' | 'RESETTING';
type FlightPhase = 'ENROUTE' | 'HOLDING' | 'APPROACH' | 'LANDED' | 'UNRESOLVED';
type Priority = 'NORMAL' | 'EMERGENCY';
type Point = { x: number; y: number }; // nautical miles
type RunConfig = { flightCount: number; seed: number; speed: 1 | 5 | 10 };
type MutationContext = {
  runId: string; workerEpoch: number; leaseToken: string;
  simNowSec: number; wallNowMs: number; operationId: string;
};
type Tick = { tickId: string; fromSimSec: number; toSimSec: number };
type IncidentKind = 'WEATHER_CLOSED' | 'RUNWAY_CLOSED' | 'CAPACITY_REDUCED'
  | 'SMOKE' | 'ENGINE_TROUBLE' | 'LOW_FUEL';
type IncidentCreate = {
  incidentId: string; target: EntityId; kind: IncidentKind;
  parameters: Record<string, never> | { runwayId: 'R1' | 'R2' };
};
type IncidentClear = { incidentId: string; target: EntityId; expectedIncidentRevision: number };
type IncidentCommand = {
  commandId: string; runId: string;
} & ({ type: 'INCIDENT_CREATE'; payload: IncidentCreate }
   | { type: 'INCIDENT_CLEAR'; payload: IncidentClear });
type CommandStatus = 'QUEUED' | 'SENT' | 'DELAYED' | 'APPLIED' | 'REJECTED';
```

Implement the incident command as a discriminated union enforcing the target-kind matrix: airport types require `airport:*`, flight types require `flight:*`, and only RUNWAY_CLOSED accepts runwayId. Additional incident fields and behavior are in design §5.

`ProtocolEnvelope` contains the fields and discriminated payloads in design §7 and the message table in §6. `ReceivedEnvelope` adds `transportMessageId`, authenticated `senderHandle`, `recipientHandle`, and `receivedAtWallMs`. The envelope's `fromEntityId` must agree with the server-owned handle mapping. `DomainResult` is `{outcome:'APPLIED'|'REJECTED'|'DUPLICATE',code:string,stateRevision:number}`; a duplicate additionally returns the stored original result. Avoid literal duplicate effects even if Relay assigned a different transport message ID.

### Durable aggregates

| Type | Required fields in addition to runId/entityId/stateRevision/decisionRevision |
|---|---|
| `AirportState` | airport metadata, incidents by ID, effective restrictions, runways, offers by ID, reservations by ID, clearances by ID, touchdown receipts by operation ID, lastTickId/lastAdvancedSimSec, inbox results, outbox, jobs, lastControllerSequence, buffered controller messages, worker fencing data |
| `FlightState` | callsign, originalDestination, position, heading, speedKnots, fuelRemainingSec, phase, holdCenter/holdAngle, incidents, derived priority/deadline, negotiation round, pendingAcceptance, activeAssignment, release obligations, landing receipt, lastTickId/lastAdvancedSimSec, inbox/outbox/jobs/controller sequence/fencing data |
| `SimulationState` | run config/phase, active entity IDs and handles, simulation time, pendingTick with per-entity receipts, command ledger, target command sequences, controller outbox/inbox, initialization steps, worker lease, projectionVersion/public snapshot, run event log |

The stable `SimulationActor.get('ghost-tower')` owns one persisted root aggregate `SimulationRootState={activeRunId:string|null,runs:Record<string,SimulationState>,createRequests:Record<string,string>,relayEventCursor:number}`. Methods resolve the run inside this aggregate; reset adds a fresh run entry and preserves the old entry. Domain entities remain separate actors. This explicitly keeps the registry and per-run history together for the small demo without inventing cross-actor transactions. Do not append position frames to the run event log; log meaningful domain transitions only. Actor effective simulation time is never less than its own `lastAdvancedSimSec`, even if a message carries an older sampled time.

`Offer` fields are those in LANDING_OFFER plus flightId, status (`OFFERED|CONFIRMED|DECLINED|EXPIRED|REVOKED`), and request message ID. `Reservation` adds reservationId and status (`CONFIRMED|CLEARED|OCCUPIED|COMPLETED|RELEASED|REVOKED|EXPIRED`). `Assignment` contains airportId, runwayId, reservationId, slotStartSimSec, occupancySec, and clearanceId|null. `NegotiationRound` stores round ID, trigger, candidate airports, replies, collectUntilWallMs, and stage (`REQUESTING|COLLECTING|ACCEPTING|CONFIRMED|NO_FEASIBLE_AIRPORT`).

Store `OutboxEntry={envelope,recipientHandle,attemptCount,nextAttemptAtWallMs,transportMessageId|null,acknowledged:boolean}`. Store `Job={jobId,kind,status,decisionRevision,input,leaseToken|null,leaseUntilWallMs|null,attemptCount}`. Keep domain deduplication records for the entire run. UI event retention and backend dedup retention are different concerns.

### Interfaces between tasks

```ts
interface RelayTransport {
  connect(runId: string, entities: EntityRegistration[]): Promise<void>;
  send(envelope: ProtocolEnvelope): Promise<{ transportMessageId: string }>;
  onMessage(handler: (message: ReceivedEnvelope) => Promise<void>): () => void;
  disconnect(): Promise<void>;
}
interface ModelAdapter {
  decide(input: AgentDecisionInput, signal: AbortSignal): Promise<AgentDecision>;
}
type Transition<S> = { state: S; result: DomainResult };
```

`EntityRegistration={entityId,handle,role:'CONTROLLER'|'PILOT'|'ATC'}`. Derive handles as `ghost-<runId first 8 chars>-controller`, `ghost-<prefix>-atc-alp`, `ghost-<prefix>-flight-f001`, etc.; preserve the mapping. Actor instance IDs use the complete run ID, e.g. `<runId>/airport/ALP`.

`AgentDecisionInput` is `{jobId,entityId,role,decisionRevision,allowedActions,localState,relevantMessages}`. `AgentDecision` is a discriminated union of the six proposals in design §7; each carries only the IDs and values required for its permitted action and a `reason` string of at most 240 characters. Proposal schemas are role-specific. `DecisionCommit` includes `{jobId,jobLeaseToken,decisionRevision,decision,source:'MODEL'|'RULES_FALLBACK'}`.

`ClaimedJob=AgentDecisionInput & {jobLeaseToken:string,leaseUntilWallMs:number}`. Keep the lease metadata in the runner; pass only AgentDecisionInput to the model. The work-lease token returned by claimWork is exactly the token submitted in DecisionCommit.

Public actor APIs to expose through generated clients:

```ts
// AirportActor and FlightActor
initialize(context: MutationContext, initialState: AirportState | FlightState): Promise<DomainResult>;
read(): Promise<AirportState | FlightState>; // internal-only repository access
receive(context: MutationContext, message: ReceivedEnvelope): Promise<DomainResult>;
advance(context: MutationContext, tick: Tick): Promise<DomainResult>;
claimWork(context: MutationContext): Promise<ClaimedJob | null>;
commitDecision(context: MutationContext, commit: DecisionCommit): Promise<DomainResult>;
markTransportAccepted(context: MutationContext, messageId: string, transportMessageId: string): Promise<void>;

// AirportActor only
validateClearance(context: MutationContext, input: ClearanceCheck): Promise<ClearanceCheckResult>;
recordTouchdown(context: MutationContext, input: TouchdownInput): Promise<TouchdownReceipt>;

// FlightActor only
applyApproachGuard(context: MutationContext, result: ClearanceCheckResult): Promise<DomainResult>;
recordTouchdown(context: MutationContext, receipt: TouchdownReceipt): Promise<DomainResult>;

// SimulationActor
createRun(requestId: string, config: RunConfig): Promise<RunDescriptor>;
setRunPhase(runId: string, phase: RunPhase, operationId: string): Promise<RunDescriptor>;
setSpeed(runId: string, speed: 1 | 5 | 10, operationId: string): Promise<RunDescriptor>;
resetRun(runId: string, operationId: string): Promise<RunDescriptor>;
submitCommand(command: IncidentCommand, principal: ControllerPrincipal): Promise<CommandReceipt>;
readCommand(runId: string, commandId: string): Promise<CommandReceipt>;
claimWorker(ownerId: string, nowWallMs: number): Promise<WorkerLease>;
renewWorker(lease: WorkerLease): Promise<WorkerLease>;
beginTick(lease: WorkerLease): Promise<PendingTick | null>;
ackTickEntity(lease: WorkerLease, tickId: string, entityId: EntityId): Promise<void>;
completeTick(lease: WorkerLease, tickId: string): Promise<void>;
publishProjection(lease: WorkerLease, snapshot: PublicSnapshot): Promise<void>;
readPublic(runId: string): Promise<PublicSnapshot>;
```

Implement each actor's concrete signature with its concrete state type, not the union shown for brevity. Controller ledger receive/outbox methods reuse the durable helpers used by entity actors. `ControllerPrincipal` is issued by the authenticated gateway, never accepted directly from browser JSON.

`ClearanceCheck={flightId,reservationId,clearanceId}`. `ClearanceCheckResult={valid:boolean,reason:string,reservationId,clearanceId}`. `TouchdownInput` adds position, tickId, and flightId to the clearance IDs. `TouchdownReceipt={receiptId,runId,flightId,airportId,runwayId,reservationId,clearanceId,touchdownAtSimSec,occupiedUntilSimSec}`. `RunDescriptor={runId,phase,config}`. `WorkerLease={runId,ownerId,epoch,token,expiresAtWallMs}`. `PendingTick=Tick & {entityIds:EntityId[],acknowledgedEntityIds:EntityId[]}`. `CommandReceipt={runId,commandId,status,incidentId,code|null,resultingRevision|null}`. `PublicSnapshot` contains run/config/time/version, redacted airports/flights, command receipts, timeline, dependency health, and metric samples; no raw actor internals.

Clock inputs come from the trusted coordinator. Actors validate lease expiry against their own wall clock, not just the supplied timestamp. A new worker lease is granted only after the old lease expires; distribute the new fence to entities before dispatching work. A newer epoch permanently rejects older epochs. On reset, the registry rejects old run operations before the new namespace becomes active.

## 4. Build tasks

### Task 1: Prove pinned Terse and Relay integration

**Files:** Create root package/config files, `actors/package.json`, `actors/tsconfig.json`, `actors/bunfig.toml`, `scripts/doctor.ts`, `scripts/actors-generate.ts`, `tests/integration/terse.test.ts`, `tests/integration/relay.test.ts`, and `docs/integration-evidence.md`. Add minimal probe actor exports in `actors/src/actors.ts` for this task; replace them with production exports in Task 2.

**Consumes:** Existing local examples and installed SDK references listed in design §11.

**Produces:** Reproducible actor generation and a proven programmatic Relay round trip; root scripts `doctor`, `actors:generate`, `check`, `test:integration`.

- [ ] Create the isolated project directory and workspace package files. Pin known versions, resolve exact frontend/test patch versions once, save the lockfile. Configure TS decorators like `haunted-hacks-setup/counter-local/actor/tsconfig.json`. Preserve unrelated workspace files.
- [ ] Add a Terse probe test with a unique actor ID: update one aggregate containing `{count,processedIds,outbox}`, restart only the test actor runtime, read it, and assert all three fields survive together. Reapply the same operation ID and assert count remains 1 and outbox length remains 1. Include a process interruption before/after actor-call completion to establish uncertain-call retry behavior.
- [ ] Add a Relay probe test using two dedicated application test identities and the SDK: A sends a UUID marker to B, B receives the authenticated sender and replies, A receives the reply; reconnect both with saved tokens and repeat. Test replaying the same idempotency key and recovering the original message through the durable workspace event log after a callback was lost. Verify event sequence/cursor and pagination against the configured engine. Do not send from the coding assistant's desktop identity or contact unrelated agents.
- [ ] Implement the probes using the inspected API: `new AgentRelay({workspaceKey,baseUrl})`, `workspace.register({name,type:'agent'})`, `workspace.reconnect({apiToken})`, `client.sendMessage({to:'@handle',text,idempotencyKey})`, and `addListener(...)`. Verify exact event fields against installed types. Persist new client tokens securely; never dump the client object or credentials.
- [ ] Run `bun run doctor` and `bun run test:integration -- --filter=bootstrap`. The scripts must implement this filter. Expected: actor persistence/retry, Relay delivery/reply/reconnect, and credential redaction checks all PASS. A send receipt alone is insufficient. Record package versions, actual base URLs without credentials, supported event behavior, and command output summaries in integration-evidence.md. Commit `chore: validate simulator actor and relay foundations`.

**Stop condition:** If a runtime capability is unavailable, record the failure and repair the integration before building on it. This task does not permit silently replacing either required technology.

### Task 2: Define domain contracts, world generation, and durable run state

**Files:** Create `packages/domain/src/{contracts,constants,world,geometry,projections}.ts`, `actors/src/{SimulationActor,AirportActor,FlightActor,durability}.ts`, `server/src/actors.ts`, `tests/{fixtures,helpers}.ts`, `tests/unit/{contracts,world,geometry,projections}.test.ts`, and `tests/integration/actors.test.ts`. Update actor exports and generated clients.

**Consumes:** Task 1 working actor runtime and generation command; shared contracts above.

**Produces:** `createWorld(config:RunConfig):InitialWorld`, `distanceNm(a:Point,b:Point):number`, `travelSeconds(distance:number,speedKnots:number):number`, initial actor aggregates, registry, and `ActorRepository`. `InitialWorld={airports:AirportState[],flights:FlightState[]}`. `ActorRepository` resolves a run/entity to generated actor clients and never exposes credentials to the web.

- [ ] Write tests: counts 1 and 30 validate; 0, 31, fractions, NaN, invalid seed, and unsupported speed reject. Same seed/config produces identical positions/fuel/IDs. Destination distribution for 10 flights is ALP 4, BRV 3, CHR 3. `travelSeconds(4,240)===60`. Projection serialization contains none of `token`, `workspaceKey`, `inbox`, `outbox`, or raw model input.
- [ ] Run `bun test tests/unit/contracts.test.ts tests/unit/world.test.ts tests/unit/geometry.test.ts tests/unit/projections.test.ts`; verify the expected missing-implementation failures before implementing the behaviors.
- [ ] Implement the schemas, exact constants, seeded generation, and immutable aggregate initialization. Add all specified state fields even when empty. Implement createRun/initialize idempotency, actor registry, phase transitions, worker fencing, and pure redaction. Store the registry/control aggregate under a stable actor ID; per-run entity actors use fresh run IDs. Add expected phase guards for Start/Pause/Resume/Reset.
- [ ] Add actor tests: initialize twice leaves exactly N flights and three airports; stale worker epochs reject; run reset creates new IDs and an old-context mutation cannot change the new run; a crashed initializer resumes its recorded steps. Implement `resetRun` as a persisted saga, not destructive database deletion.
- [ ] Run the unit tests, `bun run actors:generate`, `bun run check`, and `bun run test:integration -- --filter=actors`. Expected all PASS with typed stubs generated. Commit `feat: define durable simulator world and run lifecycle`.

### Task 3: Implement incident activation, resolution, and command ordering

**Files:** Create `packages/domain/src/incidents.ts`, `tests/unit/incidents.test.ts`, `tests/integration/commands.test.ts`. Update actor receive methods, aggregate helpers, and contracts.

**Consumes:** Task 2 schemas and durable aggregates.

**Produces:** `applyIncident(state,input,context):Transition<State>`, `resolveIncident(state,input,context):Transition<State>`, `deriveAirportConditions(state):AirportConditions`, `deriveFlightConditions(state):FlightConditions`, target controller-sequence processing, and durable COMMAND_RESULT outboxes. Use overloads for concrete airport/flight types.

- [ ] Write tests asserting two WEATHER_CLOSED incidents keep ALP closed after clearing only one; RUNWAY_CLOSED R1 leaves R2 available; reduced capacity produces 120-second future occupancy; smoke creates a 900-second deadline; engine trouble creates a 1200-second deadline and 180-knot speed. Assert resolving engine trouble restores speed but not fuel/position.
- [ ] Add tests: LOW_FUEL caps fuel once at 900; duplicate creation after 100 seconds of burn does not reset fuel upward; clearing the incident leaves 800 fuel and derived emergency priority. Same incident ID/different contents rejects. Repeated known clear succeeds idempotently; unknown clear rejects. Clear with stale revision conflicts.
- [ ] Implement each transition with one aggregate assignment containing domain state, inbox result, command result, status notifications, invalidated work, and outbox. Enforce target-kind authorization and command sequence ordering. Preserve resolved incident records. Add tests that sequence 2 clear arriving before sequence 1 create waits and eventually resolves, and delayed repeated create never reactivates it.
- [ ] Implement invalidation: closures revoke affected offers/reservations/clearances and enqueue notices to affected flights; capacity reduction never overlaps existing protected reservations; clearing recomputes effective restrictions and emits a new status revision. A command on a terminal flight rejects with ALREADY_TERMINAL.
- [ ] Run `bun test tests/unit/incidents.test.ts`, regenerate clients, then `bun run test:integration -- --filter=commands`. Expected PASS including restart immediately after application/before result delivery. Commit `feat: add durable incident creation and resolution`.

### Task 4: Implement landing offers, reservations, and negotiation policy

**Files:** Create `packages/domain/src/{scheduling,negotiation,policy}.ts`, `tests/unit/{scheduling,negotiation,policy}.test.ts`. Update actor receive/decision methods and `tests/integration/actors.test.ts`.

**Consumes:** Task 3 effective restrictions, Task 2 world and geometry.

**Produces:** `findLandingOffer(airport,request,context):OfferResult`, `acceptOffer(airport,input,context):Transition<AirportState>`, `advanceNegotiation(flight,message,context):Transition<FlightState>`, `chooseValidAction(input:AgentDecisionInput):AgentDecision`. `OfferResult` is either an Offer or a typed refusal; no free-text-only outcomes.

- [ ] Test slot boundaries: an interval ending at 190 does not conflict with one starting at 190; overlapping intervals reject; runway occupancy includes the 30-second landing grace. With both runways free, choose the earliest achievable grid time, then R1. Closed airport refuses; fuel/deadline-infeasible offer refuses. TTL at `expiresAtWallMs` is expired.
- [ ] Test two simultaneous acceptances cannot consume the same runway/time; duplicate accept returns the same reservation ID. A weather closure between offer and acceptance rejects. A normal initial flight requests its original destination; smoke chooses the nearest feasible offer and uses a farther one only if the nearer cannot meet constraints.
- [ ] Implement pure slot search, tentative holds, expiry, and offer acceptance. Implement emergency preemption exactly as design §6: no preemption inside 120 simulated seconds, of a cleared reservation, or of another emergency. Emit revocations durably before a displaced flight can be forgotten.
- [ ] Implement per-flight rounds, the four-second collection deadline, one pending acceptance, five-second status reconciliation, single active assignment, release obligations, and late-confirmation cleanup. Add tests for a lost LANDING_CONFIRMED, stale offer from a previous round, terminal flight receiving confirmation, and all-airports-unavailable holding. Check clearing weather does not automatically reverse a confirmed diversion.
- [ ] Run `bun test tests/unit/scheduling.test.ts tests/unit/negotiation.test.ts tests/unit/policy.test.ts` and actor integration tests with deterministic clocks. Expected PASS with no overlapping committed intervals. Commit `feat: implement negotiated airport reservations`.

### Task 5: Connect real Relay transport with durable outboxes and inboxes

**Files:** Create `server/src/relay/{transport,agent-relay,router,outbox}.ts` and `scripts/bootstrap-relay.ts`. Expand `tests/integration/relay.test.ts`, commands and actors tests.

**Consumes:** Task 1 proven SDK path, Task 2 identity registry, Task 3/4 actor receive contracts.

**Produces:** Real `RelayTransport`, `routeReceived(message,context):Promise<DomainResult>`, `dispatchDueOutboxes(context):Promise<void>`, identity reconnect, and application ACKs.

- [ ] Write transport contract tests using an injected adapter: sender/recipient mismatch rejects; cross-run message cannot apply; >8192 UTF-8 bytes rejects before parsing; replayed message ID produces one effect; duplicate transport IDs are not used as the domain dedup key. Messages with valid JSON but unauthorized type/role reject.
- [ ] Implement the SDK adapter. Set `baseUrl` explicitly and bind each saved token to its workspace/origin. Register only fresh project identities; reconnect existing ones. Send JSON in `text` with `idempotencyKey=envelope.messageId`. Preserve the SDK's authenticated sender metadata and map to registered entities; never infer sender from payload alone. Prefer per-agent recipient-aware listeners; if a fan-in listener receives multiple copies, route each envelope only to its named registered recipient.
- [ ] Implement persisted outbox polling every 250 ms, application ACK retry/backoff, expiry handling, and sender receipt updates. Do not remove an outbox item on SDK transport acceptance. After actor receive is persisted, emit ACK/result. ACK messages bypass model jobs and are not ACKed themselves. Duplicate incoming messages reissue the stored result/ACK. Reconcile the durable workspace event log at startup/reconnect and every two wall seconds, checkpointing only contiguous events whose relevant actor receive calls have committed. Deduplicate against fast WebSocket delivery. A retry with the same transport idempotency key is not assumed to cause redelivery. Deliver expired controller commands for target-side rejection/sequence consumption; keep unknown outcomes DELAYED. Cleanup/status/ACK/result messages have no application TTL.
- [ ] Add real Relay tests: disconnect a recipient, enqueue an incident, reconnect, and assert one application and one effective acknowledgement; crash after actor apply but before ACK; resend acceptance; replay old status revisions. Bound polling and avoid one subprocess per message. Include all 33 application identities plus controller at the configured maximum and verify only this run's identities participate.
- [ ] Run `bun run test:integration -- --filter=relay` and `bun run test:integration -- --filter=commands`. Expected: real messages and domain acknowledgements recorded, no duplicate effects, no success while disconnected. Commit `feat: route simulator communication through AgentRelay`.

### Task 6: Implement actor-owned LLM agents and transparent fallback

**Files:** Create `server/src/agents/{model,prompts,runner,tools}.ts`, `tests/integration/agents.test.ts`. Update actor work queues and `packages/domain/src/policy.ts`.

**Consumes:** Task 4 policy and allowed actions, Task 5 transport, Task 2 durable job/fence contracts.

**Produces:** `OpenAIModelAdapter`, `RulesModelAdapter`, `runAgentJobs(context):Promise<void>`, actor `claimWork`/`commitDecision`, typed role prompts.

- [ ] Write tests with a fake model: at most four concurrent model calls globally and one per entity; emergencies take precedence over normal queued work; duplicate leased job results apply once; stale decisionRevision rejects; movement-only stateRevision changes do not cause perpetual rejection. Assert fallback events are labeled RULES_FALLBACK.
- [ ] Implement job claiming only after acquiring a model semaphore slot, a 10-second job lease, six-second inference timeout, and max 12 relevant messages. Use one structured decision per job; no unbounded chat/tool loop. Persist job outcomes and selected actions. Scheduling/protocol timers remain deterministic and do not depend on model completion.
- [ ] Implement the official SDK adapter with a strict output schema and configurable `OPENAI_MODEL`. Read the installed SDK's structured-output helper/types at implementation time; pin the concrete API usage in an adapter test. Require credentials/model in live mode and expose a readiness error if absent. Tests and explicit rules mode do not require credentials. Never silently call live mode “ready” when configured for rules only.
- [ ] Implement role prompts: pilot sees its state and replies; ATC sees its own resources and request facts; both return only allowed proposals and a short reason. Build the compact 16-KiB maximum input from design §7, omitting aggregate infrastructure/credentials and bounding message summaries. Validate destinations, capacity, authority, emergency priority, and latest feasibility in actor commit code. Add tests for model-invented airport/slot, refusal to follow a hard closure, invalid JSON, timeout, oversized input, and a delayed result after reset.
- [ ] Run `bun run test:integration -- --filter=agents`; expected all job/fallback/revision tests PASS. Run one opt-in smoke call with the configured live model and record only model name, latency, output schema success, and redacted reason. Commit `feat: run bounded durable pilot and ATC agents`.

### Task 7: Build authenticated API and the phone command path

**Files:** Create `server/src/{main,config,auth,routes,stream,projection}.ts`. Expand `tests/integration/commands.test.ts`, add server test helpers.

**Consumes:** Task 2 registry/projection, Task 3 command receipts, Task 5 controller Relay identity/outbox.

**Produces:** Routes in design §8, `submitIncidentCommand(principal,command):Promise<CommandReceipt>`, run-scoped join sessions, SSE snapshots, and controller results returned through Relay.

- [ ] Write API tests for create/clear with valid roles and exact schemas; reject unauthenticated requests, wrong run, flight incident on airport, extra payload fields, reused command ID with changed content, and controller attempting Reset. Assert 202 means QUEUED and target state is unchanged until Relay delivery.
- [ ] Implement command submission into the SimulationActor ledger/outbox with per-target sequence numbers and stable command IDs. The gateway must have no direct call to target apply/resolve functions. Sign the controller command proof server-side. On COMMAND_RESULT through Relay, update the receipt; use target snapshot reconciliation only to recover a lost result, never to apply the incident.
- [ ] Implement operator setup and controller invitations: issue local operator access through a one-time secret printed by the app startup, persist only a hash/session record, and allow operator to mint 15-minute one-use join capabilities. Exchange URL fragment for HttpOnly session cookie. Add CSRF/origin checks, five-commands/sec/session and 20/sec/run rate limits, and secret redaction. Use Secure cookies under HTTPS; document trusted-LAN behavior for HTTP.
- [ ] Implement full-snapshot SSE at up to four Hz, including immediate receipt/incident updates while paused. Use monotonic projectionVersion; deduplicate actor events by `(entityId,stateRevision,eventIndex)`. Reconnect sends a fresh snapshot. Add tests for disconnected clients releasing subscriptions, role-limited access, stale run session, and no token leakage. Maintain `DELAYED` for uncertain command outcome after 15 wall seconds; reject unapplied expired commands at 60 seconds while still allowing an already-applied duplicate to report success.
- [ ] Run `bun run test:integration -- --filter=commands`, `bun test tests/unit/projections.test.ts`, and `bun run check`. Expected PASS and proof that incident commands traverse real Relay. Commit `feat: add phone-ready simulator command API`.

### Task 8: Implement movement, landing, and crash-safe simulation clock

**Files:** Create `packages/domain/src/flight.ts`, `server/src/simulation/{worker,clock,landing}.ts`, `tests/unit/flight.test.ts`, `tests/integration/{simulation,recovery}.test.ts`. Update clock/actor methods and scripts.

**Consumes:** Task 2 run/fencing, Task 4 reservations, Task 5 messaging, Task 6 agent work, Task 7 projection.

**Produces:** `advanceFlight(state:FlightState,tick:Tick,context:MutationContext):Transition<FlightState>`, `runTick(lease:WorkerLease):Promise<void>`, `attemptTouchdown(context,input):Promise<TouchdownReceipt>`, and a restartable worker process.

- [ ] Write movement tests: 240-knot flight travels 4 NM in 60 simulated seconds; 180-knot engine-trouble flight travels 3 NM; fuel drops by 60 in either case; paused time changes neither. Clamp movement to target instead of overshooting. Holding burns fuel and remains a stable orbit. At zero fuel, transition once to UNRESOLVED.
- [ ] Implement phases and six-NM approach behavior from design §4. Emit a job to request clearance when near the assigned window. Validate clearance against current airport state on every approach tick and again at touchdown. Tests must cover early arrival, missed slot, closure after clearance, arrival at a closed runway, duplicate touchdown, and terminal flight receiving a new offer.
- [ ] Implement the persisted tick saga: begin pending tick, advance airports, advance flights, perform authoritative touchdown, persist per-entity receipts, then complete clock/projection. Entity tick handlers compare tick IDs/target times so a restarted or repeated tick changes fuel/position once. Retry the exact pending tick before starting the next. No wall-clock catch-up after downtime.
- [ ] Implement recovery startup and worker fencing. An airport touchdown receipt survives a crash before the flight is marked landed; recovery reads that receipt before checking a newer closure. Add tests killing the worker after each tick phase and between airport/flight touchdown writes. Require actors to reject expired leases using their own clock; do not allow two live worker epochs to advance one run.
- [ ] Run `bun test tests/unit/flight.test.ts`, `bun run test:integration -- --filter=simulation`, and `bun run test:integration -- --filter=recovery`. Expected one logical effect per tick/landing and a paused/resumable run after dependency failure. Commit `feat: simulate flight movement and recoverable landings`.

### Task 9: Build the main simulator display

**Files:** Create `web/` setup, styles, API/stream hooks, display route and desktop components from file map; create `PRODUCT.md`, `DESIGN.md`, and `tests/e2e/display.spec.ts`.

**Consumes:** Task 7 public snapshots/routes, Task 8 moving world. Use the design skill brief in design §9.

**Produces:** Desktop simulator at `/`, configuration/start controls, map, lists, inspector, timeline, and phone invite display.

- [ ] Document product modes and design tokens in PRODUCT.md/DESIGN.md. Use Impeccable to implement the specified operating interface; use frontend-ui-engineering for components. Keep the fixed map/list/inspector structure and exact semantics from the spec. The skills do not authorize changing the simulator requirements.
- [ ] Implement `api.ts` with typed fetch wrappers and `useRunStream(runId)` with run/version guards, reconnect, and stale-state behavior. Add the E2E test: choose 10 flights, Start, assert three airports and ten flight rows; choose a flight, retain selection through ten updates; old-run frames after Reset must be ignored.
- [ ] Implement SVG map and route styles, flight list/filter/search, airport queue/status markers, entity inspector, and bounded timeline. Interpolate drawing only between known samples, honor reduced motion, and stop extrapolation after two seconds without authoritative frames. Distinguish proposals, confirmations, revocations, and unresolved status with text/icons as well as color.
- [ ] Add operator toolbar/setup and all incident controls using the same command API as the phone. Validate count 1–30, lock count while running, support pause/resume/speed and guarded Reset. Show real dependency health and model/rules-fallback badges. Phone invite is a QR plus copyable URL generated from an operator-issued capability.
- [ ] Run `bun run test:e2e -- tests/e2e/display.spec.ts` and inspect rendered 1440×900 and 1024×768 screenshots. Verify text contrast, keyboard navigation, stable layout, readable queues, and no horizontal overflow. Fix in batches; record screenshots as evidence. Commit `feat: add live airport simulator display`.

### Task 10: Build the mobile incident controller

**Files:** Create `web/src/pages/{Controller,Join}.tsx`, shared IncidentControls/CommandStatus logic, and `tests/e2e/controller.spec.ts`. Update phone styles.

**Consumes:** Task 7 invitations/command lifecycle, Task 9 reusable controls and live stream.

**Produces:** `/control` usable from a physical phone; activation/resolution commands and truthful status display.

- [ ] Add browser tests for joining through a fresh capability, token consumption/fragment removal, airport/flight tabs, runway picker, smoke activation, and per-incident resolution. Assert no incident becomes ACTIVE in the UI merely because POST returned 202.
- [ ] Implement 390×844 layout: searchable entities, scoped incident choices, pending rows, applied/rejected/delayed statuses, and active incidents with explicit Resolve controls. Reuse stable command IDs on network retry. A deliberate new trigger creates a new incident ID; repeat taps on an in-flight trigger reuse the existing command.
- [ ] Implement overlap and low-fuel behavior in the UI: two weather cards can exist; resolving one leaves airport Closed; resolving low fuel preserves fuel urgency and shows the specified explanation. Disable clear until creation is acknowledged; attach current incident revision to the clear request.
- [ ] Test phone disconnection after submit, reconnect snapshot recovery, double tap, another controller resolving the same incident, stale revision, expired invite, and Reset. Invalid sessions cannot affect the new run. Verify every control has a label, visible focus, and at least a 44 px touch target.
- [ ] Run `bun run test:e2e -- tests/e2e/controller.spec.ts`; inspect 390×844 and 768×1024 screenshots; then scan the actual QR on a phone on the same LAN and activate/resolve one airport and one flight incident. Confirm corresponding Relay message IDs and actor results. Commit `feat: add mobile Relay incident controller`.

### Task 11: Verify integrated scenarios, failure recovery, and load

**Files:** Create `tests/integration/scenarios.test.ts`, `tests/e2e/reconnect.spec.ts`, `tests/live/demo.test.ts`, and `docs/acceptance-results.md`. Expand existing recovery tests; fix implementation defects where found.

**Consumes:** Working Tasks 1–10.

**Produces:** Repeatable scenario suite, live-mode evidence, measured performance, and honest readiness status.

- [ ] Build deterministic scenario fixtures using real Terse and real Relay plus rules-mode agents. Exercise normal arrival, Alpha weather closure and diversion, smoke closest-feasible landing, emergency preemption/displaced flight, multiple simultaneous incidents, individual clears, all airports closed, and missed deadlines. Assert final domain state and protocol causality, not exact model wording.
- [ ] Add controlled fault injection at explicit seams: duplicate delivery, delayed/out-of-order message, transport accepted but domain not applied, dropped confirmation, dropped ACK, delayed model result, worker exit between durable write and send, process restart after touchdown, and Reset during negotiation. No test may pass by bypassing the actual Relay receive path for incident commands.
- [ ] Exercise 1, 10, and 30 flights. Assert 3+N domain-agent identities plus one controller identity, global model concurrency ≤4, bounded one-active-job/round per entity, no overlapping runway occupancy, no negative fuel, and at most one active assignment per flight. Temporary old-airport reservation cleanup obligations must converge or be visibly delayed, not silently disappear.
- [ ] Run the live demo test with the configured model and external credentials. Require at least one model-originated pilot proposal and one model-originated ATC proposal, real Relay message evidence, and a complete phone create/clear flow. Record command-to-apply and incident-to-confirmation latencies, fallback rate, and unresolved reasons. Mark a skipped live test as NOT RUN, never PASS.
- [ ] Run `bun run check`, `bun test tests/unit`, `bun run test:integration`, `bun run test:e2e`, and `bun run test:live`. Record timestamps, mode, versions, seed, count, achieved latency percentiles, and remaining failures in acceptance-results.md. Expected functional gates PASS; measure readiness targets honestly. Commit `test: verify simulator scenarios and recovery`.

### Task 12: Package launch, deployment, and demo handoff

**Files:** Complete `scripts/{dev,doctor,demo-reset}.ts`, root scripts, README, `.env.example`, `docs/{deployment,demo-runbook,acceptance-results}.md`.

**Consumes:** Task 11 validated app and integration evidence.

**Produces:** Reproducible launch/runbook, laptop and single-VM deployment instructions, and a demo another person can operate.

- [ ] Implement root commands with exit codes and clear readiness diagnostics. `doctor` checks versions, actor connection, configured Relay origin/workspace, token-store permissions, selected model configuration, and port availability; it prints no secrets and kills no processes. `dev` starts only project-owned processes, shuts them down on exit, and retains durable data.
- [ ] Document environment keys: `APP_HOST`, `APP_PORT`, `PUBLIC_APP_ORIGIN`, `TERSE_ACTOR_URL`, optional `TERSE_API_KEY`, `RELAY_BASE_URL`, `RELAY_WORKSPACE_KEY`, `RELAY_TOKEN_STORE_PATH`, `SESSION_SECRET`, `COMMAND_SIGNING_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL`, and `AGENT_MODE=live|rules`. Explain which must persist across restarts. Never put real values in .env.example.
- [ ] Document the exact actor start/generation commands verified in Task 1. Include production `bun run build` and `bun run start`, a separately supervised worker, persistent data directories, and a single-VM reverse proxy/HTTPS configuration. The frontend's public origin must match the phone's reachable address. Keep actor and Relay services private. Record the verified engine provisioning command/version from integration-evidence.md rather than inventing a hosted API endpoint.
- [ ] Write the demo runbook below with actual UI names and recovery steps. From a fresh terminal, use README alone to start the app, open a physical phone, run the scenario, restart the worker, and reset. Verify the built frontend rather than relying solely on Vite development behavior.
- [ ] Run final `bun run doctor`, `bun run check`, relevant production smoke tests, and the demo walkthrough. Attach screenshots and acceptance-results.md; list any incomplete gate explicitly. Commit `docs: package simulator launch and demo handoff`. Do not claim completion if real Relay, real actors, or the phone create/clear flow remain unverified.

## 5. Required API examples

These are application payloads, not direct Relay vendor API calls. The gateway derives authority and ordering; the browser cannot supply them.

Create weather incident:

```json
{
  "commandId": "<uuid>",
  "runId": "<active-run-uuid>",
  "type": "INCIDENT_CREATE",
  "payload": {
    "incidentId": "<uuid>",
    "target": "airport:ALP",
    "kind": "WEATHER_CLOSED",
    "parameters": {}
  }
}
```

Resolve that incident:

```json
{
  "commandId": "<new-uuid>",
  "runId": "<same-run-uuid>",
  "type": "INCIDENT_CLEAR",
  "payload": {
    "incidentId": "<original-incident-uuid>",
    "target": "airport:ALP",
    "expectedIncidentRevision": 1
  }
}
```

Create smoke by using `target:"flight:F001"`, `kind:"SMOKE"`, and empty parameters. Do not repurpose the weather incident ID for smoke. A clear command removes the active condition's contribution but does not delete the incident, refill fuel, rewind time, or force a route change.

## 6. Acceptance checklist

- [ ] Configuration supports 1–30 flights with deterministic seeded initial conditions and validates invalid input.
- [ ] Three ATCs and every configured flight have distinct logical agents, Relay identities, and durable state.
- [ ] A phone can activate and resolve every specified incident type through real Relay.
- [ ] UI distinguishes queued/sent/delayed/applied/rejected command states and active/resolved incident states.
- [ ] Total weather closure prevents arrival and causes affected flights to negotiate with other airports.
- [ ] Smoke requests and confirms the nearest feasible airport subject to capacity, deadline, and fuel.
- [ ] Simultaneous diversions cannot double-book a runway; offers, acceptance uncertainty, releases, and expiry are handled.
- [ ] Emergency preemption notifies displaced flights and preserves protected clearances/occupancy.
- [ ] Clearing one incident preserves other active restrictions; clear low fuel does not refuel.
- [ ] Movement and fuel are deterministic; pause, speed, deadlines, holding, and landings follow the defined time domains.
- [ ] Closures during approach are checked against authoritative actor state before landing.
- [ ] Worker restart recovers pending commands, offers, work, ticks, and touchdown without duplicate effects.
- [ ] Reset isolates the new run from every old message/job/timer.
- [ ] Browser reconnect recovers a full snapshot and never displays stale data as live.
- [ ] Mobile access is scoped to the active run; tokens and private state remain server-side.
- [ ] Live-mode pilot and ATC decisions are demonstrated, with any rules fallback visibly labeled.
- [ ] Desktop and phone layouts are verified at the specified sizes and the actual phone works on the demo network.
- [ ] Launch/runbook works from a fresh terminal; acceptance-results.md distinguishes PASS, FAIL, and NOT RUN.

## 7. Demo runbook template

1. Run doctor; confirm real actor/Relay readiness and live model mode. Open main display and join from the phone using a fresh invitation.
2. Configure 10 flights, seed 20261031, speed 10×. Start and wait for initial landing negotiations to appear.
3. Pause if needed to explain the display. Activate WEATHER_CLOSED at Alpha from the phone. Show pending → applied, airport Closed, and ATC notifications followed by flight requests/offers/refusals.
4. Resume. Select a flight still airborne that originally targeted Alpha. Trigger SMOKE. Show its nearest-feasible comparison and confirmed urgent destination; explain any refusal from a closer airport using the actual reason.
5. Resolve Alpha's weather incident. Show airport availability restored while committed diversions remain intact. Resolve smoke and show priority recomputed without teleportation or fuel restoration.
6. Restart the worker. Show RECOVERING and unchanged durable positions/commitments, then resumed operation. Do not kill or restart unrelated Relay sessions.
7. Show command/message IDs and the short decision reasons for one successful diversion. If a model fallback occurred, identify it accurately.
8. Reset and optionally select 30 flights for the load view after the primary demonstration succeeds.

## 8. Delivery order and hackathon budget

The complete specification is deliberately more rigorous than a five-hour prototype. Treat the following as an execution budget, not a promise that untested integration will fit it:

| Timebox | Deliverable |
|---|---|
| First 30 minutes | Task 1 plus core contracts; decide whether required integrations work |
| Next 90 minutes | Durable incidents, Relay commands, booking protocol, minimal rules-mode world |
| Next 60 minutes | Live pilot/ATC jobs, clock, and map/display |
| Next 45 minutes | Phone join, create/resolve controls, end-to-end primary scenario |
| Final 75 minutes | Recovery/edge-case fixes, real-phone verification, live-mode rehearsal, packaging |

If time compresses, implement WEATHER_CLOSED and SMOKE first, at 10 flights, with three airports and the actual phone→Relay→actor path. This is a milestone only, not completion of the full project. Keep the other incident types, 1–30 support, and acceptance gates explicitly tracked as remaining work. Drop optional separate organizational agents, decorative animation, internet hosting, and extra analytics before compromising required communication, durable state, or truthful status.

Do not quietly replace the real path with a scripted animation for judging. Rules mode is an explicitly labeled test/fallback mode; the final agent demonstration must include real model decisions and real Relay messages.

## 9. Handoff state

At the time this plan was written, only the design and implementation documents were created. Existing setup notes describe independent Terse and Relay probes; this plan's integration, simulation, UI, and acceptance tasks remain unchecked. No application tests in this plan have been executed because the application does not yet exist.

Hand the implementer both linked documents and the existing `haunted-hacks-setup/` examples. The next action is Task 1. For the fastest hackathon execution, keep one implementer responsible for shared contracts and backend sequencing; after those interfaces settle, a separate authorized implementer can work on the display/controller without changing the protocol.
