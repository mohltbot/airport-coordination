// Creates a fresh Agent Relay workspace, 2 agents and one channel, then writes the keys to client/.env.
// Run again for a clean demo run: every run gets new IDs, so nothing old leaks in.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

const BASE = process.env.RELAY_BASE ?? "https://cast.agentrelay.com/v1"
const AGENTS = ["tower", "airline"]
const run = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)

type Opts = { method?: string; token?: string; body?: unknown; idem?: string }

async function call(path: string, { method = "POST", token, body, idem }: Opts = {}) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(idem ? { "Idempotency-Key": idem } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`)
    return json.data
}

const ws = await call("/workspaces", { body: { name: `airport-${run}`, provenance: { source: "api" } } })
const key: string = ws.api_key
console.log(`workspace ${ws.workspace_id}`)

const tokens: Record<string, string> = {}
for (const name of AGENTS) {
    const agent = await call("/agents", { token: key, body: { name, type: "agent" } })
    const token = agent.token ?? agent.agent_token ?? agent.api_key
    if (!token) throw new Error(`no token field on agent response; fields: ${Object.keys(agent).join(", ")}`)
    tokens[name] = token
    console.log(`agent ${name}`)
}

// Agent lookup lags a moment after registration (relaycast issue #477).
await Bun.sleep(2000)

const channel = `ops-${run}`
await call("/channels", { token: key, body: { name: channel, topic: "Airport coordination test" } })
for (const name of AGENTS) await call(`/channels/${channel}/join`, { token: tokens[name] })
console.log(`channel ${channel}, both agents joined`)

const env = [
    `RELAY_BASE=${BASE}`,
    `RELAY_WORKSPACE_ID=${ws.workspace_id}`,
    `RELAY_WORKSPACE_KEY=${key}`,
    `RELAY_CHANNEL=${channel}`,
    ...AGENTS.map(n => `RELAY_TOKEN_${n.toUpperCase()}=${tokens[n]}`),
    `ROOM_ID=room-${run}`,
]
// Keep any lines this script doesn't own (for example OPENAI_API_KEY).
const owned = /^(RELAY_|ROOM_ID=)/
const kept = existsSync(".env") ? readFileSync(".env", "utf8").split("\n").filter(l => l && !owned.test(l)) : []
writeFileSync(".env", [...kept, ...env].join("\n") + "\n")
console.log(`saved to client/.env (room-${run})`)
