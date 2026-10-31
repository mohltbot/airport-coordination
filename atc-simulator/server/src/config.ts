// Strict environment parser for the API server. Bun loads atc-simulator/.env automatically.
// Values are never logged; describeConfig() reports only names and non-secret settings.
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { APP_PORT, SIMULATION_ACTOR_ID, VITE_PORT } from "@ghost-tower/domain/constants"

export const PROJECT_DIR = resolve(import.meta.dir, "../..")
export const DEFAULT_ALLOWED_ORIGINS = `http://localhost:${VITE_PORT},http://127.0.0.1:${VITE_PORT},http://localhost:${APP_PORT}`

export type AppConfig = {
    host: string
    port: number
    publicOrigin: string
    /** Browser origins allowed on mutating requests: PUBLIC_APP_ORIGIN plus ALLOWED_ORIGINS. */
    allowedOrigins: string[]
    production: boolean
    /** GHOST_TOWER_DEV_FIXTURE=1: serve tests/fixtures data, labeled as development data. */
    devFixture: boolean
    agentMode: "live" | "rules"
    commandSigningSecret: string
    commandSigningSecretEphemeral: boolean
    dataDir: string
    authDir: string
    webDistDir: string
    generatedClientPath: string
    simulationActorId: string
    terseActorUrl: string
    modelConfigured: boolean
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
    if (raw === undefined || raw.trim() === "") return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number`)
    return n
}

function parseOrigin(raw: string, name: string): string {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        throw new Error(`${name} must be an absolute URL such as https://example.trycloudflare.com`)
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must use http or https`)
    return url.origin
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
    const port = parsePort(env.APP_PORT, APP_PORT, "APP_PORT")
    const publicOrigin = env.PUBLIC_APP_ORIGIN?.trim() ? parseOrigin(env.PUBLIC_APP_ORIGIN.trim(), "PUBLIC_APP_ORIGIN") : `http://localhost:${port}`
    const extraOrigins = (env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(o => parseOrigin(o, "ALLOWED_ORIGINS"))
    const mode = (env.AGENT_MODE?.trim() || "rules").toLowerCase()
    if (mode !== "live" && mode !== "rules") throw new Error("AGENT_MODE must be live or rules")
    const secret = env.COMMAND_SIGNING_SECRET?.trim()
    const dataDir = resolve(PROJECT_DIR, env.APP_DATA_DIR?.trim() || ".data")
    return {
        host: env.APP_HOST?.trim() || "127.0.0.1",
        port,
        publicOrigin,
        allowedOrigins: [...new Set([publicOrigin, ...extraOrigins])],
        production: env.NODE_ENV === "production",
        devFixture: env.GHOST_TOWER_DEV_FIXTURE === "1" || env.GHOST_TOWER_DEV_FIXTURE === "true",
        agentMode: mode,
        commandSigningSecret: secret || randomBytes(32).toString("hex"),
        commandSigningSecretEphemeral: !secret,
        dataDir,
        authDir: resolve(dataDir, "auth"),
        webDistDir: resolve(PROJECT_DIR, "web/dist"),
        generatedClientPath: resolve(PROJECT_DIR, "server/generated/index.js"),
        simulationActorId: SIMULATION_ACTOR_ID,
        terseActorUrl: env.TERSE_ACTOR_URL?.trim() || "http://127.0.0.1:7100",
        modelConfigured: Boolean(env.OPENAI_API_KEY?.trim() && env.OPENAI_MODEL?.trim()),
    }
}

/** Local URL the operator opens on this laptop: Vite during development, the API origin in production. */
export function localDisplayOrigin(config: AppConfig): string {
    return config.production ? `http://localhost:${config.port}` : `http://127.0.0.1:${VITE_PORT}`
}

export function describeConfig(config: AppConfig): string {
    return [
        `listen ${config.host}:${config.port}`,
        `public origin ${config.publicOrigin}`,
        `data ${config.devFixture ? "DEV FIXTURE (sample data, not live agents)" : "actors"}`,
        `agents ${config.agentMode}`,
        config.commandSigningSecretEphemeral ? "COMMAND_SIGNING_SECRET missing: using a per-process secret" : "command signing secret set",
    ].join(" | ")
}
