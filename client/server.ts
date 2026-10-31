// Backend: moves Agent Relay messages into the Room actor and serves the screens.
// Laptop screens get a live WebSocket from the actor. Phones can't reach the local
// actor runtime, so they fall back to polling /state through the tunnel.
import { createHmac, timingSafeEqual } from "node:crypto"
import { actors } from "./generated"

const env = process.env
const BASE = env.RELAY_BASE ?? "https://cast.agentrelay.com/v1"
const KEY = env.RELAY_WORKSPACE_KEY!
const CHANNEL = env.RELAY_CHANNEL!
const ROOM = env.ROOM_ID!
const SECRET = env.RELAY_WEBHOOK_SECRET
const PORT = Number(env.PORT ?? 3000)
const TOKENS: Record<string, string | undefined> = {
    tower: env.RELAY_TOKEN_TOWER,
    airline: env.RELAY_TOKEN_AIRLINE,
}
if (!KEY || !CHANNEL || !ROOM) throw new Error("Missing Relay settings. Run: bun run relay:setup")

const room = () => actors.Room.get(ROOM)

async function ingest(payload: any, via: "poll" | "push" | "send") {
    // Event feed shape: { channel: "<name>", message: { id, agent_name, text, metadata } }.
    // The `data` we post comes back as `metadata`.
    const m = payload?.message ?? payload
    const channel =
        typeof payload?.channel === "string" ? payload.channel : (m?.channel_name ?? payload?.channel_name ?? payload?.channel?.name)
    if (channel && channel !== CHANNEL) return
    if (!m?.id) return
    const data = m.metadata ?? m.data ?? null
    const fresh = await room().record({
        id: String(m.id),
        from: String(m.agent_name ?? m.from_name ?? payload?.from_name ?? "unknown"),
        text: String(m.text ?? ""),
        data,
        at: new Date().toISOString(),
        source: "relay",
    })
    const sentAt = data?.sentAt
    if (fresh && typeof sentAt === "number") console.log(`relay -> room in ${Date.now() - sentAt} ms (${via})`)
}

// Relay -> Room by polling the workspace event feed once a second.
let cursor = 0
let lastPollOk = 0
let loggedShape = false
async function poll() {
    try {
        const res = await fetch(`${BASE}/workspace/events?since=${cursor}&limit=100`, {
            headers: { authorization: `Bearer ${KEY}` },
        })
        const json: any = await res.json()
        if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`)
        for (const ev of json.data.events ?? []) {
            if (ev.type === "message.created") {
                if (!loggedShape) {
                    console.log("first message event:", JSON.stringify(ev).slice(0, 1200))
                    loggedShape = true
                }
                await ingest(ev.payload, "poll")
            }
        }
        cursor = json.data.next_since ?? json.data.latest_seq ?? cursor
        lastPollOk = Date.now()
    } catch (err) {
        console.error("relay poll failed:", err)
    }
    setTimeout(poll, 1000)
}
poll()

// Push path, for a Relay subscription through the tunnel. Verified against the raw body.
const seenDeliveries = new Set<string>()
let loggedPush = false
function signatureOk(raw: string, header: string | null) {
    if (!SECRET) return true
    if (!header?.startsWith("sha256=")) return false
    const expected = createHmac("sha256", SECRET).update(raw).digest("hex")
    const given = header.slice("sha256=".length)
    return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url)
        try {
            if (req.method === "GET" && url.pathname === "/") return new Response(Bun.file("public/index.html"))

            if (req.method === "GET" && url.pathname === "/grant") {
                return json(await actors.Room.prepareWebsocket({ actorId: ROOM, metadata: null }))
            }

            if (req.method === "GET" && url.pathname === "/state") {
                return json({ room: ROOM, relayHealthy: Date.now() - lastPollOk < 5000, ...(await room().snapshot()) })
            }

            if (req.method === "POST" && url.pathname === "/send") {
                const { as = "tower", text = "test" } = (await req.json().catch(() => ({}))) as { as?: string; text?: string }
                const token = TOKENS[as]
                if (!token) return json({ error: `unknown agent ${as}` }, 400)
                const res = await fetch(`${BASE}/channels/${CHANNEL}/messages`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        authorization: `Bearer ${token}`,
                        "Idempotency-Key": crypto.randomUUID(),
                    },
                    body: JSON.stringify({ text, data: { sentAt: Date.now() } }),
                })
                const out: any = await res.json()
                // Relay's event feed lags 3 to 7 s (push lags 6 s or more). Once Relay has accepted the
                // message and given it an id, record it right away; the poller later skips it as a duplicate.
                if (res.ok && out?.data?.id) await ingest({ channel: CHANNEL, message: out.data }, "send")
                return json(out, res.status)
            }

            if (req.method === "POST" && url.pathname === "/alarm") {
                const { ms = 15000 } = (await req.json().catch(() => ({}))) as { ms?: number }
                return json({ alarmAt: await room().armAlarm(ms) })
            }

            if (req.method === "POST" && url.pathname === "/relay/events") {
                const raw = await req.text()
                if (!signatureOk(raw, req.headers.get("x-relay-signature"))) return json({ error: "bad signature" }, 401)
                const id = req.headers.get("webhook-id")
                if (id && seenDeliveries.has(id)) return json({ ok: true, duplicate: true })
                if (id) seenDeliveries.add(id)
                if (!loggedPush) {
                    console.log("first push delivery:", raw.slice(0, 1200))
                    loggedPush = true
                }
                // Subscription deliveries wrap the message: { type, workspace_id, timestamp, data: { id, channel_name, metadata, ... } }.
                const body = JSON.parse(raw)
                await ingest(body.data ?? body, "push")
                return json({ ok: true })
            }

            return json({ error: "not found" }, 404)
        } catch (err) {
            console.error(err)
            return json({ error: String(err) }, 500)
        }
    },
})

console.log(`backend on http://localhost:${PORT}  room=${ROOM}  channel=${CHANNEL}`)
