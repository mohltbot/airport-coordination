# Integration evidence

Task 1 (Terse and Relay seams) and the Task 2 actor checks, recorded on 2026-10-31 between 12:10 and 12:40 PT on the build laptop (macOS arm64). No secrets appear here. The Relay workspace key and agent tokens live in `.env` and `.data/relay-tokens.json`, both gitignored and mode 0600.

## Versions

Every version pinned in the plan exists on npm and was installed exactly. No substitutions were needed.

| Package | Pinned | Installed |
|---|---|---|
| Bun | 1.4.4 | 1.4.4 |
| Terse CLI | 0.14.9 | 0.14.9 (logged in, org MOSI) |
| terse-sdk | 0.14.9 | 0.14.9 (durable-actors 0.14.6) |
| @agent-relay/sdk | 15.0.0-next.10 | 15.0.0-next.10 |
| @relaycast/sdk (transitive) | 8.16.0 | 8.16.0 |
| openai | 6.26.0 | 6.26.0 |
| zod | 4 | 4.6.7 |
| typescript | 5.9.3 | 5.9.3 |
| @types/bun | | 1.4.4 |

## Endpoints

- Terse local runtime: `http://127.0.0.1:7100`. It binds loopback only. The client URL must include the project path, `TERSE_ACTOR_URL=http://127.0.0.1:7100/v1/projects/local/actors`. A bare `host:port` is rejected by `terse actor generate`. The project ID is `local`, even though `actors/terse.config.json` is present.
- Relay: hosted Relaycast. The SDK `baseUrl` is the bare origin `https://cast.agentrelay.com`, because the SDK appends `/v1` and builds `/v1/ws` itself. Raw REST calls use `https://cast.agentrelay.com/v1`. The simulator uses its own dedicated workspace (`ghost-tower-<stamp>`), separate from the smoke-test workspace and the coding agents' `main-airport-coordination` workspace.

## Commands

```sh
cd atc-simulator
bun install
bun run actors:dev                                  # terse actor dev in actors/, port 7100
bun run actors:generate                             # writes server/generated (gitignored)
bun run test:integration -- --filter=bootstrap      # Terse probe and Relay SDK probe
bun run test:integration -- --filter=actors         # Task 2 actor checks against 7100
bun test tests/unit/contracts.test.ts tests/unit/world.test.ts tests/unit/geometry.test.ts
```

## Terse results

`tests/integration/terse.test.ts` runs 3 tests: 3 pass, 0 fail, 15 s. It starts its own runtime on port 7199 from `.data/terse-probe`, so it can SIGKILL and restart that runtime without touching the simulator runtime on 7100.

- One aggregate `{count, processedIds, outbox}`, written in one assignment, survives a runtime restart with all three fields together. Replaying the same operation ID leaves count 1 and outbox length 1. PASS.
- A call killed after it completed is kept, and the same-ID retry is a duplicate. PASS.
- A call killed mid-flight (SIGKILL during a 4 s hold, before the write) gives the caller an error. After restart, the read showed the operation **applied** (count 1). The runtime finished the interrupted call itself. The outcome of a failed call is therefore uncertain, not "not applied". Every actor mutation dedupes by operation or message ID, and callers retry with the same ID. With that dedupe, the retry applied exactly once. PASS.
- Durable state lives under `actors/.durable-actors/`. Alarms are kept in memory and are lost when `terse actor dev` restarts, so persist the alarm time and re-arm on the next call. This was measured earlier today on the smoke-test project.

### Terse 0.14.9 constraints found while building

1. Actor IDs allow only letters, digits, dots, underscores and hyphens, up to 128 characters. The plan's `<runId>/airport/ALP` cannot be used, so `entityActorId()` returns `<runId>.airport.ALP` and `<runId>.flight.F001`.
2. The actor compiler builds declarations with NodeNext resolution. Relative imports in `actors/` and `packages/domain/src` must end in `.js` (`"./contracts.js"`). Both `.ts` (TS5097) and extensionless imports (TS2835) fail the build. Tests and server code may keep `.ts`.
3. A workspace package that is reachable from an actor's public types must declare a `version`, so `@ghost-tower/domain` is `0.1.0`.
4. `terse actor generate` copies helper-function bodies into its declaration bundle and fails ("An implementation cannot be declared in ambient contexts"). Schema factories must not sit behind types used in actor method signatures, so the two envelope unions in `contracts.ts` are written out member by member.
5. `terse actor dev` watches `actors/src` only. After editing `packages/domain`, touch `actors/src/actors.ts` so the runtime rebuilds before you regenerate clients.
6. Sync methods on an actor class throw, so pure logic lives in module functions (`simulation.ts`, `entity.ts`, `durability.ts`). Persisted aggregates are always reassigned, never mutated.
7. Only one dev runtime can bind a given port. The smoke-test runtime from `actor/` was stopped so this project could take 7100.

