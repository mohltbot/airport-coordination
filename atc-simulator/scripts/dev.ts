// Process supervisor for Ghost Tower. Starts and restarts only the processes it spawns itself.
// Dev:  bun scripts/dev.ts         -> server (--watch), worker (--watch, if present), Vite (if web has a dev script)
// Prod: bun scripts/dev.ts --prod  -> server + worker with NODE_ENV=production, serving the built web
import type { Subprocess } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";

type Proc = Subprocess<"ignore", "pipe", "pipe">;
interface Spec {
  name: string;
  color: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}
interface Child {
  spec: Spec;
  proc: Proc | null;
  restarts: number[];
  gaveUp: boolean;
}

const root = path.resolve(import.meta.dir, "..");
const prod = process.argv.includes("--prod");
const bun = process.execPath;
const useColor = !process.env.NO_COLOR;
const RESTART_DELAY_MS = 1000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const KILL_GRACE_MS = 3000;
const VITE_PORT = 5173;

function tag(name: string, color: string): string {
  return useColor ? `${color}[${name}]\x1b[0m` : `[${name}]`;
}

function say(message: string): void {
  console.log(`${tag("dev", "\x1b[90m")} ${message}`);
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

function webHasDevScript(): boolean {
  const pkgPath = path.join(root, "web", "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.dev === "string";
  } catch {
    return false;
  }
}

// ---- Preflight ----
const appPort = Number(process.env.APP_PORT ?? "3000");
if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) {
  say("APP_PORT is not a valid port number");
  process.exit(1);
}
const startWeb = !prod && webHasDevScript();
const ports: Array<[number, string]> = [[appPort, "APP_PORT"]];
if (startWeb) ports.push([VITE_PORT, "Vite"]);
for (const [port, label] of ports) {
  if (await portInUse(port)) {
    say(`port ${port} (${label}) is busy. This script will not stop other processes; free the port or set APP_PORT, then retry.`);
    process.exit(1);
  }
}

const serverEntry = path.join(root, "server", "src", "main.ts");
const workerEntry = path.join(root, "server", "src", "simulation", "worker.ts");
if (!existsSync(serverEntry)) {
  say("server: server/src/main.ts not found, nothing to run");
  process.exit(1);
}

const childEnv: Record<string, string | undefined> = { ...process.env };
if (process.stdout.isTTY && !process.env.NO_COLOR) childEnv.FORCE_COLOR = "1";
const runEnv: Record<string, string | undefined> = prod ? { ...childEnv, NODE_ENV: "production" } : childEnv;
const watch = prod ? [] : ["--watch"];

const specs: Spec[] = [
  { name: "server", color: "\x1b[36m", cmd: [bun, ...watch, "server/src/main.ts"], cwd: root, env: runEnv },
];
if (existsSync(workerEntry)) {
  specs.push({ name: "worker", color: "\x1b[35m", cmd: [bun, ...watch, "server/src/simulation/worker.ts"], cwd: root, env: runEnv });
} else {
  say("worker: server/src/simulation/worker.ts not present yet, skipping");
}
if (startWeb) {
  specs.push({ name: "web", color: "\x1b[32m", cmd: [bun, "run", "dev"], cwd: path.join(root, "web"), env: childEnv });
} else if (!prod) {
  say("web: web/package.json with a dev script not present yet, skipping Vite");
}
if (prod && !existsSync(path.join(root, "web", "dist", "index.html"))) {
  say("warning: web/dist/index.html is missing, run bun run build (API will start without the built frontend)");
}

// ---- Supervision ----
let shuttingDown = false;
const children: Child[] = specs.map((spec) => ({ spec, proc: null, restarts: [], gaveUp: false }));

async function pipeLines(stream: ReadableStream<Uint8Array>, prefix: string, out: NodeJS.WriteStream): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) out.write(`${prefix} ${line}\n`);
  }
  buffer += decoder.decode();
  if (buffer !== "") out.write(`${prefix} ${buffer}\n`);
}

function start(child: Child): void {
  const { spec } = child;
  const prefix = tag(spec.name, spec.color);
  const proc: Proc = Bun.spawn({ cmd: spec.cmd, cwd: spec.cwd, env: spec.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  child.proc = proc;
  void pipeLines(proc.stdout, prefix, process.stdout).catch(() => undefined);
  void pipeLines(proc.stderr, prefix, process.stderr).catch(() => undefined);
  void proc.exited.then((code) => onExit(child, proc, code));
}

function onExit(child: Child, proc: Proc, code: number): void {
  if (child.proc === proc) child.proc = null;
  if (shuttingDown) return;
  const prefix = tag(child.spec.name, child.spec.color);
  const how = proc.signalCode ? `signal ${proc.signalCode}` : `code ${code}`;
  const now = Date.now();
  child.restarts = child.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
  if (child.restarts.length >= MAX_RESTARTS) {
    child.gaveUp = true;
    console.error(`${prefix} exited (${how}); giving up after ${MAX_RESTARTS} restarts within 60 s. Fix the error above and rerun.`);
    if (children.every((c) => c.gaveUp)) {
      say("every process has given up, exiting");
      process.exit(1);
    }
    return;
  }
  child.restarts.push(now);
  console.error(`${prefix} exited (${how}); restarting in 1 s (${child.restarts.length}/${MAX_RESTARTS} in the last 60 s)`);
  setTimeout(() => {
    if (!shuttingDown) start(child);
  }, RESTART_DELAY_MS);
}

function isAlive(proc: Proc): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const alive = children.map((c) => c.proc).filter((p): p is Proc => p !== null && isAlive(p));
  say(`${signal} received, stopping ${alive.length} child process(es)`);
  for (const proc of alive) proc.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const proc of alive) if (isAlive(proc)) proc.kill("SIGKILL");
  }, KILL_GRACE_MS);
  await Promise.all(alive.map((p) => p.exited));
  clearTimeout(timer);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

say(`${prod ? "prod" : "dev"} mode: starting ${children.map((c) => c.spec.name).join(", ")} (APP_PORT ${appPort})`);
for (const child of children) start(child);
