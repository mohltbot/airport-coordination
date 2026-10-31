import { Command } from "commander"
import { clearLine, createInterface, cursorTo } from "node:readline"
import { actors } from "./generated"

type StateMessage =
    | { type: "state"; state: actors.Counter.State }
    | { type: "state_update"; changes: Partial<actors.Counter.State> }

const commands: Record<string, actors.Counter.Incoming["type"]> = {
    "+": "increment",
    inc: "increment",
    increment: "increment",
    "-": "decrement",
    dec: "decrement",
    decrement: "decrement",
}

const help = "Commands: + (increment), - (decrement), q (quit)"

await new Command()
    .description("Connect to a counter over a WebSocket and change it live")
    .option("--id <id>", "counter ID; clients on the same ID share one value", "counter")
    .action(async ({ id }: { id: string }) => {
        const { websocketUrl } = await actors.Counter.prepareWebsocket({ actorId: id, metadata: null })
        const socket = new WebSocket(websocketUrl)
        await new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true })
            socket.addEventListener("error", () => reject(new Error(`Could not connect to counter "${id}"`)), { once: true })
        })

        const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " })
        // Updates can arrive while the user is typing, so print above the prompt and redraw it.
        const print = (line: string) => {
            clearLine(process.stdout, 0)
            cursorTo(process.stdout, 0)
            console.log(line)
            rl.prompt(true)
        }

        socket.addEventListener("message", ({ data }) => {
            const message: StateMessage = JSON.parse(String(data))
            const value = message.type === "state" ? message.state.value : message.changes.value
            if (value !== undefined) print(`count: ${value}`)
        })

        let quitting = false
        const closed = new Promise<void>(resolve => {
            socket.addEventListener("close", ({ code, reason }) => {
                if (!quitting) print(`Disconnected (${code}${reason ? `: ${reason}` : ""})`)
                rl.close()
                resolve()
            })
        })

        rl.on("line", line => {
            const input = line.trim().toLowerCase()
            if (["q", "quit", "exit"].includes(input)) return rl.close()
            const type = commands[input]
            if (type) socket.send(JSON.stringify({ type }))
            else if (input) console.log(help)
            rl.prompt()
        })
        rl.on("close", () => {
            quitting = true
            socket.close()
        })

        console.log(`Connected to counter "${id}". ${help}`)
        rl.prompt()
        await closed
    })
    .parseAsync()
