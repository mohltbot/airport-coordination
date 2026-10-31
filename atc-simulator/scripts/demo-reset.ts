// bun run demo:reset: authenticated new-run operation against the running API (design §10).
// Mints a one-time operator capability locally, joins with it, and resets the active run through
// the same POST /api/runs/:runId/reset route the UI uses. The token is never printed.
import { OPERATOR_INVITE_TTL_MS, mintInvite } from "../server/src/auth.ts"
import { loadConfig } from "../server/src/config.ts"

const config = loadConfig()
const base = `http://127.0.0.1:${config.port}`
const origin = `http://localhost:${config.port}`

async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", origin, ...init.headers } })
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${body?.error?.code ?? ""} ${body?.error?.message ?? ""}`.trim())
    return { res, body }
}

try {
    const { capability } = mintInvite(config.authDir, "OPERATOR", null, OPERATOR_INVITE_TTL_MS)
    const joined = await call("/api/join", { method: "POST", body: JSON.stringify({ token: capability }) })
    const cookie = (joined.res.headers.get("set-cookie") ?? "").split(";")[0]!
    const csrf = joined.body.session.csrfToken as string
    const active = joined.body.activeRun as { runId: string; phase: string } | null
    if (!active) {
        console.log("No active run; nothing to reset.")
        process.exit(0)
    }
    const { body } = await call(`/api/runs/${active.runId}/reset`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
    })
    console.log(`Reset run ${active.runId.slice(0, 8)} (${active.phase}). New run ${body.runId.slice(0, 8)} is ${body.phase}.`)
} catch (err) {
    console.error(`demo:reset failed: ${err instanceof Error ? err.message : String(err)}`)
    console.error(`Is the API running on ${base}? Start it with bun run dev or bun run start.`)
    process.exit(1)
}
