# Acceptance results

Integration runs on 2026-10-31, 12:32 to 13:53 PT, on the build laptop (macOS arm64). Bun 1.4.4, Terse 0.14.9 local runtime on 127.0.0.1:7100, seed 20261031, speed 5x. Relay was hosted Agent Relay (cast.agentrelay.com, dedicated simulator workspace) until 13:30, then Agent Relay's local engine (`@relaycast/engine@12.3.0` on 127.0.0.1:8787, approved by Agent Relay for the demo) with the LOCAL timing profile.

Every run used the real path: the API gateway on :3000 in actor mode, the SimulationActor command ledger, the worker's Relay outbox, Relay, then the target AirportActor or FlightActor. No fixture data and no in-memory stand-in for Terse or Relay.

Command latencies run from the HTTP 202 to the state change in the public snapshot, which was polled once a second. Relay hop latency runs from the sender actor's outbox write to the recipient actor's inbox record, read from actor state.

## Summary

| Gate | Result | Evidence |
|---|---|---|
| API in actor mode serves real SimulationActor snapshots | PASS | Run 47ff7428: 3 airports, 10 flights, actor stateRevision 1 after Start |
| Start runs the init saga | PASS | CONFIGURING, STARTING, PAUSED in 1 to 3 s with five INIT_STEP events |
| Configure in place while CONFIGURING | PASS | Run 966e4ede went from 10 to 3 flights with the same runId |
| Normal arrival over Relay | PASS | Hosted, 3 flights: request, offer, confirm, clearance, approach, LANDED. Local engine, 10 flights: all confirmed 3 s after resume |
| WEATHER_CLOSED through Relay | PASS | Hosted: ALP CLOSED 12 s after submit, receipt APPLIED at 34 s |
| Closure diverts the affected flight | PASS | Hosted: F001 revoked, held, confirmed at BRV 129 s after the command |
| SMOKE through Relay | PASS | Hosted: applied at 5 s, receipt APPLIED at 7 s. Local (Bay demo): applied in about 1 s |
| Smoke finds the nearest feasible airport | PASS | Bay demo, local engine: MRY refused ("runways R1 and R2 closed"), SJC offered 1 s later, confirmed 2 s after the smoke command, clearance granted |
| Smoke with no feasible airport is truthful | PASS | Hosted: F001 more than 60 NM from every open airport, round returned NO_FEASIBLE_AIRPORT under the 900 s deadline |
| Clear both incidents | PASS | Hosted: both RESOLVED 29 s after submit; ALP OPEN; F001 kept its BRV commitment, priority back to NORMAL |
| Reset isolates the new run | PASS | Worker left the old lease with WRONG_RUN at the reset and claimed the new run |
| US network (14 towers) initializes | PASS | Runs ed4c9e6c, e1189ee6, 21665363, 2ff45d99: 10, 13, 13 and 14 airports in the snapshot |
| Live OpenSky callsigns | PASS | Run 2ff45d99: "[opensky] fetched 3345 airborne airline flights", callsigns UAL1160, AAL1492, SWA3473, DAL1070, config.liveTraffic set |
| Live model decisions | PASS | Run 21665363 (hosted): 18 ATC proposals from the model; pilots 4 from the model, 3 labeled RULES_FALLBACK. Bay runs b08768c0 and 955823f7 (local engine): every featured-flight and tower offer decision from the model |
| Bay Area demo with live model, local engine | PASS | 5x: smoke to touchdown 217.5 s. 10x: 138.0 s. MRY refused in under 2 s, SJC confirmed in 5.5 to 7.3 s |
| Worker crash (SIGKILL) mid-run | PASS | Running again 11 s later on a new epoch; state unchanged while no worker ran |
| Actor runtime restart mid-run | PASS | 29 s outage; sim time, tick and every flight's revision, position, fuel and assignment identical afterwards; no catch-up jump |
| Health is truthful | PASS | Actors UNAVAILABLE during the runtime outage; relay DEGRADED with failure counts on hosted; READY "Agent Relay (local engine)" after the switch |
| 10 flights on hosted Relay | FAIL | Hosted Relay saturated: 429 workspace_busy, 429 workspace_delivery_depth_exceeded, 503 database_overloaded; hops p50 20 s, max 108 s |
| Continuous traffic: landing then replacement departure | NOT RUN | Hosted runs never reached a landing; the local run was reset for the Bay demo first |
| Weather and smoke on the local engine | NOT RUN | Waiting for the floor after the Bay demo |
| `bun run test:integration`, `test:e2e`, `test:live` | NOT RUN | Unit tests (183) and the simulation and recovery integration files (15) pass |

## Relay: hosted against local engine

| Measure | Hosted Relay | Local engine |
|---|---|---|
| Identity setup for a fresh run | 38 to 137 s (25 identities) | 2.7 s (25 identities) |
| Worker Relay setup with saved identities | 2 to 8 s | 0.3 s |
| Delivery hop p50 / p90 / max | 20 / 39 / 108 s | 0.5 / 0.6 / 0.7 s (n=17) |
| Send failures | 80 to 220 a minute at 10 flights (503 database_overloaded, 429 workspace_busy) | 0 |
| 10 flights, request to confirmed | Mostly never: offers expired before delivery | All 10 in 3 s |

