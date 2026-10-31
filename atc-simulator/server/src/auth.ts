// Roles, one-time join capabilities, sessions, CSRF, origin checks and rate limits (design §8).
// Capability tokens and session cookies are stored only as SHA-256 hashes. Each invite is its own
// file so `bun run demo:operator-link` (another process) can mint one while the server runs;
// redeeming deletes the file, which makes the capability single use.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONTROLLER_COMMANDS_PER_SEC_PER_RUN, CONTROLLER_COMMANDS_PER_SEC_PER_SESSION, INVITE_BYTES } from "@ghost-tower/domain/constants"

export type Role = "VIEWER" | "CONTROLLER" | "OPERATOR"
export type InviteRole = "CONTROLLER" | "OPERATOR"

export const SESSION_COOKIE = "gt_session"
export const OPERATOR_INVITE_TTL_MS = 15 * 60 * 1000
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

type InviteRecord = { role: InviteRole; runId: string | null; expiresAtWallMs: number; createdAtWallMs: number }
export type Session = {
    sessionId: string
    role: InviteRole
    /** Controller sessions are bound to one run; operator sessions act on the active run. */
    runId: string | null
    csrfToken: string
    expiresAtWallMs: number
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const token = (bytes = INVITE_BYTES) => randomBytes(bytes).toString("base64url")

function writePrivate(path: string, body: string) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, path)
    chmodSync(path, 0o600)
}

export function joinUrl(origin: string, capability: string): string {
    return `${origin}/join#token=${capability}`
}

/** Mint a one-time join capability. Used by the server, the operator-link script and demo-reset. */
export function mintInvite(authDir: string, role: InviteRole, runId: string | null, ttlMs: number, nowMs = Date.now()) {
    const dir = join(authDir, "invites")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const capability = token()
    const record: InviteRecord = { role, runId, expiresAtWallMs: nowMs + ttlMs, createdAtWallMs: nowMs }
    writePrivate(join(dir, `${sha256(capability)}.json`), JSON.stringify(record))
    return { capability, expiresAtWallMs: record.expiresAtWallMs }
}

export class AuthStore {
    private sessions = new Map<string, Session>()
    private readonly sessionsPath: string
    private readonly invitesDir: string

    constructor(private readonly authDir: string) {
        mkdirSync(authDir, { recursive: true, mode: 0o700 })
        this.invitesDir = join(authDir, "invites")
        mkdirSync(this.invitesDir, { recursive: true, mode: 0o700 })
        this.sessionsPath = join(authDir, "sessions.json")
        if (existsSync(this.sessionsPath)) {
            try {
                const saved = JSON.parse(readFileSync(this.sessionsPath, "utf8")) as Record<string, Session>
                const now = Date.now()
                for (const [hash, s] of Object.entries(saved)) if (s.expiresAtWallMs > now) this.sessions.set(hash, s)
            } catch {
                // A corrupt session file only logs people out.
            }
        }
        this.pruneInvites()
    }

    mintInvite(role: InviteRole, runId: string | null, ttlMs: number) {
        return mintInvite(this.authDir, role, runId, ttlMs)
    }

    /** Consume a capability exactly once. Returns null for unknown, used or expired tokens. */
    redeem(capability: string, nowMs = Date.now()): InviteRecord | null {
        if (!/^[A-Za-z0-9_-]{20,128}$/.test(capability)) return null
        const path = join(this.invitesDir, `${sha256(capability)}.json`)
        const claimed = `${path}.claimed.${process.pid}.${randomBytes(4).toString("hex")}`
        try {
            renameSync(path, claimed) // atomic: a second redeem finds nothing
        } catch {
            return null
        }
        try {
            const record = JSON.parse(readFileSync(claimed, "utf8")) as InviteRecord
            return record.expiresAtWallMs > nowMs ? record : null
        } catch {
            return null
        } finally {
            try {
                unlinkSync(claimed)
            } catch {}
        }
    }

