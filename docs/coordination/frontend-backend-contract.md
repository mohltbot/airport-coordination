# Frontend and Backend Coordination Contract

Status: work split agreed over Relay; browser wire details await Claude's explicit acceptance or amendments. This records implementation coordination, not authorization to start frontend implementation. The existing design and implementation plan remain the product requirements.

## Ownership

| Owner | Files and responsibility |
|---|---|
| Mohammed / Claude | Tasks 1–8 and backend/integration portion of Task 11; `atc-simulator/packages/`, `actors/`, `server/`, `scripts/`, root package/config/lock files, integration/unit/live tests |
| Siddharth / Codex | Tasks 9–10; `atc-simulator/web/`, display/controller/reconnect browser tests in `atc-simulator/tests/e2e/`, UI verification |
| Codex, with announcement | `atc-simulator/DESIGN.md` and this coordination document |
| Claude, with Codex input | `atc-simulator/PRODUCT.md`, other application docs, root startup scripts, frontend dependency additions affecting root lockfile, final deployment and demo packaging in Task 12 |

Announce `taking <file>` before touching files outside the owned area. Do not edit another owner's files without their acknowledgment. Share small commits on main as proposed by Claude, fetch/rebase before push, never force-push, and preserve unrelated changes. A contract change requires a Relay message and agreement before dependent implementation. Use committed files for long details; Relay carries concise decisions and commit IDs.

Codex can build the UI with shared fixtures while backend endpoints are being completed. Fixtures must be explicitly labeled development data and cannot masquerade as live agent activity. Integration acceptance requires the real actor/Relay path.

## Contract ownership and version

Claude owns the authoritative Zod schemas and inferred public types in `atc-simulator/packages/domain/src/contracts.ts`. Export public/browser-safe types separately from internal aggregates. Codex imports these definitions rather than creating competing schemas.

Proposed wire `schemaVersion` is 1. JSON uses camelCase, IDs are strings, absent optional values are `null` where listed, collections are arrays, and all timestamps name their clock domain. No raw actor aggregate, token, job lease, or inbox/outbox enters browser payloads.

Claude will commit `atc-simulator/tests/fixtures.ts`, exporting `samplePublicSnapshot` with ten flights, three airports, and an active WEATHER_CLOSED incident. Please also include one emergency flight, one pending command, one resolved incident, and one refusal event in that fixture or additional named fixtures. Fixtures must parse against the public snapshot schema. Codex will use these exact fixtures for UI work until live endpoints are ready.

## Public snapshot proposal

`PublicSnapshot` has these required fields:

| Field | Shape |
|---|---|
| `schemaVersion` | `1` |
| `runId` | string |
| `projectionVersion` | increasing integer within the run |
| `phase` | CONFIGURING / STARTING / PAUSED / RUNNING / COMPLETED / RESETTING |
| `simTimeSec` | number |
| `serverWallTimeMs` | number, for freshness display |
| `config` | `{flightCount:number,seed:number,speed:1\|5\|10}` |
| `airports` | `PublicAirport[]` |
| `flights` | `PublicFlight[]` |
| `incidents` | `PublicIncident[]`, includes resolved incidents |
| `commands` | `CommandReceipt[]`, includes recent terminal receipts |
| `timeline` | last 200 `TimelineEvent[]`, oldest first |
| `health` | `{actors:DependencyHealth,relay:DependencyHealth,model:DependencyHealth,worker:DependencyHealth}` |
| `agentMode` | `live` / `rules` |

`DependencyHealth={status:'READY'|'DEGRADED'|'UNAVAILABLE',detail:string|null}`. Recovery is displayed through worker health; it does not invent a new run phase.

`PublicAirport`:

- `entityId` (`airport:ALP`), `airportId` (`ALP`), `name`, `position:{x,y}`.
- `status:'OPEN'|'RESTRICTED'|'CLOSED'`, `statusReason:string|null`, `stateRevision:number`.
- `runways:Array<{runwayId:string,status:'OPEN'|'CLOSED'|'OCCUPIED',occupiedUntilSimSec:number|null}>`.
- `queue:Array<{reservationId:string,flightId:string,runwayId:string,slotStartSimSec:number,status:string,priority:'NORMAL'|'EMERGENCY'}>`; sorted by slot start, then runway ID.

`PublicFlight`:

- `entityId` (`flight:F001`), `flightId`, `callsign`, `position:{x,y}`, `headingDeg:number`, `speedKnots:number`, `fuelRemainingSec:number`.
- `phase:'ENROUTE'|'HOLDING'|'APPROACH'|'LANDED'|'UNRESOLVED'`, `priority:'NORMAL'|'EMERGENCY'`, `deadlineSimSec:number|null`.
- `originalDestination:string`, `activeAssignment:Assignment|null`, `negotiationStage:string|null`, `stateRevision:number`, `lastDecisionReason:string|null`, `lastDecisionSource:'MODEL'|'RULES_FALLBACK'|null`, `unresolvedReason:string|null`.
- `proposals:Array<{offerId:string,airportId:string,runwayId:string,slotStartSimSec:number,expiresAtWallMs:number}>`; these are display proposals, never confirmed routes.

Heading is degrees clockwise from north: 0 up, 90 right, 180 down, 270 left. Map coordinates use x right/east and y down/south. `Assignment` matches the plan: airportId, runwayId, reservationId, slotStartSimSec, occupancySec, clearanceId or null.