Hosted Relay also failed with nothing of ours running: at 13:07 every endpoint, reads included, answered 503 database_overloaded.

Root cause of `workspace_delivery_depth_exceeded`: Relaycast keeps a durable delivery queue per agent (GET /v1/deliveries, POST /v1/deliveries/{id}/ack). Our identities read the workspace event log and never acked deliveries. The first run posted to one shared channel with 14 members and left 481 unacked deliveries (31 to 37 per identity). Runs after the per-sender channel change show 0 pending.

## Primary scenario on hosted Relay, rules mode, 3 flights (run 966e4ede)

| Step | Wall time | Elapsed |
|---|---|---|
| Resume; INITIAL landing requests sent | 12:51:21 | |
| First offers created (ALP, BRV) | 12:51:25 | +4 s |
| Offers accepted | 12:51:33 | +12 s |
| F001 confirmed at ALP R1, slot 720 | 12:51:44 | +23 s |
| WEATHER_CLOSED ALP submitted (HTTP 202) | 12:51:49 | 0 |
| Receipt QUEUED | 12:51:50 | +1 s |
| Receipt SENT | 12:52:00 | +11 s |
| ALP CLOSED, F001 reservation revoked | 12:52:01 | +12 s |
| Receipt DELAYED (15 s threshold) | 12:52:15 | +26 s |
| F001 opens a diversion round to BRV and CHR | 12:52:15 | +26 s |
| Receipt APPLIED | 12:52:23 | +34 s |
| CHR refuses (UNREACHABLE), BRV offers R1 at 1890 | 12:52:39 | +50 s |
| BRV confirms; F001 rejects it at revalidation (INFEASIBLE_CONFIRMATION) | 12:53:37 | +108 s |
| F001 confirmed at BRV R1, slot 2130 | 12:53:58 | +129 s |
| SMOKE F001 submitted | 12:54:37 | 0 |
| Receipt SENT | 12:54:41 | +4 s |
| F001 EMERGENCY, incident ACTIVE | 12:54:42 | +5 s |
| Receipt APPLIED | 12:54:44 | +7 s |
| F002 LANDED at BRV | 12:56:50 | |
| F003 LANDED at CHR | 12:57:12 | |
| Clear ALP weather and F001 smoke submitted | 12:57:38 | 0 |
| Both incidents RESOLVED, ALP OPEN, F001 NORMAL | 12:58:07 | +29 s |
| Smoke clear receipt APPLIED | 12:58:28 | +50 s |
| Weather clear receipt APPLIED | 12:59:07 | +89 s |

The incident takes effect before its receipt reaches APPLIED, because COMMAND_RESULT returns through Relay as its own hop. Receipts show SENT and then DELAYED meanwhile, and the UI shows those states.

## Bay Area demo on the local engine (run 4626010a, scenario agent)

Config: US network, focusRegion BAY_AREA, emergencyCandidateMode SEQUENTIAL, featured flight F001 (SKW3346), OpenSky callsigns.

| Step | Wall time |
|---|---|
| RUNWAY_CLOSED R1 and R2 at MRY queued | 13:30:59 |
| MRY results APPLIED | 13:31:00 to 13:31:03 |
| SMOKE on F001 queued | 13:31:05 |
| SMOKE applied, MRY refuses "runways R1 and R2 closed" | 13:31:05 |
| SJC offers R2 at T+11:00 | 13:31:06 |
| SJC confirms R2 | 13:31:07 |
| SJC clears F001 to land in its window | 13:35:15 |

## Bay Area demo with live model decisions, local engine

`bun run demo:bay-emergency -- --speed 5|10 --flights 10 --featured F001`, worker `AGENT_MODE=live bun run worker:local-relay` (LIVE_LOCAL timing), gpt-5.4-mini. Seconds after the SMOKE submit:

| Step | 5x, run b08768c0 | 10x, run 955823f7 |
|---|---|---|
| Smoke applied | 2.4 | 1.3 |
| Mayday to MRY | 1.6 | 1.4 |
| MRY refuses ("runways R1 and R2 closed") | 1.9 | 1.6 |
| Mayday to SJC | 2.8 | 2.1 |
| SJC offers | 4.9 | 3.7 |
| F001 accepts | 6.6 | 5.3 |
| SJC confirms | 7.3 | 5.5 |
| Clearance granted | 81.8 | 67.0 |
| Touchdown at SJC | 217.5 | 138.0 |

Decision sources in run b08768c0: SFO and SJC PROPOSE_OFFER, and F001's REQUEST_LANDING, two SELECT_OFFER and REQUEST_CLEARANCE, all MODEL. Example reasons: "SJC has a feasible offer and is the closest available landing option."; "Held slot is available on R1 at 330s, and arrivals are open." MRY's refusal is the closed-runway rule. Relay message IDs for the exchange: Mayday to MRY 242388723286163456, MRY refusal 242388726922625024, Mayday to SJC 242388728860393472, SJC offer 242388737320304640, accept 242388746107371520, SJC confirm 242388747600543744, clearance 242389059505766400.