    createSession(role: InviteRole, runId: string | null, nowMs = Date.now()): { cookieValue: string; session: Session } {
        const cookieValue = token()
        const session: Session = { sessionId: token(12), role, runId, csrfToken: token(24), expiresAtWallMs: nowMs + SESSION_TTL_MS }
        this.sessions.set(sha256(cookieValue), session)
        this.persist()
        return { cookieValue, session }
    }

    getSession(cookieValue: string | null, nowMs = Date.now()): Session | null {
        if (!cookieValue) return null
        const s = this.sessions.get(sha256(cookieValue))
        if (!s || s.expiresAtWallMs <= nowMs) return null
        return s
    }

    private persist() {
        const now = Date.now()
        const out: Record<string, Session> = {}
        for (const [hash, s] of this.sessions) if (s.expiresAtWallMs > now) out[hash] = s
        writePrivate(this.sessionsPath, JSON.stringify(out))
    }

    private pruneInvites() {
        const now = Date.now()
        for (const name of readdirSync(this.invitesDir)) {
            const path = join(this.invitesDir, name)
            try {
                if (!name.endsWith(".json")) continue
                const r = JSON.parse(readFileSync(path, "utf8")) as InviteRecord
                if (r.expiresAtWallMs <= now) unlinkSync(path)
            } catch {}
        }
    }
}

export function readCookie(req: Request, name: string): string | null {
    const header = req.headers.get("cookie")
    if (!header) return null
    for (const part of header.split(";")) {
        const [k, ...v] = part.trim().split("=")
        if (k === name) return decodeURIComponent(v.join("="))
    }
    return null
}

/** True when the browser reached us over HTTPS, including through the cloudflared tunnel. */
export function viaHttps(req: Request): boolean {
    if (new URL(req.url).protocol === "https:") return true
    if (req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https") return true
    return (req.headers.get("cf-visitor") ?? "").includes("https")
}

/** Secure only when the browser origin is https, so http://localhost:5173 behind Vite's proxy keeps its cookie. */
export function sessionCookie(req: Request, value: string, maxAgeSec: number): string {
    const origin = req.headers.get("origin")
    const secure = (origin ? origin.startsWith("https:") : viaHttps(req)) ? "; Secure" : ""
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`
}

export function sessionMaxAgeSec(session: Session, nowMs = Date.now()): number {
    return Math.max(0, Math.floor((session.expiresAtWallMs - nowMs) / 1000))
}

export function csrfMatches(session: Session, header: string | null): boolean {
    if (!header || header.length !== session.csrfToken.length) return false
    return timingSafeEqual(Buffer.from(header), Buffer.from(session.csrfToken))
}

/** Origin allowlist for mutations: PUBLIC_APP_ORIGIN plus ALLOWED_ORIGINS. */
export function originAllowed(req: Request, allowed: string[]): boolean {
    const origin = req.headers.get("origin")
    if (origin === null) {
        // Non-browser clients (curl, scripts) send no Origin; the session and CSRF token still apply.
        const site = req.headers.get("sec-fetch-site")
        return site === null || site === "same-origin" || site === "none"
    }
    return allowed.includes(origin)
}

/** Sliding one-second windows: five commands per session and twenty per run (design §8). */
export class CommandRateLimiter {
    private hits = new Map<string, number[]>()

    allow(sessionId: string, runId: string, nowMs = Date.now()): boolean {
        const s = this.recent(`s:${sessionId}`, nowMs)
        const r = this.recent(`r:${runId}`, nowMs)
        if (s.length >= CONTROLLER_COMMANDS_PER_SEC_PER_SESSION || r.length >= CONTROLLER_COMMANDS_PER_SEC_PER_RUN) return false
        s.push(nowMs)
        r.push(nowMs)
        return true
    }

    private recent(key: string, nowMs: number): number[] {
        const list = (this.hits.get(key) ?? []).filter(t => nowMs - t < 1000)
        this.hits.set(key, list)
        return list
    }
}
