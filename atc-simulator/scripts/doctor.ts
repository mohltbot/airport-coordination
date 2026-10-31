// Readiness check for the Ghost Tower demo. Prints PASS/WARN/FAIL per check and exits 1 on any FAIL.
// Secrets are only ever reported as "set" or "missing"; this script never prints .env contents.
import { existsSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";

type Level = "PASS" | "WARN" | "FAIL";

const root = path.resolve(import.meta.dir, "..");
const env = process.env;
const MIN_BUN = "1.4.4";
const DEFAULT_TERSE_URL = "http://127.0.0.1:7100";
const VITE_PORT = 5173;
const useColor = process.stdout.isTTY === true && !env.NO_COLOR;
const colors: Record<Level, string> = { PASS: "\x1b[32m", WARN: "\x1b[33m", FAIL: "\x1b[31m" };
const counts: Record<Level, number> = { PASS: 0, WARN: 0, FAIL: 0 };

function report(level: Level, name: string, detail: string): void {
  counts[level] += 1;
  const tag = useColor ? `${colors[level]}${level}\x1b[0m` : level;
  console.log(`${tag}  ${name.padEnd(24)} ${detail}`);
}

function isSet(key: string): boolean {
  return (env[key] ?? "").trim() !== "";
}

function versionAtLeast(actual: string, min: string): boolean {
  const a = actual.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const b = min.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (error.name === "TimeoutError") return "timed out";
    return typeof code === "string" ? code : error.message.split("\n")[0] ?? "error";
  }
  return "error";
}

async function probeHttp(name: string, url: string, timeoutMs: number): Promise<void> {
  const origin = originOf(url);
  if (origin === null) {
    report("FAIL", name, "URL does not parse");
    return;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    report("PASS", name, `${origin} answered HTTP ${res.status}`);
  } catch (error) {
    report("FAIL", name, `${origin} unreachable (${errorText(error)})`);
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function portInUse(port: number): Promise<boolean> {
  return (await canConnect(port)) || !(await canListen(port));
}

async function describeAppPortHolder(port: number): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const text = await res.text();
    let status: string | null = null;
    try {
      const body: unknown = JSON.parse(text);
      if (typeof body === "object" && body !== null && "status" in body) status = String(body.status);
    } catch {
      status = null;
    }
    if (status === null || res.status === 404) {
      return `/api/health HTTP ${res.status}, not this app's JSON; some other process holds the port`;
    }
    return `/api/health HTTP ${res.status}, status=${status} (likely this app already running)`;
  } catch (error) {
    return `/api/health unreachable (${errorText(error)}); some other process may hold the port`;
  }
}

// 1. Bun version
report(versionAtLeast(Bun.version, MIN_BUN) ? "PASS" : "FAIL", "bun version", `${Bun.version} (need >= ${MIN_BUN})`);

// 2. .env file
const hasEnvFile = existsSync(path.join(root, ".env"));
report(hasEnvFile ? "PASS" : "WARN", ".env file", hasEnvFile ? "present" : "missing (copy .env.example and fill it in)");

// 3. Environment keys (values never printed except AGENT_MODE and OPENAI_MODEL)
for (const key of ["SESSION_SECRET", "COMMAND_SIGNING_SECRET", "PUBLIC_APP_ORIGIN"]) {
  report(isSet(key) ? "PASS" : "WARN", key, isSet(key) ? "set" : "missing");
}
for (const key of ["RELAY_BASE_URL", "RELAY_WORKSPACE_KEY", "RELAY_TOKEN_STORE_PATH"]) {
  report(isSet(key) ? "PASS" : "FAIL", key, isSet(key) ? "set" : "missing");
}
report("PASS", "TERSE_ACTOR_URL", isSet("TERSE_ACTOR_URL") ? "set" : `missing, using default ${DEFAULT_TERSE_URL}`);
const agentMode = (env.AGENT_MODE ?? "").trim() || "rules";
if (agentMode !== "live" && agentMode !== "rules") {
  report("FAIL", "AGENT_MODE", "invalid value (expected live or rules)");
} else {
  report("PASS", "AGENT_MODE", isSet("AGENT_MODE") ? agentMode : "missing, using default rules");
}
if (agentMode === "live") {
  report(isSet("OPENAI_API_KEY") ? "PASS" : "FAIL", "OPENAI_API_KEY", isSet("OPENAI_API_KEY") ? "set" : "missing (required when AGENT_MODE=live)");
  report(isSet("OPENAI_MODEL") ? "PASS" : "FAIL", "OPENAI_MODEL", isSet("OPENAI_MODEL") ? `set (${(env.OPENAI_MODEL ?? "").trim()})` : "missing (required when AGENT_MODE=live)");
}