The earlier rules-mode Bay runs (4626010a, a9f85ce6) took 389 s from smoke to touchdown at 5x. A worker that claims a reset run before Start configured actors that did not exist yet, so they kept the HOSTED 450 s slot lead and rules decisions; 92e36b5 fixes it.

The effective sim rate is about 2x at the 5x setting and 2.8x at 10x, because the worker advances each of 24 entities with its own actor call every tick.

## Restarts (run 21665363, 13 US towers, hosted Relay)

| Fault | Down | Recovery | State check |
|---|---|---|---|
| `terse actor dev` killed (SIGTERM) | 13:23:47 to 13:24:16 | Worker took epoch 32 and resumed ticking | Sim 732.5 s, tick 586 and all 10 flights identical before and after; no catch-up for the downtime |
| Worker SIGKILL | 13:25:05 | Running 11 s later (waits for the old 10 s lease) | Sim 845 s and tick 676 unchanged while no worker ran |
| Worker graceful restart | 13:20:29 | 13 s | |

## Live model decisions (run 21665363, gpt-5.4-mini, about 1.5 minutes)

The worker restarted with `AGENT_MODE=live` (JOB decision mode). The first ATC proposal from the model came 6 s after it configured. In the window: 18 ATC proposals from the model, 4 pilot proposals from the model and 3 pilot RULES_FALLBACK, all labeled in the timeline. Examples: ORD "Held slot available on R1 at 1950s; earliest valid offer."; F007 "Requesting slots from required candidates in order; original destination first." The run was on hosted Relay, so offers still arrived late. The worker went back to rules mode afterwards to limit cost.

## Performance

- SimulationActor calls at 23 entities: p50 303 ms, p90 784 ms, 0.55 ticks a second before 52f3745; p50 11 ms, p90 71 ms, 1.6 ticks a second after.
- Effective simulation rate at the 5x setting: about 2x at 10 flights and 13 to 14 towers. Each tick still advances every entity in its own actor call.

## Defects found and fixed

| Commit | Change |
|---|---|
| 3a71752 | Start runs initializeRun and moves to PAUSED (it only set STARTING). CONFIGURING snapshots preview the seeded world. Worker projection publisher added. Health reports real status. |
| 4c00428 | Worker renews its lease during Relay setup. 55 s of registration against a 10 s lease made every epoch expire before its first tick. |
| 5b8fccb | Flights open their INITIAL landing round on the first tick. Nothing fired that trigger, so no flight ever requested a landing. |
| f7ab42d | One-member channel per sender (no fan-out), 4-slot send pool shared with DOMAIN_ACKs, 3 s pause after a 429, worker failure logging. HOSTED reply window 60 s, accept timeout 45 s, offer TTL 120 s. |
| c8c2480 | HOSTED booking budget 90 s (slot lead 450 sim s at 5x); an 80 s booking failed its confirmation recheck. |
| a936450 | One Relay identity per entity ID, reused across runs. |
| cbf1252 | Gateway snapshots keep airportNetwork and continuousTraffic. |
| b6b39e5 | Relay setup runs 2 at a time with 2 to 16 s backoff. |
| 52f3745 | One batched tick-ack write per tick; reset drops fenced runs' snapshots from the root; the gateway reads only the fresh published projection. |
| d6de424 | Relay event-log cursor persisted across worker restarts. |
| ee90aae | Relay health from the last 60 s of sends and deliveries. |
| 774c88d | `bun run relay:local` and `bun run worker:local-relay`: one-command switch to the local engine, hosted settings kept in .env. |
| 92e36b5 | Configure retries until every actor exists (it was marked done on rejection); LIVE_LOCAL timing for the local engine with model decisions; agentMode and model health report the mode the actors accepted; flights keep acknowledged outbox entries so the pilot's own messages stay in the radio log. |

`.env` (not committed) sets `RELAY_ACK_RETRY_BACKOFF_MS=15000,30000,60000` and `RELAY_ACK_RETRY_STEADY_MS=60000` for hosted. `.env.local-relay` sets the LOCAL schedule (500 ms to 4 s).

The HOSTED timing changes differ from the agreed table in docs/coordination/frontend-backend-contract.md. The browser reads offer expiry from `expiresAtWallMs`, so no UI change was needed.

Merged and cherry-picked from codex/us-map: 1903697 (bd0b9fd), a12123e (0c040bf), 0d44e17 (aab0e71), 274863c (36a307b), 1466c4b (d788607), 91b7283 (8d9382b).

## Open

- Continuous traffic landing followed by a replacement departure: not yet observed.
- Weather closure with diversions at 10 flights on the local engine.
- Tick throughput: about 1.6 to 2.8 ticks a second at 24 entities, below the 4 Hz scheduler.
- Full `test:integration`, `test:e2e` and `test:live` runs.
- Physical-phone create and clear on the demo network (UI owner).
