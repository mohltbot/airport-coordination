# Local Relay scenario verification — 2026-10-31

Executed sequentially on the Mac mini backend with real durable actors, Agent Relay local engine and gpt-5.4-mini. Codex independently polled the public API through the local Vite proxy and inspected the app. This is not a second full backend installation on the MacBook.

## NYC weather diversion

Run: `1dd58f57-c667-41ae-bf8f-8a5503313b9e`. Speed: 10x. All 4 flights LANDED; no UNRESOLVED flights. All four dependency checks READY at the terminal observation.

| Flight | Callsign | Original destination | Landed at |
|---|---|---|---|
| F001 | DAL1166 | JFK | EWR R1 |
| F002 | EDV5151 | JFK | EWR R2 |
| F003 | UAL1051 | JFK | EWR R2 |
| F004 | JBU156 | LGA | LGA R1 |

Decision events retained in terminal snapshot: MODEL: 29, RULES_FALLBACK: 2.

## Bay Area smoke diversion

Run: `51fe7535-8562-4782-9293-1fe040555501`. Speed: 10x. All 8 flights LANDED; no UNRESOLVED flights. All four dependency checks READY at the terminal observation.

| Flight | Callsign | Original destination | Landed at |
|---|---|---|---|
| F001 | ACA555 | SFO | SJC R1 |
| F002 | UAL762 | SFO | SFO R1 |
| F003 | EJA254 | OAK | OAK R1 |
| F004 | UAL1958 | SJC | SJC R1 |
| F005 | UAL1375 | SFO | SFO R2 |
| F006 | LXJ585 | OAK | OAK R2 |
| F007 | SWA3799 | SJC | SJC R2 |
| F008 | JSX715 | SFO | SFO R1 |

Decision events retained in terminal snapshot: MODEL: 35, RULES_FALLBACK: 0.

## Verified sequence

NYC: only JFK had WEATHER_CLOSED. Its reservations were revoked, all three affected flights accepted EWR slots, and the LGA flight kept its destination. EWR and LGA remained open. The live inspector displayed the closure and all three diversions with eight radio highlights and a full-log toggle.

Bay: both MRY runways were closed, then F001 ACA555 declared smoke. Observed message IDs in order:

- MRY request: `18397097-243a-490a-91dc-8fc9085af52e`
- MRY refusal (R1 and R2 closed): `745cd4ec-2e9f-41ce-ab2e-3690e04a2b86`
- SJC request: `b54593de-3d91-48b9-90cc-d96cf39842f1`
- SJC confirmation: `52c96830-6dcc-439f-8fbb-bcb83e6f454f`

The backend operator measured smoke-to-touchdown at 119.7 seconds. Codex independently observed F001 LANDED at SJC R1 and subsequently all seven other flights LANDED.

## Automated checks and limits

- 188 unit tests passed, including inbound motion from varied bearings, closure handling and sequencing.
- 67 local integration tests passed; 3 optional live tests skipped and 1 integration case remains TODO.
- Root/actor TypeScript checks and web production build passed.
- 11 map/communications browser tests passed.
- The broad integration command was not fully green on this MacBook: hosted Relay probe DNS/network access failed and local generated actor clients were missing. Those setup-dependent checks are not claimed as passing.
- A live UI click on overlapping aircraft selected a neighbor; keyboard selection selected the correct flight. Reported to the partner’s UI audit. This is a remaining UI limitation, not a failure of either flight scenario.
- Holding still occurs when waiting for a real assigned slot or clearance; only the immediate-at-spawn circling was removed. Both runs were observed with inbound ENROUTE motion before holds.
