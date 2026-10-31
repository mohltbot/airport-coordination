// Generate typed Terse clients into server/generated from the running local actor runtime.
// Requires `bun run actors:dev` (terse actor dev in actors/) to be up and reloaded.
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const url = process.env.TERSE_ACTOR_URL ?? "http://127.0.0.1:7100/v1/projects/local/actors"
const terse = Bun.which("terse") ?? join(process.env.HOME ?? "", ".bun/bin/terse")
const proc = Bun.spawnSync([terse, "actor", "generate", "--language", "typescript", "--non-interactive", "--out-dir", "generated"], {
    cwd: join(root, "server"),
    env: { ...process.env, TERSE_ACTOR_URL: url },
    stdout: "inherit",
    stderr: "inherit",
})
process.exit(proc.exitCode ?? 1)
