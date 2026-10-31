// HTTP API (design §8 plus GET /api/bootstrap from the frontend-backend contract).
// The gateway authenticates, validates and enqueues. It never applies an incident: commands go
// into the SimulationActor ledger and reach their target through Relay.
import { existsSync, statSync } from "node:fs"
import { join, normalize } from "node:path"
import { INVITE_TTL_MS } from "@ghost-tower/domain/constants"
import { IncidentCommandSchema, RunConfigSchema, SpeedSchema, type ControllerPrincipal, type PublicSnapshot } from "@ghost-tower/domain/contracts"
import { z } from "zod"
import type { LifecycleAction, SimulationBackend } from "./actors.ts"
import {
    AuthStore,
    CommandRateLimiter,
    SESSION_COOKIE,
    csrfMatches,
    joinUrl,
    originAllowed,
    readCookie,
    sessionCookie,
    sessionMaxAgeSec,
    type Session,
} from "./auth.ts"
import type { AppConfig } from "./config.ts"
import { ApiFailure, errorResponse, fail, toApiFailure } from "./errors.ts"
import type { ProjectionHub } from "./projection.ts"
import { sseResponse } from "./stream.ts"

export type AppDeps = { config: AppConfig; backend: SimulationBackend; hub: ProjectionHub; auth: AuthStore; limiter?: CommandRateLimiter }

const Op = z.strictObject({ operationId: z.string().min(1).max(128) })
const SpeedBody = z.strictObject({ operationId: z.string().min(1).max(128), speed: SpeedSchema })
const CreateRunBody = z.strictObject({ requestId: z.string().min(1).max(128), config: RunConfigSchema })
const JoinBody = z.strictObject({ token: z.string().min(1).max(256) })

const NO_STORE = { "cache-control": "no-store" }
const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } })

async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
    let raw: unknown
    try {
        raw = await req.json()
    } catch {
        throw fail(400, "INVALID_PAYLOAD", "Body must be JSON.")
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw fail(400, "INVALID_PAYLOAD", issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid body.")
    }
    return parsed.data
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".map": "application/json",
    ".woff2": "font/woff2",
}

