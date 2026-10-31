// bun run demo:bay-emergency: the Bay Area emergency diversion scenario (web/BAY-AREA-DEMO.md),
// driven through the real HTTP API with an operator session. Nothing here writes a message:
// every request, refusal and acceptance printed below is read back from the run's public
// timeline, which projects the actors' own outboxes (messages that travelled over Agent Relay).
//
//   1. reset the active run if one is live, create a US run focused on the Bay Area
//      (10 flights, SEQUENTIAL emergency candidates, featured flight F001 south of MRY)
//   2. start (init saga, PAUSED) and resume
//   3. RUNWAY_CLOSED at airport:MRY for R1 and R2 (MRY has two sim runways; one closure leaves R2 open)
//   4. wait until F001 is in position: MRY nearest, SJC next, SJC reachable inside the smoke deadline
//   5. SMOKE on flight:F001, then follow the timeline until F001 lands (or fails)
//
// Flags: --speed 1|5|10 (5)  --flights N (10)  --seed N  --featured F001  --smoke-deadline SEC
//        --settle-sec N (15)  --timeout-sec N (900)  --no-reset
//        --smoke-on-enter     after the settle (MRY already closed), wait for Enter before SMOKE
//        --finite             disable ongoing arrivals/departures
//        --no-incidents       stop after resume with zero incidents, for phone-driven runs
// The operator capability is minted locally and never printed.
import { CRUISE_SPEED_KNOTS, DEFAULT_SEED, SMOKE_DEADLINE_SEC } from "../packages/domain/src/constants.ts"
import type { PublicFlight, PublicSnapshot, RunConfig, TimelineEvent } from "../packages/domain/src/contracts.ts"
import { OPERATOR_INVITE_TTL_MS, mintInvite } from "../server/src/auth.ts"
import { loadConfig } from "../server/src/config.ts"

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
}
const speed = Number(flag("speed", "5")) as 1 | 5 | 10
const flightCount = Number(flag("flights", "10"))
const seed = Number(flag("seed", String(DEFAULT_SEED)))
const featured = flag("featured", "F001")
const smokeDeadlineArg = flag("smoke-deadline", "")
const settleSec = Number(flag("settle-sec", "15"))
const timeoutSec = Number(flag("timeout-sec", "900"))
const noReset = argv.includes("--no-reset")
const smokeOnEnter = argv.includes("--smoke-on-enter")
const noIncidents = argv.includes("--no-incidents")
if (![1, 5, 10].includes(speed)) throw new Error("--speed must be 1, 5 or 10")

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

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
const travelSec = (nm: number) => (nm / CRUISE_SPEED_KNOTS) * 3600

