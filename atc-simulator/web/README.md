# Ghost Tower browser

React/Vite display and phone controller using the shared browser-safe domain schemas. Backend services, actor state, scheduling, and Relay delivery are owned by the sibling server/actors packages.

From `atc-simulator/`, install with `bun install`. From `atc-simulator/web/`:

```sh
bun run dev
bun run build
bun run check
bun src/lib/api.test.ts
bun src/lib/stream.test.ts
bun x playwright install chromium
bun run test:e2e
```

Development uses port 5173 and proxies relative `/api` requests to port 3000. To use a partner's running API, set `API_PROXY_TARGET` to its HTTPS tunnel origin before starting Vite. The API's `ALLOWED_ORIGINS` must include the exact browser origin (including localhost versus 127.0.0.1). The proxy preserves Origin and the API enforces session/CSRF authorization. Never put a join token or Relay/model secret in Vite environment variables.

Routes:

- `/`: configuration, fleet, map, inspector, timeline, pause/resume/speed/reset, and one-time phone invitation QR.
- `/join#token=…`: exchange an invitation once, remove its fragment, then redirect to the authorized display/controller.
- `/control`: phone incident activation and per-incident resolution.
- `/preview`: development-only, clearly labeled, read-only shared fixture. No backend or Relay activity is simulated by this route. Production builds do not include this fixture route.

Browser tests in `../tests/e2e/` use explicit API/EventSource mocks to verify the browser contract. They do **not** establish live actor/Relay acceptance. Tests cover authoritative application, stable retry IDs, stale/replayed snapshots, run reset, invitation consumption, role restrictions, and failure recovery. Physical-phone, HTTPS tunnel, real actor/Relay, and measured-latency acceptance must be recorded separately.

Production output is `web/dist/`, served by the API on the same origin. Preserve the SPA fallback for `/join` and `/control`; `/api` routes must never fall back to HTML.