export function createApp(deps: AppDeps) {
    const { config, backend, hub, auth } = deps
    const limiter = deps.limiter ?? new CommandRateLimiter()

    const session = (req: Request): Session | null => auth.getSession(readCookie(req, SESSION_COOKIE))

    /** Mutations: allowed origin, a session with one of the roles, and a matching X-CSRF-Token. */
    function requireMutation(req: Request, roles: Session["role"][]): Session {
        if (!originAllowed(req, config.allowedOrigins)) throw fail(403, "ORIGIN_REJECTED", "Request origin is not allowed.")
        const s = session(req)
        if (!s) throw fail(401, "UNAUTHENTICATED", "Join with an invite link first.")
        if (!csrfMatches(s, req.headers.get("x-csrf-token"))) throw fail(403, "CSRF_REJECTED", "Missing or stale X-CSRF-Token. Reload bootstrap.")
        if (!roles.includes(s.role)) throw fail(403, "FORBIDDEN", `${s.role.toLowerCase()} sessions cannot do this.`)
        return s
    }

    async function requireRun(runId: string) {
        const run = await backend.getRun(runId)
        if (!run) throw fail(404, "UNKNOWN_RUN", "No run with that ID.")
        return run
    }

    async function bootstrap(s: Session | null) {
        const activeRun = await backend.activeRun()
        const snapshot: PublicSnapshot | null = activeRun ? await hub.snapshot(activeRun.runId) : null
        return {
            schemaVersion: 1 as const,
            session: {
                role: s?.role ?? "VIEWER",
                runId: s ? (s.runId ?? activeRun?.runId ?? null) : (activeRun?.runId ?? null),
                csrfToken: s?.csrfToken ?? null,
            },
            activeRun,
            snapshot,
        }
    }

    async function health() {
        const h = await backend.health()
        const statuses = Object.values(h).map(d => d.status)
        return {
            status: statuses.every(s => s === "READY") ? "ok" : statuses.includes("UNAVAILABLE") ? "unavailable" : "degraded",
            mode: backend.mode,
            agentMode: config.agentMode,
            ...h,
        }
    }

    function serveStatic(pathname: string): Response {
        const dist = config.webDistDir
        if (!existsSync(join(dist, "index.html"))) {
            return new Response(`Ghost Tower API is running (${backend.mode}). The web build is missing: run \`bun run build\`, or open the Vite dev server on port 5173.\n`, {
                status: 200,
                headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
            })
        }
        const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|$))+/, "")
        const file = join(dist, rel)
        if (file.startsWith(dist) && rel !== "/" && existsSync(file) && statSync(file).isFile()) {
            const ext = file.slice(file.lastIndexOf("."))
            const immutable = rel.startsWith("/assets/") ? { "cache-control": "public, max-age=31536000, immutable" } : NO_STORE
            return new Response(Bun.file(file), { headers: { "content-type": MIME[ext] ?? "application/octet-stream", ...immutable } })
        }
        // SPA fallback: /, /control, /join and other client routes.
        return new Response(Bun.file(join(dist, "index.html")), { headers: { "content-type": MIME[".html"]!, ...NO_STORE } })
    }

    async function route(req: Request): Promise<Response> {
        const url = new URL(req.url)
        const path = url.pathname
        const m = req.method

        if (!path.startsWith("/api/")) {
            if (m !== "GET" && m !== "HEAD") throw fail(405, "METHOD_NOT_ALLOWED", "Use GET.")
            return serveStatic(path)
        }

        if (m === "GET" && path === "/api/health") return json(await health())
        if (m === "GET" && path === "/api/bootstrap") return json(await bootstrap(session(req)))

        if (m === "POST" && path === "/api/join") {
            if (!originAllowed(req, config.allowedOrigins)) throw fail(403, "ORIGIN_REJECTED", "Request origin is not allowed.")
            const { token } = await parseBody(req, JoinBody)
            const invite = auth.redeem(token)
            if (!invite) throw fail(401, "INVITE_INVALID", "This link was already used or has expired. Ask the operator for a new one.")
            const { cookieValue, session: s } = auth.createSession(invite.role, invite.runId)
            return json(await bootstrap(s), 200, { "set-cookie": sessionCookie(req, cookieValue, sessionMaxAgeSec(s)) })
        }

        if (m === "POST" && path === "/api/runs") {
            requireMutation(req, ["OPERATOR"])
            const body = await parseBody(req, CreateRunBody)
            return json(await backend.createRun(body.requestId, body.config))
        }

        const runMatch = path.match(/^\/api\/runs\/([0-9a-fA-F-]{36})(\/.*)?$/)
        if (!runMatch) throw fail(404, "NOT_FOUND", "Unknown route.")
        const runId = runMatch[1]!.toLowerCase()
        const rest = runMatch[2] ?? ""

        if (m === "GET" && rest === "/snapshot") {
            await requireRun(runId)
            const snap = await hub.snapshot(runId)
            if (!snap) throw fail(503, "SNAPSHOT_UNAVAILABLE", "No snapshot published for this run yet.", true)
            return json(snap)
        }
        if (m === "GET" && rest === "/events") {
            await requireRun(runId)
            return sseResponse(hub, runId, req.signal)
        }
        const cmdMatch = rest.match(/^\/commands\/([0-9a-fA-F-]{36})$/)
        if (m === "GET" && cmdMatch) {
            await requireRun(runId)
            const receipt = await backend.readCommand(runId, cmdMatch[1]!.toLowerCase())
            if (!receipt) throw fail(404, "UNKNOWN_COMMAND", "No command with that ID in this run.")
            return json(receipt)
        }

        if (m === "POST" && rest === "/commands") {
            const s = requireMutation(req, ["CONTROLLER", "OPERATOR"])
            const command = await parseBody(req, IncidentCommandSchema)
            if (command.runId !== runId) throw fail(409, "WRONG_RUN", "Body runId does not match the URL.")
            if (s.role === "CONTROLLER" && s.runId !== runId) throw fail(403, "WRONG_RUN", "This controller link belongs to another run. Ask for a new invite.")
            const run = await requireRun(runId)
            const active = await backend.activeRun()
            if (active?.runId !== run.runId) throw fail(409, "WRONG_RUN", "That run was reset. Reload to join the current run.")
            if (!limiter.allow(s.sessionId, runId)) throw fail(429, "RATE_LIMITED", "Too many commands. Wait a second.", true)
            const principal: ControllerPrincipal = { principalId: `session:${s.sessionId}`, role: s.role, runId, sessionId: s.sessionId }
            const receipt = await backend.submitCommand(command, principal)
            return json({ commandId: receipt.commandId }, 202)
        }

        if (m === "POST" && rest === "/controller-invites") {
            requireMutation(req, ["OPERATOR"])
            const run = await requireRun(runId)
            const active = await backend.activeRun()
            if (active?.runId !== run.runId) throw fail(409, "WRONG_RUN", "Invites are only issued for the active run.")
            const invite = auth.mintInvite("CONTROLLER", runId, INVITE_TTL_MS)
            return json({ joinUrl: joinUrl(config.publicOrigin, invite.capability), expiresAtWallMs: invite.expiresAtWallMs })
        }

        const lifecycle: Record<string, LifecycleAction> = { "/start": "start", "/pause": "pause", "/resume": "resume" }
        if (m === "POST" && lifecycle[rest]) {
            requireMutation(req, ["OPERATOR"])
            const { operationId } = await parseBody(req, Op)
            await requireRun(runId)
            return json(await backend.lifecycle(runId, lifecycle[rest]!, operationId))
        }
        if (m === "POST" && rest === "/speed") {
            requireMutation(req, ["OPERATOR"])
            const { operationId, speed } = await parseBody(req, SpeedBody)
            await requireRun(runId)
            return json(await backend.setSpeed(runId, speed, operationId))
        }
        if (m === "POST" && rest === "/reset") {
            requireMutation(req, ["OPERATOR"])
            const { operationId } = await parseBody(req, Op)
            await requireRun(runId)
            return json(await backend.resetRun(runId, operationId))
        }

        throw fail(404, "NOT_FOUND", "Unknown route.")
    }

    return {
        async fetch(req: Request): Promise<Response> {
            try {
                return await route(req)
            } catch (err) {
                const failure = err instanceof ApiFailure ? err : toApiFailure(err)
                if (failure.status >= 500) console.error(`[api] ${req.method} ${new URL(req.url).pathname} -> ${failure.code}`)
                return errorResponse(failure, NO_STORE)
            }
        },
    }
}