// 4. Terse actor runtime
await probeHttp("terse actor runtime", isSet("TERSE_ACTOR_URL") ? (env.TERSE_ACTOR_URL ?? "").trim() : DEFAULT_TERSE_URL, 2000);

// 5. Relay origin (no auth header)
if (isSet("RELAY_BASE_URL")) await probeHttp("relay origin", (env.RELAY_BASE_URL ?? "").trim(), 3000);
else report("WARN", "relay origin", "skipped, RELAY_BASE_URL missing");

// 6. Relay token store permissions
if (isSet("RELAY_TOKEN_STORE_PATH")) {
  const storePath = path.resolve(root, (env.RELAY_TOKEN_STORE_PATH ?? "").trim());
  if (!existsSync(storePath)) {
    report("WARN", "relay token store", "not bootstrapped yet");
  } else {
    const mode = statSync(storePath).mode & 0o777;
    const octal = `0${mode.toString(8).padStart(3, "0")}`;
    report(mode === 0o600 ? "PASS" : "FAIL", "relay token store", mode === 0o600 ? `mode ${octal}` : `mode ${octal}, must be 0600 (chmod 600 it)`);
  }
} else {
  report("WARN", "relay token store", "skipped, RELAY_TOKEN_STORE_PATH missing");
}

// 7. Generated actor client
const generated = existsSync(path.join(root, "server", "generated", "index.js"));
report(generated ? "PASS" : "WARN", "actor client", generated ? "server/generated/index.js present" : "server/generated/index.js missing, run bun run actors:generate");

// 8. Built web
const built = existsSync(path.join(root, "web", "dist", "index.html"));
report(built ? "PASS" : "WARN", "built web", built ? "web/dist/index.html present" : "web/dist/index.html missing, run bun run build");

// 9. PUBLIC_APP_ORIGIN shape
if (isSet("PUBLIC_APP_ORIGIN")) {
  let host: string | null = null;
  try {
    host = new URL((env.PUBLIC_APP_ORIGIN ?? "").trim()).hostname;
  } catch {
    host = null;
  }
  if (host === null) report("FAIL", "public app origin", "PUBLIC_APP_ORIGIN does not parse as a URL");
  else if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(host)) {
    report("WARN", "public app origin", "phone invite links will only work on this machine; set it to the cloudflared https URL");
  } else report("PASS", "public app origin", `host ${host}`);
} else {
  report("WARN", "public app origin", "skipped, PUBLIC_APP_ORIGIN missing");
}

// 10. Ports (never stops anything)
const appPort = Number(env.APP_PORT ?? "3000");
if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) {
  report("FAIL", "APP_PORT", "not a valid port number");
} else if (await portInUse(appPort)) {
  report("WARN", `port ${appPort} (APP_PORT)`, `in use; ${await describeAppPortHolder(appPort)}`);
} else {
  report("PASS", `port ${appPort} (APP_PORT)`, "free");
}
const viteBusy = await portInUse(VITE_PORT);
report(viteBusy ? "WARN" : "PASS", `port ${VITE_PORT} (Vite)`, viteBusy ? "in use (Vite may already be running)" : "free");

console.log(`\n${counts.PASS} pass, ${counts.WARN} warn, ${counts.FAIL} fail`);
process.exit(counts.FAIL > 0 ? 1 : 0);
