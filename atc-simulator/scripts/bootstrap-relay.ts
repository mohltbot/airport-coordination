// Provision the simulator's dedicated hosted Relay workspace and, optionally, a run's identities.
//
//   bun scripts/bootstrap-relay.ts                 create a workspace if .env has none, check it
//   bun scripts/bootstrap-relay.ts --new-workspace replace the workspace lines in .env
//   bun scripts/bootstrap-relay.ts --run <uuid> [--flights 10]
//                                                  register controller, 3 ATCs and N flights for
//                                                  that run, join its channel, save tokens (0600)
//
// Run from atc-simulator/. Writes RELAY_BASE_URL, RELAY_WORKSPACE_ID, RELAY_WORKSPACE_KEY and
// RELAY_TOKEN_STORE_PATH into atc-simulator/.env (mode 0600), keeping every other line.
// Never prints keys or tokens. Never touches the team's coding-agent Relay workspace.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { AIRPORT_IDS } from "../packages/domain/src/constants.ts"
import { RunIdSchema, airportEntityId, flightEntityId, type EntityId } from "../packages/domain/src/contracts.ts"
import { DEFAULT_RELAY_BASE_URL, HostedRelayTransport, fileTokenStore, normalizeRelayBase } from "../server/src/relay/agent-relay.ts"
import { registrationsFor, runChannelName } from "../server/src/relay/transport.ts"

const ENV_PATH = resolve(import.meta.dir, "../.env")
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
}

function readEnv(): Map<string, string> {
    const m = new Map<string, string>()
    if (!existsSync(ENV_PATH)) return m
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
        const i = line.indexOf("=")
        if (i > 0 && !line.trimStart().startsWith("#")) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
    }
    return m
}

function writeEnv(updates: Record<string, string>) {
    const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : []
    const done = new Set<string>()
    const out = lines.map(line => {
        const k = line.slice(0, line.indexOf("=")).trim()
        if (k && k in updates) {
            done.add(k)
            return `${k}=${updates[k]}`
        }
        return line
    })
    while (out.length && out[out.length - 1] === "") out.pop()
    for (const [k, v] of Object.entries(updates)) if (!done.has(k)) out.push(`${k}=${v}`)
    writeFileSync(ENV_PATH, out.join("\n") + "\n", { mode: 0o600 })
    chmodSync(ENV_PATH, 0o600)
}

const env = readEnv()
const baseUrl = normalizeRelayBase(env.get("RELAY_BASE_URL") || DEFAULT_RELAY_BASE_URL)
let workspaceKey = env.get("RELAY_WORKSPACE_KEY") || ""
const storePath = env.get("RELAY_TOKEN_STORE_PATH") || ".data/relay-tokens.json"

if (!workspaceKey || flag("--new-workspace")) {
    // Anonymous Idempotency-Key on workspace creation returns 503, so none is sent.
    const res = await fetch(`${baseUrl}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `ghost-tower-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`, provenance: { source: "api" } }),
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok || !json?.data?.api_key) throw new Error(`workspace creation failed: HTTP ${res.status} ${json?.error?.code ?? ""}`)
    workspaceKey = json.data.api_key
    writeEnv({ RELAY_BASE_URL: baseUrl, RELAY_WORKSPACE_ID: String(json.data.workspace_id), RELAY_WORKSPACE_KEY: workspaceKey, RELAY_TOKEN_STORE_PATH: storePath })
    console.log(`created workspace ${json.data.workspace_id}; expires ${json.data.expires_at ?? "never"}; saved to .env`)
    if (existsSync(resolve(import.meta.dir, "..", storePath)))
        console.log(`note: ${storePath} holds tokens for the previous workspace; move it aside before connecting`)
}

const check = await fetch(`${baseUrl}/workspace/events?since=0&limit=1`, { headers: { authorization: `Bearer ${workspaceKey}` } })
const checkJson: any = await check.json().catch(() => ({}))
if (!check.ok) throw new Error(`workspace key check failed: HTTP ${check.status} ${checkJson?.error?.code ?? ""}`)
console.log(`workspace reachable at ${baseUrl}; event log head ${checkJson?.data?.latest_seq ?? "?"}`)

const runId = opt("--run")
if (runId) {
    if (!RunIdSchema.safeParse(runId).success) throw new Error("--run must be a UUID")
    const flights = Number(opt("--flights") ?? 10)
    if (!Number.isInteger(flights) || flights < 1 || flights > 30) throw new Error("--flights must be 1 to 30")
    const entityIds: EntityId[] = [
        "controller",
        ...AIRPORT_IDS.map(a => airportEntityId(a)),
        ...Array.from({ length: flights }, (_, i) => flightEntityId(`F${String(i + 1).padStart(3, "0")}`)),
    ]
    const transport = new HostedRelayTransport({
        baseUrl,
        workspaceKey,
        tokenStore: fileTokenStore(resolve(import.meta.dir, "..", storePath), { baseUrl, workspaceKey }),
    })
    const t0 = Date.now()
    await transport.connect(runId, registrationsFor(runId, entityIds))
    await transport.disconnect()
    const { registered, reconnected } = transport.stats
    console.log(`run ${runId}: ${entityIds.length} identities on #${runChannelName(runId)} (${registered} registered, ${reconnected} reused) in ${Date.now() - t0} ms; tokens in ${storePath}`)
}
