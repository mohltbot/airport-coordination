// Task 1: prove Terse 0.14.9 persistence and retry behavior on an isolated probe runtime.
// The probe runtime runs on its own port so restarting it never touches the simulator runtime.
//   bun test tests/integration/terse.test.ts --test-name-pattern bootstrap
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")
const DIR = join(ROOT, ".data/terse-probe")
const PORT = 7199
const URL = `http://127.0.0.1:${PORT}/v1/projects/local/actors`
const TERSE = join(process.env.HOME ?? "", ".bun/bin/terse")
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let proc: ReturnType<typeof Bun.spawn> | null = null

function scaffold() {
    mkdirSync(join(DIR, "src"), { recursive: true })
    cpSync(join(ROOT, "actors/src/Probe.ts"), join(DIR, "src/Probe.ts"))
    writeFileSync(join(DIR, "src/actors.ts"), 'export { Probe } from "./Probe.js"\n')
    writeFileSync(join(DIR, "package.json"), JSON.stringify({ name: "terse-probe", private: true, type: "module", dependencies: { "terse-sdk": "0.14.9" } }))
    cpSync(join(ROOT, "actors/tsconfig.json"), join(DIR, "tsconfig.json"))
    cpSync(join(ROOT, "actors/bunfig.toml"), join(DIR, "bunfig.toml"))
    if (!existsSync(join(DIR, "node_modules"))) symlinkSync(join(ROOT, "actors/node_modules"), join(DIR, "node_modules"))
}

async function listening(): Promise<boolean> {
    try {
        await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(500) })
        return true
    } catch {
        return false
    }
}

// Only stops the runtime this test started. Never touches the simulator runtime on 7100.
async function stopRuntime() {
    if (!proc) return
    proc.kill("SIGKILL")
    await proc.exited
    proc = null
    for (let i = 0; i < 50 && (await listening()); i++) await sleep(100)
}

async function startRuntime() {
    if (await listening()) throw new Error(`port ${PORT} is already in use by another process`)
    proc = Bun.spawn([TERSE, "actor", "dev", "--port", String(PORT)], { cwd: DIR, stdout: "ignore", stderr: "ignore", env: { ...process.env } })
    for (let i = 0; i < 300; i++) {
        if (await listening()) return
        await sleep(100)
    }
    throw new Error("probe runtime did not become ready")
}

let actors: any

beforeAll(async () => {
    scaffold()
    await startRuntime()
    const gen = Bun.spawnSync([TERSE, "actor", "generate", "--language", "typescript", "--non-interactive"], {
        cwd: DIR,
        env: { ...process.env, TERSE_ACTOR_URL: URL },
    })
    if (gen.exitCode !== 0) throw new Error(`generate failed: ${gen.stderr.toString().slice(0, 400)}`)
    process.env.TERSE_ACTOR_URL = URL
    actors = (await import(join(DIR, "generated/index.js"))).actors
}, 120_000)

afterAll(async () => {
    await stopRuntime()
})

describe("terse probe", () => {
    test("bootstrap: one aggregate survives a runtime restart and a replayed operation applies once", async () => {
        const id = `probe-${crypto.randomUUID()}`
        const first = await actors.Probe.get(id).apply("op-1", 0)
        expect(first).toMatchObject({ count: 1, duplicate: false })
        await stopRuntime()
        await startRuntime()
        const read = await actors.Probe.get(id).read()
        expect(read).toEqual({ count: 1, processedIds: ["op-1"], outbox: [{ messageId: "msg-op-1", operationId: "op-1" }] })
        const replay = await actors.Probe.get(id).apply("op-1", 0)
        expect(replay.duplicate).toBe(true)
        expect(replay.count).toBe(1)
        expect(replay.outbox).toHaveLength(1)
    }, 120_000)

    // Observed on 0.14.9: the caller gets an error, yet the runtime can finish the interrupted call
    // after restart (count 1 on read). The outcome is uncertain to the caller, so retries must carry
    // the same operation ID and the aggregate must dedupe it.
    test("bootstrap: a call interrupted mid-flight is uncertain; the same-ID retry applies exactly once", async () => {
        const id = `probe-${crypto.randomUUID()}`
        const pending = actors.Probe.get(id).apply("op-2", 4000).then(
            (v: unknown) => ({ ok: true, v }),
            (e: unknown) => ({ ok: false, e: String(e).slice(0, 200) }),
        )
        await sleep(1500)
        await stopRuntime()
        const outcome = await pending
        expect(outcome.ok).toBe(false)
        await startRuntime()
        const afterRestart = await actors.Probe.get(id).read()
        console.log(`interrupted call: count after restart = ${afterRestart.count}`)
        expect([0, 1]).toContain(afterRestart.count)
        expect(afterRestart.outbox).toHaveLength(afterRestart.count)
        const retry = await actors.Probe.get(id).apply("op-2", 0)
        expect(retry.count).toBe(1)
        expect(retry.duplicate).toBe(afterRestart.count === 1)
        const again = await actors.Probe.get(id).apply("op-2", 0)
        expect(again).toMatchObject({ count: 1, duplicate: true })
        expect(again.outbox).toHaveLength(1)
    }, 120_000)

    test("bootstrap: a call interrupted after it completes is kept; the retry is a duplicate", async () => {
        const id = `probe-${crypto.randomUUID()}`
        expect(await actors.Probe.get(id).apply("op-3", 0)).toMatchObject({ count: 1 })
        await stopRuntime()
        await startRuntime()
        const retry = await actors.Probe.get(id).apply("op-3", 0)
        expect(retry).toMatchObject({ count: 1, duplicate: true })
        expect(retry.outbox).toHaveLength(1)
    }, 120_000)
})
