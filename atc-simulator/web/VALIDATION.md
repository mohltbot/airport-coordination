# Frontend validation — 2026-10-31

Scope: display (Task 9), phone controller (Task 10), and browser contract tests. These results use the committed shared development fixture and controlled HTTP/EventSource mocks, not live simulation evidence.

| Check | Result |
|---|---|
| `bun run build` in web | PASS — TypeScript plus Vite production bundle |
| `bun src/lib/api.test.ts` | PASS — credentials/CSRF, typed failures, stable payloads, ambiguous malformed success |
| `bun src/lib/stream.test.ts` | PASS — run/version guards, terminal receipts, SSE/poll freshness |
| `bun run test:e2e` in web | PASS — 21 Chromium browser tests, 7.0 seconds on final full run |
| Independent source review | Four recovery defects identified and fixed; scoped re-review approved all four |
| Desktop 1440×900 and 1024×768 | Inspected; readable collision-avoiding labels, bounded feed, no horizontal overflow |
| Phone 390×844 and tablet 768×1024 | Inspected; no horizontal overflow; measured minimum button height 44 px on phone |
| Shared API tunnel bootstrap | NOT READY — returned HTTP 404 during this check |
| Real actors + hosted Relay + model | NOT RUN by frontend owner |
| Physical phone through HTTPS tunnel | NOT RUN by frontend owner |

Browser coverage includes flight-count validation and configuring-run updates, initialization retry, role restrictions, three airports/ten flights, persistent selection across ten snapshots, one-time invitation exchange under StrictMode, fragment removal, expired invitation, queued versus applied authority, rapid duplicate taps, exact clear revisions, low-fuel explanation, runway selection, invalid sessions, old-run fencing, stale/equal snapshot handling, polling fallback, HTTP 400/409 recovery, and retrying an ambiguous 202 with the identical command body.

The map and timeline show only public projection data. `/preview` is development-only and visibly read-only. Production bundle excludes that fixture route. Join URLs are capabilities: do not include them in screenshots or logs used as public demo evidence.

Remaining integration gate: start through the real authenticated API; issue airport and flight incidents through the phone UI; observe real Relay transport IDs and actor application; resolve individual incidents; verify reset and reconnect against running services. Measure achieved latencies. A physical-phone check requires a real device and cannot be inferred from viewport emulation.