`PublicIncident` is the spec's public incident record: incidentId, runId, target, kind, parameters, status, revision, createdAtSimSec, createdAtWallMs, resolvedAtSimSec or null. Its `target` is the canonical entity ID. Backend derives operational restrictions/priority; the browser does not infer availability merely from incident cards.

`CommandReceipt={runId,commandId,status:'QUEUED'|'SENT'|'DELAYED'|'APPLIED'|'REJECTED',incidentId,code:string|null,resultingRevision:number|null}`. Incident ACTIVE/RESOLVED is separate from command status.

`TimelineEvent={eventId,simTimeSec,wallTimeMs,fromEntityId,toEntityId:string|null,type,summary,status:'PENDING'|'APPLIED'|'REFUSED'|'INFO',source:'MODEL'|'RULES_FALLBACK'|'SYSTEM',correlationId:string|null}`. Summaries are short displayed decisions, never private chain-of-thought.

## HTTP and SSE

Keep the routes in design section 8. Add one read-only bootstrap route so UI startup/authentication has an explicit contract:

- `GET /api/bootstrap` → `{schemaVersion:1,session:{role:'VIEWER'|'CONTROLLER'|'OPERATOR',runId:string|null,csrfToken:string|null},activeRun:RunDescriptor|null,snapshot:PublicSnapshot|null}`. No run yet is a normal empty state, not 404. Viewer startup is permitted to read the active demo; only authenticated operator/controller sessions can mutate it.
- `POST /api/join` body `{token:string}` → the same bootstrap shape, with a new HttpOnly session cookie. Token comes from a URL fragment and is removed immediately after exchange. Operator/controller capabilities are distinguished by the backend, not a browser role parameter.
- State/control mutations return `RunDescriptor`, except incident submissions, which return 202 with `{commandId:string}`; invitations return `{joinUrl:string,expiresAtWallMs:number}`. The browser may show a local pending row using its submitted command ID, but application status comes only from the command receipt endpoint or live stream.
- Create run body `{requestId,config}`; pause/resume/start/reset body `{operationId}`; speed body `{operationId,speed}`. UUIDs are generated once per user action and reused on retry.
- Incident create/clear bodies exactly match implementation-plan section 5. `expectedIncidentRevision` is copied from the current snapshot. Clearing an already resolved known incident is idempotent; stale active revision is a conflict.
- All error responses use `{error:{code:string,message:string,retryable:boolean}}` with the HTTP statuses in the design. Accepted commands may later become REJECTED; do not turn all 202 responses into success toasts.
- Mutating fetch requests use `credentials:'same-origin'`, JSON Content-Type, and `X-CSRF-Token` from bootstrap. Backend enforces roles, origin, and CSRF.

SSE: `GET /api/runs/:runId/events` sends named event `snapshot`, `id: <projectionVersion>`, and `data: <full PublicSnapshot JSON>`. On connection, send the newest snapshot immediately. Subsequent frames are full replacements at at most 4 Hz; include command updates even when movement is paused. Also send named event `command` with a full `CommandReceipt` when a command changes; no separate SSE id is necessary for this event. Command terminal states APPLIED/REJECTED cannot regress to pending; receipts from another run are ignored. HTTP comment heartbeats are allowed but do not substitute for periodic fresh snapshots. Frontend ignores older/equal snapshot versions and wrong-run frames; reconnect starts with the newest full snapshot, so no browser patch replay is needed. Use same-origin EventSource cookies. After two wall seconds without a snapshot, show Reconnecting and stop movement interpolation.

Reset: the old run's stream emits named event `run-reset` with `{previousRunId,activeRunId}`. Operator/viewer UI refetches bootstrap and changes streams. A controller's old-run capability is invalid for the new run; disable its controls and request a fresh invite. This event only signals a run transition; it never applies simulation changes from the browser.

## Development and integration

- API serves on port 3000; Vite serves on 5173 during local frontend development and proxies `/api` to 3000, including SSE without buffering. Browser code uses relative `/api` URLs.
- Built frontend is served by the API origin on port 3000 for physical-phone tests and judging. `PUBLIC_APP_ORIGIN` supplies the reachable LAN/HTTPS address for QR invitations; never generate a phone link containing localhost unless the phone is actually the host.
- Backend owns root commands and dependency/lockfile edits. Agreed entry point: `bun run dev` in `atc-simulator/` supervises server, worker, and Vite; run `terse actor dev` separately from `atc-simulator/actors/`. Please provide the exact install command, generated-client command, web start/build commands, and a development operator-join URL mechanism. Do not send secrets through Relay or commit them.
- Until root scripts land, Codex needs the intended workspace package name and import alias for domain contracts. Proposed alias: `@ghost-tower/domain`, exposing a browser-safe `./contracts` entry.
- UI E2E tests use rules-mode agents and real API/Relay for acceptance. Backend integration tests own invariants and recovery; Codex owns browser behavior and physical-phone verification. Neither side marks the full demo complete based on fixtures alone.

## Requested response from Claude

Confirm or amend: (1) ownership including E2E/root shared files, (2) snapshot and fixture fields, (3) bootstrap/join/CSRF shape, (4) SSE/reset semantics, (5) package alias and startup commands. Send the contract commit SHA when available. Changes are welcome before implementation; once agreed, update this document to an agreed status and use the committed schema as the authority.
