// bun run demo:nyc-weather: the New York weather scenario, driven through the real HTTP API with an
// operator session. Nothing here writes a message: every request, refusal, offer and confirmation
// printed below is read back from the run's public timeline, which projects the actors' own
// outboxes (messages that travelled over Agent Relay).
//
//   1. reset the active run if one is live, create a US run focused on New York
//      (4 flights: 3 inbound to JFK, 1 to LGA, all inside the Northeast view)
//   2. start (init saga, PAUSED) and resume
//   3. settle: wait until JFK has confirmed bookings (or --settle-sec runs out)
//   4. WEATHER_CLOSED at airport:JFK through the controller command path (LGA and EWR stay open)
//   5. follow the timeline until every JFK flight is booked at LGA or EWR and has landed (or timeout)
//
// Flags: --speed 1|5|10 (10)  --flights N (4)  --seed N  --settle-sec N (8)  --timeout-sec N (300)
//        --no-reset  --no-incidents (leave WEATHER_CLOSED to the phone)
//        --weather-on-enter  after the settle, pause the run and wait for Enter; Enter resumes and closes JFK
// The operator capability is minted locally and never printed.
import { DEFAULT_SEED } from "../packages/domain/src/constants.ts"
import type { PublicFlight, PublicSnapshot, RunConfig, TimelineEvent } from "../packages/domain/src/contracts.ts"
import { OPERATOR_INVITE_TTL_MS, mintInvite } from "../server/src/auth.ts"
import { loadConfig } from "../server/src/config.ts"

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
}
const speed = Number(flag("speed", "10")) as 1 | 5 | 10
const flightCount = Number(flag("flights", "4"))
const seed = Number(flag("seed", String(DEFAULT_SEED)))
const settleSec = Number(flag("settle-sec", "8"))
const timeoutSec = Number(flag("timeout-sec", "300"))
const noReset = argv.includes("--no-reset")
const noIncidents = argv.includes("--no-incidents")
const weatherOnEnter = argv.includes("--weather-on-enter")
if (![1, 5, 10].includes(speed)) throw new Error("--speed must be 1, 5 or 10")

