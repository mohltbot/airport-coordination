// Ghost Tower API server: API + SSE + built web on one origin (port 3000).
// On startup it prints a one-time operator join URL (amendment A1). Capability tokens are printed to
// this terminal only; they never go to Relay, the browser bundle or a log file.
import { ActorBackend, ActorRepository, type SimulationBackend } from "./actors.ts"
import { AuthStore, OPERATOR_INVITE_TTL_MS, joinUrl } from "./auth.ts"
import { describeConfig, loadConfig, localDisplayOrigin } from "./config.ts"
import { ProjectionHub } from "./projection.ts"
import { createApp } from "./routes.ts"

const config = loadConfig()

async function makeBackend(): Promise<SimulationBackend> {
    if (config.devFixture) {
        const { FixtureBackend } = await import("./fixture.ts")
        return new FixtureBackend()
    }
    return new ActorBackend(await ActorRepository.load(config), config)
}

const backend = await makeBackend()
const hub = new ProjectionHub(backend)
const auth = new AuthStore(config.authDir)
const app = createApp({ config, backend, hub, auth })

const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120, // SSE streams send a frame every second, so this only reaps dead sockets
    fetch: req => app.fetch(req),
})

console.log(`[ghost-tower] API on http://${server.hostname}:${server.port} | ${describeConfig(config)}`)
if (backend.mode === "fixture") console.log("[ghost-tower] DEV FIXTURE MODE: snapshots are sample data, not live agents or Relay.")

// GHOST_TOWER_NO_LINK=1 when stdout goes to a log file: tokens never land in logs.
if (process.env.GHOST_TOWER_NO_LINK !== "1") {
    const invite = auth.mintInvite("OPERATOR", null, OPERATOR_INVITE_TTL_MS)
    const local = localDisplayOrigin(config)
    console.log("[ghost-tower] Operator join link (single use, expires in 15 min; open one of these):")
    console.log(`  ${joinUrl(local, invite.capability)}`)
    if (config.publicOrigin !== local) console.log(`  ${joinUrl(config.publicOrigin, invite.capability)}`)
}
console.log("[ghost-tower] New operator link any time: bun run demo:operator-link")

const shutdown = () => {
    hub.close()
    server.stop(true)
    process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