## Relay results

`tests/integration/relay-sdk-probe.test.ts` (helper `server/src/relay/probe.ts`) runs 5 tests: 5 pass, 0 fail, 146 s on the first run and 103 s on the rerun. Two dedicated identities, `ghost-probe-a-*` and `ghost-probe-b-*`, were used. The probe sent nothing from any coding-assistant identity.

The SDK calls that worked:

- `new AgentRelay({ workspaceKey, baseUrl: 'https://cast.agentrelay.com', onError })`. Use one `AgentRelay` instance per agent, because the listener stream merges every agent registered on that instance.
- `relay.workspace.register({ name, type: 'agent' })` returns a client with `.name`, `.token` and `.sendMessage`. Registration is create-only, and an existing name returns 409 `name_conflict`.
- `relay.workspace.reconnect({ apiToken })` restores the identity from a saved token.
- `client.sendMessage({ to: '@name', text, idempotencyKey })`.
- `relay.addListener('dm.received', ev => …)`. The authenticated sender is in `ev.message.from.name` (also `ev.envelope.from.name`), the text in `ev.message.text`, and the ID in `ev.message.messageId`. A sender does not receive its own DM.

What the probe established:

- A sends a UUID marker to B, B sees A as the authenticated sender and replies, and A receives the reply. The same exchange works again after both identities reconnect from saved tokens. PASS.
- Sending twice with the same idempotency key returned the same messageId in 0.45 s. B's listener fired once, and the event log holds the message once. A retry with the same key is not a redelivery, which is why the workspace event log must be reconciled. PASS.
- Lost-callback recovery: with no listener attached, the message was found in the durable event log 9.4 s after the send started. PASS.
- The event log is read over raw REST. The SDK reads it only with an `ot_live` observer token. Request: `GET /v1/workspace/events?since=<seq>&limit=<n>` with the workspace key as Bearer. Response: `data.{events, latest_seq, next_since}`. Each event is `{seq, type, channel_id, payload, created_at}`, and a DM payload is `{id, type, created_at, conversation_id, message}`. `since` is exclusive (`since=seq-1&limit=1` returns exactly that event). `seq` only increases, and paging at `limit=2` worked. Connects and disconnects also write `node.status.online/offline` rows. PASS.
- Redaction: the serialized probe results contain none of the token or key strings. PASS.

Limitation: `metadata` on a DM is dropped. It is null in both the listener event and the event log. The protocol envelope therefore travels as JSON in `text`, which matches the plan.

### Measured latency on hosted Relay

| | Fresh agents | After reconnect |
|---|---|---|
| Send call returns | 8.1 s | 26.3 s |
| Send start to B's callback | 9.7 s | 29.7 s |
| Reply send / A's callback | 4.9 s / 6.5 s | 10.3 s / 11.3 s |
| In event log after send returned | 0.8 s | 2.8 s |
| Register both / reconnect both | 5.5 s | 4.1 s |

Earlier smoke-test measurements: 2.5 to 4 s per send, 3 to 7 s until a message appears in `/workspace/events`, push subscriptions 6 s or more, and occasional `503 database_overloaded` (none during the probe runs). These numbers are why `RELAY_TIMING.HOSTED` in `constants.ts` widens the spec's 4 s reply window to 30 s, the offer TTL to 90 s and the acceptance timeout to 30 s. `RELAY_TIMING.LOCAL` keeps the spec values.

## Task 2 actor checks

`tests/integration/actors.test.ts` runs 5 tests against the real runtime on 7100: 5 pass, 0 fail, 4.3 s. Each test uses its own `SimulationActor` ID and never touches the demo registry `ghost-tower`.

- `createRun` is idempotent per request ID. Configuring again while CONFIGURING edits the same run in place, keeping its runId (the agreed API rule). A reused request ID with a different config gets `REVISION_CONFLICT`.
- Initializing twice leaves exactly N flights and three airports, and the second pass returns `DUPLICATE` from every actor.
- A crashed initializer resumes from its recorded steps. Airports are not re-initialized, and the run cannot leave STARTING until READY.
- Stale worker epochs are rejected. A second claim during an unexpired lease is refused, and a forged token on renew is refused. An entity adopts a newer epoch and then rejects the older one, as well as the same epoch with another token. A repeated tick ID is a `DUPLICATE`.
- Reset creates a new run ID and keeps the old run as RESETTING. The registry rejects the old run with `WRONG_RUN`. An old-run context against a new-run actor is rejected with `WRONG_RUN` and leaves its state unchanged.

## Not covered here

- Entity `receive`, `claimWork`, `commitDecision`, clearance and touchdown behavior belong to Tasks 3 to 8 and are tested in their own suites.
- The probes measure the seams only. The integrated scenarios and the live-model run are Task 11.
