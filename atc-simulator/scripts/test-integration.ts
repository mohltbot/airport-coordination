// bun run test:integration [-- --filter=<name>]
// --filter=bootstrap runs the Task 1 seam probes; any other value picks tests/integration/<name>.test.ts.
import { readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const dir = join(root, "tests/integration")
const filter = process.argv.slice(2).find(a => a.startsWith("--filter="))?.slice("--filter=".length)
let args: string[]
if (filter === "bootstrap") {
    args = ["tests/integration/terse.test.ts", "tests/integration/relay-sdk-probe.test.ts", "--test-name-pattern", "bootstrap"]
} else if (filter) {
    const file = readdirSync(dir).find(f => f === `${filter}.test.ts`)
    if (!file) {
        console.error(`no tests/integration/${filter}.test.ts`)
        process.exit(2)
    }
    args = [`tests/integration/${file}`]
} else {
    args = ["tests/integration"]
}
const proc = Bun.spawnSync(["bun", "test", ...args], { cwd: root, stdout: "inherit", stderr: "inherit", env: process.env })
process.exit(proc.exitCode ?? 1)