async function snapshot(runId: string): Promise<PublicSnapshot> {
    return call<PublicSnapshot>(`/api/runs/${runId}/snapshot`)
}

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
    const until = Date.now() + timeoutMs
    for (;;) {
        const v = await probe().catch(() => null)
        if (v) return v
        if (Date.now() > until) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`)
        await sleep(500)
    }
}

async function command(runId: string, target: string, kind: string, parameters: Record<string, string>) {
    const commandId = crypto.randomUUID()
    await post(`/api/runs/${runId}/commands`, { commandId, runId, type: "INCIDENT_CREATE", payload: { incidentId: crypto.randomUUID(), target, kind, parameters } })
    return commandId
}

function ranking(snap: PublicSnapshot, f: PublicFlight) {
    return snap.airports
        .map(a => ({ id: a.airportId, nm: dist(f.position, a.position) }))
        .sort((a, b) => a.nm - b.nm)
}

async function main() {
    // 1. operator session and a fresh Bay Area run
    const { capability } = mintInvite(server.authDir, "OPERATOR", null, OPERATOR_INVITE_TTL_MS)
    const joined = await post<any>("/api/join", { token: capability })
    log(`operator session joined (role ${joined.session.role})`)
    const active = joined.activeRun as { runId: string; phase: string } | null
    if (active && ["STARTING", "RUNNING", "PAUSED"].includes(active.phase)) {
        if (noReset) throw new Error(`run ${active.runId.slice(0, 8)} is ${active.phase}; drop --no-reset to replace it`)
        const reset = await post<any>(`/api/runs/${active.runId}/reset`, { operationId: crypto.randomUUID() })
        log(`reset run ${active.runId.slice(0, 8)} (${active.phase}) -> ${reset.runId.slice(0, 8)} ${reset.phase}`)
    }
    const config: RunConfig = {
        flightCount,
        seed,
        speed,
        airportNetwork: "US",
        focusRegion: "BAY_AREA",
        continuousTraffic: !argv.includes("--finite"),
        emergencyCandidateMode: "SEQUENTIAL",
        featuredFlightId: featured,
        ...(smokeDeadlineArg ? { smokeDeadlineSec: Number(smokeDeadlineArg) } : {}),
    }
    const created = await post<any>("/api/runs", { requestId: crypto.randomUUID(), config })
    const runId: string = created.runId
    log(`run ${runId} created: ${JSON.stringify(created.config)}`)

    // 2. start and resume
    const started = await post<any>(`/api/runs/${runId}/start`, { operationId: crypto.randomUUID() }, 240_000)
    log(`start -> ${started.phase}`)
    let snap = await waitFor("snapshot with flights", 60_000, async () => {
        const s = await snapshot(runId)
        return s.phase === "PAUSED" && s.flights.length > 0 ? s : null
    })
    const f0 = snap.flights.find(f => f.flightId === featured)
    if (!f0) throw new Error(`featured flight ${featured} not in snapshot`)
    const r0 = ranking(snap, f0)
    log(`${featured} ${f0.callsign} at (${f0.position.x.toFixed(1)}, ${f0.position.y.toFixed(1)}) bound for ${f0.originalDestination}; nearest ${r0.slice(0, 4).map(r => `${r.id} ${r.nm.toFixed(1)} NM`).join(", ")}`)
    log(`relay: ${snap.health.relay.status}${snap.health.relay.detail ? ` (${snap.health.relay.detail})` : ""}; agents: ${snap.agentMode}`)
    const resumeAt = Date.now()
    await post(`/api/runs/${runId}/resume`, { operationId: crypto.randomUUID() })
    log("resume sent")
    if (noIncidents) {
        log(`--no-incidents: run ${runId} is RUNNING with zero incidents; trigger them from the phone (close MRY R1 and R2 before SMOKE on ${featured})`)
        process.exit(0)
    }

    // 3. close both MRY runways through the controller command path
    const closeIds = [await command(runId, "airport:MRY", "RUNWAY_CLOSED", { runwayId: "R1" }), await command(runId, "airport:MRY", "RUNWAY_CLOSED", { runwayId: "R2" })]
    const closeSentAt = Date.now()
    log(`RUNWAY_CLOSED R1 and R2 at airport:MRY submitted (commands ${closeIds.map(c => c.slice(0, 8)).join(", ")})`)
    snap = await waitFor("MRY closed", 120_000, async () => {
        const s = await snapshot(runId)
        const mry = s.airports.find(a => a.airportId === "MRY")
        return mry && mry.status === "CLOSED" ? s : null
    })
    const closedAt = Date.now()
    log(`MRY ${snap.airports.find(a => a.airportId === "MRY")!.statusReason} (${((closedAt - closeSentAt) / 1000).toFixed(1)} s after submit)`)

    // 4. featured flight in position: MRY nearest, SJC next, SJC reachable inside the deadline
    const deadline = config.smokeDeadlineSec ?? SMOKE_DEADLINE_SEC
    const local = /local|127\.0\.0\.1/i.test(snap.health.relay.detail ?? "")
    const leadSec = Math.max(60, (local ? 6 : 90) * speed)
    const waitedFrom = Date.now()
    snap = await waitFor(`${featured} in position`, 120_000, async () => {
        const s = await snapshot(runId)
        const f = s.flights.find(x => x.flightId === featured)!
        const r = ranking(s, f)
        const sjc = r.find(x => x.id === "SJC")!
        if (r[0]!.id !== "MRY" || r[1]!.id !== "SJC") throw new Error(`${featured} out of position: nearest ${r.slice(0, 3).map(x => x.id).join(", ")}. Rerun for a fresh run.`)
        if (travelSec(sjc.nm) + leadSec + 60 > deadline) throw new Error(`SJC ${sjc.nm.toFixed(1)} NM is too far for a ${deadline} s smoke deadline`)
        const margin = r[1]!.nm - r[0]!.nm
        const settled = f.activeAssignment !== null || Date.now() - waitedFrom > settleSec * 1000
        return settled || margin < 2 || r[0]!.nm < 4 ? s : null
    })
    const fIn = snap.flights.find(x => x.flightId === featured)!
    const rIn = ranking(snap, fIn)
    log(`${featured} in position: ${rIn.slice(0, 3).map(r => `${r.id} ${r.nm.toFixed(1)} NM`).join(", ")}; booked ${fIn.activeAssignment ? `${fIn.activeAssignment.airportId} ${fIn.activeAssignment.runwayId}` : "nothing yet"}; sim ${Math.round(snap.simTimeSec)} s`)

    // 4b. on stage: hold the SMOKE until the presenter presses Enter. The flight keeps flying,
    // so re-check its position afterwards and say so if MRY is no longer the nearest airport.
    if (smokeOnEnter) {
        process.stdout.write(`\n>>> Press Enter to declare SMOKE on ${featured} ${fIn.callsign} <<<\n`)
        for await (const _line of console) break
        const sNow = await snapshot(runId)
        const rNow = ranking(sNow, sNow.flights.find(x => x.flightId === featured)!)
        const ok = rNow[0]!.id === "MRY" && rNow[1]!.id === "SJC"
        log(`${ok ? "" : "WARNING out of position: "}${featured} now ${rNow.slice(0, 3).map(r => `${r.id} ${r.nm.toFixed(1)} NM`).join(", ")}; sim ${Math.round(sNow.simTimeSec)} s`)
    }

    // 5. SMOKE, then follow the real messages
    const smokeId = await command(runId, `flight:${featured}`, "SMOKE", {})
    const smokeSentAt = Date.now()
    log(`SMOKE on flight:${featured} submitted (command ${smokeId.slice(0, 8)}), smoke deadline ${deadline} sim s`)

    const seen = new Map<string, TimelineEvent>()
    const mine = (e: TimelineEvent) => e.fromEntityId === `flight:${featured}` || e.toEntityId === `flight:${featured}`
    let emergencyAt: number | null = null
    let landed: { at: number; airport: string | null } | null = null
    let lastSim = 0
    let lastAssignment: string | null = null
    const until = smokeSentAt + timeoutSec * 1000
    while (!landed && Date.now() < until) {
        const s = await snapshot(runId).catch(() => null)
        if (!s) {
            await sleep(500)
            continue
        }
        lastSim = s.simTimeSec
        for (const e of s.timeline) {
            if (seen.has(e.eventId) || !mine(e) || e.type === "DOMAIN_ACK") continue
            seen.set(e.eventId, e)
            if (e.wallTimeMs < resumeAt) continue
            const route = `${short(e.fromEntityId)} -> ${short(e.toEntityId)}`.padEnd(13)
            console.log(`${stamp(e.wallTimeMs)}  sim ${String(Math.round(e.simTimeSec)).padStart(5)}  ${route} ${e.type.padEnd(18)} ${e.summary}`)
        }
        const f = s.flights.find(x => x.flightId === featured)
        if (f && f.priority === "EMERGENCY" && emergencyAt === null) {
            emergencyAt = Date.now()
            log(`${featured} EMERGENCY (smoke applied), land by sim ${f.deadlineSimSec}`)
        }
        const assignment = f?.activeAssignment ? `${f.activeAssignment.airportId} ${f.activeAssignment.runwayId} slot ${f.activeAssignment.slotStartSimSec}` : null
        if (assignment !== lastAssignment && assignment) log(`${featured} assignment: ${assignment}`)
        lastAssignment = assignment ?? lastAssignment
        if (f?.phase === "LANDED") landed = { at: Date.now(), airport: f.activeAssignment?.airportId ?? lastAssignment?.slice(0, 3) ?? null }
        if (f?.phase === "UNRESOLVED") throw new Error(`${featured} UNRESOLVED: ${f.unresolvedReason ?? "no reason"}`)
        await sleep(500)
    }

    // Summary from the authoritative message records (creation wall time at the sender).
    const after = [...seen.values()].filter(e => e.wallTimeMs >= smokeSentAt).sort((a, b) => a.wallTimeMs - b.wallTimeMs)
    const first = (type: string, from: string, to: string) => after.find(e => e.type === type && e.fromEntityId === from && e.toEntityId === to) ?? null
    const F = `flight:${featured}`
    const steps: Array<[string, TimelineEvent | null]> = [
        ["request MRY", first("LANDING_REQUEST", F, "airport:MRY")],
        ["MRY refuses", first("LANDING_REFUSED", "airport:MRY", F)],
        ["request SJC", first("LANDING_REQUEST", F, "airport:SJC")],
        ["SJC offers", first("LANDING_OFFER", "airport:SJC", F)],
        ["accept SJC", first("OFFER_ACCEPT", F, "airport:SJC")],
        ["SJC confirms", first("LANDING_CONFIRMED", "airport:SJC", F)],
        ["request clearance", first("CLEARANCE_REQUEST", F, "airport:SJC")],
        ["SJC clears", first("CLEARANCE_GRANTED", "airport:SJC", F)],
    ]
    console.log(`\nRun ${runId}, featured ${featured}. Seconds after SMOKE submit (sender's wall clock):`)
    console.log(`  MRY closed (seen)        ${((closedAt - closeSentAt) / 1000).toFixed(1)} s after its commands`)
    console.log(`  smoke applied (seen)     ${emergencyAt ? ((emergencyAt - smokeSentAt) / 1000).toFixed(1) : "-"}`)
    for (const [label, e] of steps)
        console.log(`  ${label.padEnd(24)} ${e ? `${((e.wallTimeMs - smokeSentAt) / 1000).toFixed(1).padStart(6)}  sim ${Math.round(e.simTimeSec)}  msg ${e.eventId}` : "     -"}`)
    console.log(`  landed (seen)            ${landed ? `${((landed.at - smokeSentAt) / 1000).toFixed(1).padStart(6)}  at ${landed.airport}` : "     -"}  (sim now ${Math.round(lastSim)})`)
    // A flight drops its own sent messages once the airport ACKs them, so the timeline can miss a
    // pilot request; SJC's offer (created only after SJC received the request) then stands in for it.
    const [reqMry, refMry] = [steps[0]![1], steps[1]![1]]
    const sjcAsked = steps[2]![1] ?? steps[3]![1]
    const ordered = !!refMry && !!sjcAsked && (!reqMry || reqMry.wallTimeMs <= refMry.wallTimeMs) && refMry.wallTimeMs <= sjcAsked.wallTimeMs
    const ok = ordered && landed?.airport === "SJC"
    console.log(ok ? "\nPASS: MRY asked first, refused with its reason, then SJC accepted and the flight landed at SJC." : "\nINCOMPLETE: see the steps above.")
    process.exit(ok ? 0 : 1)
}

main().catch(err => {
    console.error(`demo:bay-emergency failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
})