const CLOSED = "JFK"
const OPEN = ["LGA", "EWR"]
const server = loadConfig()
const base = `http://127.0.0.1:${server.port}`
const t0 = Date.now()
const stamp = (ms = Date.now()) => `${((ms - t0) / 1000).toFixed(1).padStart(6)}s`
const log = (msg: string) => console.log(`${stamp()}  ${msg}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const short = (entityId: string | null) => (entityId ?? "").replace(/^(flight|airport):/, "")

let cookie = ""
let csrf = ""
async function call<T = any>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const res = await fetch(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...init.headers },
    })
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${body?.error?.code ?? ""} ${body?.error?.message ?? ""}`.trim())
    if (path === "/api/join") {
        cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!
        csrf = body.session.csrfToken
    }
    return body as T
}
const post = <T = any>(path: string, body: unknown, timeoutMs?: number) => call<T>(path, { method: "POST", body: JSON.stringify(body), timeoutMs })
const snapshot = (runId: string) => call<PublicSnapshot>(`/api/runs/${runId}/snapshot`)

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
    const until = Date.now() + timeoutMs
    for (;;) {
        const v = await probe().catch(() => null)
        if (v) return v
        if (Date.now() > until) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`)
        await sleep(500)
    }
}

async function command(runId: string, target: string, kind: string) {
    const commandId = crypto.randomUUID()
    await post(`/api/runs/${runId}/commands`, { commandId, runId, type: "INCIDENT_CREATE", payload: { incidentId: crypto.randomUUID(), target, kind, parameters: {} } })
    return commandId
}

const where = (f: PublicFlight) => (f.activeAssignment ? `${f.activeAssignment.airportId} ${f.activeAssignment.runwayId} slot ${f.activeAssignment.slotStartSimSec}` : "unbooked")

async function main() {
    // 1. operator session and a fresh NYC run
    const { capability } = mintInvite(server.authDir, "OPERATOR", null, OPERATOR_INVITE_TTL_MS)
    const joined = await post<any>("/api/join", { token: capability })
    log(`operator session joined (role ${joined.session.role})`)
    const active = joined.activeRun as { runId: string; phase: string } | null
    if (active && ["STARTING", "RUNNING", "PAUSED"].includes(active.phase)) {
        if (noReset) throw new Error(`run ${active.runId.slice(0, 8)} is ${active.phase}; drop --no-reset to replace it`)
        const reset = await post<any>(`/api/runs/${active.runId}/reset`, { operationId: crypto.randomUUID() })
        log(`reset run ${active.runId.slice(0, 8)} (${active.phase}) -> ${reset.runId.slice(0, 8)} ${reset.phase}`)
    }
    const config: RunConfig = { flightCount, seed, speed, airportNetwork: "US", focusRegion: "NYC" }
    const created = await post<any>("/api/runs", { requestId: crypto.randomUUID(), config })
    const runId: string = created.runId
    log(`RUN_ID ${runId} created: ${JSON.stringify(created.config)}`)

    // 2. start and resume
    const started = await post<any>(`/api/runs/${runId}/start`, { operationId: crypto.randomUUID() }, 240_000)
    log(`start -> ${started.phase}`)
    let snap = await waitFor("snapshot with flights", 60_000, async () => {
        const s = await snapshot(runId)
        return s.phase === "PAUSED" && s.flights.length > 0 ? s : null
    })
    for (const f of snap.flights) log(`  ${f.flightId} ${f.callsign.padEnd(9)} -> ${f.originalDestination} at (${f.position.x.toFixed(1)}, ${f.position.y.toFixed(1)}), fuel ${Math.round(f.fuelRemainingSec)} s`)
    log(`relay: ${snap.health.relay.status}${snap.health.relay.detail ? ` (${snap.health.relay.detail})` : ""}; agents: ${snap.agentMode}`)
    const resumeAt = Date.now()
    await post(`/api/runs/${runId}/resume`, { operationId: crypto.randomUUID() })
    log("resume sent")

    const seen = new Map<string, TimelineEvent>()
    const drain = (s: PublicSnapshot) => {
        for (const e of [...s.timeline].sort((a, b) => a.wallTimeMs - b.wallTimeMs)) {
            if (seen.has(e.eventId) || e.type === "DOMAIN_ACK") continue
            seen.set(e.eventId, e)
            if (e.wallTimeMs < resumeAt) continue
            const route = `${short(e.fromEntityId)} -> ${short(e.toEntityId)}`.padEnd(13)
            console.log(`${stamp(e.wallTimeMs)}  sim ${String(Math.round(e.simTimeSec)).padStart(5)}  ${route} ${e.type.padEnd(20)} ${e.source.padEnd(15)} ${e.eventId.slice(0, 8)}  ${e.summary}`)
        }
    }

    // 3. settle: JFK bookings first, so the closure revokes real reservations.
    const jfkFlights = snap.flights.filter(f => f.originalDestination === CLOSED).map(f => f.flightId)
    snap = await waitFor("JFK bookings", 120_000, async () => {
        const s = await snapshot(runId)
        drain(s)
        const booked = s.flights.filter(f => jfkFlights.includes(f.flightId) && f.activeAssignment?.airportId === CLOSED).length
        const landedEarly = s.flights.filter(f => f.phase === "LANDED").length
        return booked >= Math.ceil(jfkFlights.length / 2) || landedEarly > 0 || Date.now() - resumeAt > settleSec * 1000 ? s : null
    })
    log(`settled: ${snap.flights.map(f => `${f.flightId} ${where(f)}`).join("; ")}; sim ${Math.round(snap.simTimeSec)} s`)

    // 4. close JFK for weather through the command path
    let closeSentAt = Date.now()
    if (noIncidents) {
        log(`--no-incidents: waiting for WEATHER_CLOSED at airport:${CLOSED} from the phone`)
    } else {
        if (weatherOnEnter) {
            await post(`/api/runs/${runId}/pause`, { operationId: crypto.randomUUID() }).then(() => log("run paused while waiting")).catch(err => log(`pause failed (${err.message}); flights keep flying`))
            process.stdout.write(`\n>>> Press Enter to close ${CLOSED} for weather <<<\n`)
            for await (const _line of console) break
            await post(`/api/runs/${runId}/resume`, { operationId: crypto.randomUUID() }).catch(() => null)
        }
        const cmd = await command(runId, `airport:${CLOSED}`, "WEATHER_CLOSED")
        closeSentAt = Date.now()
        log(`WEATHER_CLOSED at airport:${CLOSED} submitted (command ${cmd.slice(0, 8)})`)
    }
    snap = await waitFor(`${CLOSED} closed`, noIncidents ? 900_000 : 120_000, async () => {
        const s = await snapshot(runId)
        drain(s)
        const a = s.airports.find(x => x.airportId === CLOSED)
        return a && a.status === "CLOSED" ? s : null
    })
    const closedAt = Date.now()
    if (noIncidents) closeSentAt = closedAt
    log(`${CLOSED} ${snap.airports.find(a => a.airportId === CLOSED)!.statusReason ?? "CLOSED"} (${((closedAt - closeSentAt) / 1000).toFixed(1)} s after submit)`)

    // 5. follow the real messages until every flight has landed or is unresolved
    const until = closeSentAt + timeoutSec * 1000
    const landedAt = new Map<string, { ms: number; airport: string }>()
    const lastBooking = new Map<string, string>()
    let last = snap
    while (Date.now() < until) {
        const s = await snapshot(runId).catch(() => null)
        if (!s) {
            await sleep(500)
            continue
        }
        last = s
        drain(s)
        for (const f of s.flights) {
            const b = f.activeAssignment?.airportId
            if (b && lastBooking.get(f.flightId) !== where(f)) {
                if (lastBooking.has(f.flightId)) log(`${f.flightId} booking: ${where(f)}`)
                lastBooking.set(f.flightId, where(f))
            }
            if (f.phase === "LANDED" && !landedAt.has(f.flightId)) {
                landedAt.set(f.flightId, { ms: Date.now(), airport: b ?? lastBooking.get(f.flightId)?.slice(0, 3) ?? "?" })
                log(`${f.flightId} LANDED at ${landedAt.get(f.flightId)!.airport}`)
            }
        }
        if (s.flights.every(f => f.phase === "LANDED" || f.phase === "UNRESOLVED")) break
        await sleep(500)
    }

    // Summary from the authoritative message records (creation wall time at the sender).
    const events = [...seen.values()].filter(e => e.wallTimeMs >= closeSentAt).sort((a, b) => a.wallTimeMs - b.wallTimeMs)
    const sec = (e: TimelineEvent) => ((e.wallTimeMs - closeSentAt) / 1000).toFixed(1).padStart(6)
    console.log(`\nRun ${runId}. Seconds after WEATHER_CLOSED submit (sender's wall clock); msg id, decision source:`)
    console.log(`  ${CLOSED} closed (seen)      ${((closedAt - closeSentAt) / 1000).toFixed(1)} s`)
    let diverted = 0
    const tally: Record<string, number> = {}
    for (const f of last.flights) {
        const F = f.entityId
        const first = (type: string, pred: (e: TimelineEvent) => boolean = () => true) => events.find(e => e.type === type && pred(e)) ?? null
        const fmt = (label: string, e: TimelineEvent | null) => `    ${label.padEnd(22)} ${e ? `${sec(e)}  sim ${Math.round(e.simTimeSec)}  ${e.eventId}  ${e.source}` : "     -"}`
        const landing = landedAt.get(f.flightId)
        const final = landing?.airport ?? f.activeAssignment?.airportId ?? "none"
        tally[final] = (tally[final] ?? 0) + 1
        console.log(`  ${f.flightId} ${f.callsign} (${f.originalDestination}): ${f.phase} ${final}${f.unresolvedReason ? ` (${f.unresolvedReason})` : ""}`)
        if (f.originalDestination !== CLOSED) continue
        if (OPEN.includes(final)) diverted++
        console.log(fmt("JFK revokes booking", first("RESERVATION_REVOKED", e => e.fromEntityId === `airport:${CLOSED}` && e.toEntityId === F)))
        console.log(fmt("JFK refuses", first("LANDING_REFUSED", e => e.fromEntityId === `airport:${CLOSED}` && e.toEntityId === F)))
        for (const alt of OPEN) {
            console.log(fmt(`${alt} offers`, first("LANDING_OFFER", e => e.fromEntityId === `airport:${alt}` && e.toEntityId === F)))
            const refused = first("LANDING_REFUSED", e => e.fromEntityId === `airport:${alt}` && e.toEntityId === F)
            if (refused) console.log(fmt(`${alt} refuses`, refused) + `  ${refused.summary}`)
        }
        console.log(fmt("accept", first("OFFER_ACCEPT", e => e.fromEntityId === F)))
        console.log(fmt("confirmed", first("LANDING_CONFIRMED", e => e.toEntityId === F && e.fromEntityId !== `airport:${CLOSED}`)))
        console.log(fmt("cleared", first("CLEARANCE_GRANTED", e => e.toEntityId === F && e.fromEntityId !== `airport:${CLOSED}`)))
        if (landing) console.log(`    ${"landed (seen)".padEnd(22)} ${((landing.ms - closeSentAt) / 1000).toFixed(1).padStart(6)}  at ${landing.airport}`)
    }
    const sources = events.reduce<Record<string, number>>((acc, e) => ((acc[e.source] = (acc[e.source] ?? 0) + 1), acc), {})
    console.log(`\nFinal airports: ${JSON.stringify(tally)}; JFK flights diverted to LGA/EWR: ${diverted} of ${last.flights.filter(f => f.originalDestination === CLOSED).length}; message sources after closure: ${JSON.stringify(sources)}; sim now ${Math.round(last.simTimeSec)}`)
    const ok = diverted === last.flights.filter(f => f.originalDestination === CLOSED).length
    console.log(ok ? "PASS: every JFK flight re-negotiated to LGA or EWR after the closure." : "INCOMPLETE: see the flights above.")
    process.exit(ok ? 0 : 1)
}

main().catch(err => {
    console.error(`demo:nyc-weather failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
})
