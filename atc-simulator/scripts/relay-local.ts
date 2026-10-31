// Prepare Agent Relay's local engine (`npx -y @relaycast/engine@12.3.0`, 127.0.0.1:8787) for the
// worker, keeping the hosted settings in .env untouched so we can flip back.
//
//   bun scripts/relay-local.ts            check /health, create a workspace if .env.local-relay has
//                                         none, write .env.local-relay (mode 0600)
//   bun scripts/relay-local.ts --register also register and channel every identity of the active run
//   bun run worker:local-relay            run the worker with .env then .env.local-relay (later wins)
//
// Never prints keys or tokens. Tokens and the event cursor live in their own files, because
// a token store is bound to one base URL and workspace.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { EntityId, SimulationState } from "../packages/domain/src/contracts.ts"
import { HostedRelayTransport, fileTokenStore, normalizeRelayBase } from "../server/src/relay/agent-relay.ts"
import { registrationsFor } from "../server/src/relay/transport.ts"

const ROOT = resolve(import.meta.dir, "..")
const LOCAL_ENV = resolve(ROOT, ".env.local-relay")
const base = normalizeRelayBase(process.env.RELAY_LOCAL_BASE_URL || "http://127.0.0.1:8787/v1")
const origin = base.replace(/\/v1$/, "")

function readEnvFile(path: string): Map<string, string> {
    const m = new Map<string, string>()
    if (!existsSync(path)) return m
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const i = line.indexOf("=")
        if (i > 0 && !line.trimStart().startsWith("#")) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
    }
    return m
}

const t0 = performance.now()
const health = await fetch(`${origin}/health`).catch(() => null)
if (!health?.ok) {
    console.error(`local engine not answering at ${origin}/health (${health ? `HTTP ${health.status}` : "connection refused"}); start it with npx -y @relaycast/engine@12.3.0`)
    process.exit(1)
}
console.log(`local engine healthy at ${origin} (${(performance.now() - t0).toFixed(0)} ms)`)

const existing = readEnvFile(LOCAL_ENV)
let workspaceKey = existing.get("RELAY_WORKSPACE_KEY") ?? ""
let workspaceId = existing.get("RELAY_WORKSPACE_ID") ?? ""
if (workspaceKey) {
    const check = await fetch(`${base}/workspace/events?since=0&limit=1`, { headers: { authorization: `Bearer ${workspaceKey}` } })
    if (!check.ok) {
        console.log(`saved local workspace key rejected (HTTP ${check.status}); creating a new workspace`)
        workspaceKey = ""
    }
}
if (!workspaceKey) {
    const res = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `ghost-tower-local-${Date.now()}`, provenance: { source: "api" } }),
    })
    const json: any = await res.json().catch(() => ({}))
    const key = json?.data?.api_key ?? json?.api_key
    if (!res.ok || !key) throw new Error(`local workspace creation failed: HTTP ${res.status} ${json?.error?.code ?? ""}`)
    workspaceKey = key
    workspaceId = String(json?.data?.workspace_id ?? json?.workspace_id ?? "")
    console.log(`created local workspace ${workspaceId || "(id not returned)"}`)
}

const lines = [
    "# Agent Relay local engine. Loaded after .env by `bun run worker:local-relay`; delete to flip back to hosted.",
    `RELAY_BASE_URL=${base}`,
    `RELAY_WORKSPACE_ID=${workspaceId}`,
    `RELAY_WORKSPACE_KEY=${workspaceKey}`,
    "RELAY_TOKEN_STORE_PATH=.data/relay-tokens-local.json",
    "RELAY_CURSOR_PATH=.data/relay-cursor-local.json",
    "RELAY_TRANSPORT_PROFILE=LOCAL",
    "RELAY_LABEL=Agent Relay (local engine)",
    // .env carries hosted ACK backoff (15/30/60 s); local hops are fast, so use the spec schedule.
    "RELAY_ACK_RETRY_BACKOFF_MS=500,1000,2000,4000",
    "RELAY_ACK_RETRY_STEADY_MS=4000",
    "RELAY_MAX_CONCURRENT_SENDS=8",
]
writeFileSync(LOCAL_ENV, lines.join("\n") + "\n", { mode: 0o600 })
chmodSync(LOCAL_ENV, 0o600)
console.log("wrote .env.local-relay (0600)")

if (process.argv.includes("--register")) {
    const { actors } = (await import(resolve(ROOT, "server/generated/index.js"))) as any
    const sim = actors.SimulationActor.get("ghost-tower")
    const active = await sim.activeRun()
    if (!active) throw new Error("no active run to register identities for")
    const run = (await sim.readRun(active.runId)) as SimulationState
    const ids = [...new Set([...run.entities.map(e => e.entityId), ...((run as any).traffic?.retiredIds ?? [])])] as EntityId[]
    const transport = new HostedRelayTransport({
        baseUrl: base,
        workspaceKey,
        tokenStore: fileTokenStore(resolve(ROOT, ".data/relay-tokens-local.json"), { baseUrl: base, workspaceKey }),
        registerConcurrency: 6,
    })
    const t1 = performance.now()
    await transport.connect(run.runId, registrationsFor(run.runId, ids))
    await transport.disconnect()
    console.log(`run ${run.runId.slice(0, 8)}: ${ids.length} identities (${transport.stats.registered} registered, ${transport.stats.reconnected} reused) in ${(performance.now() - t1).toFixed(0)} ms`)
}
