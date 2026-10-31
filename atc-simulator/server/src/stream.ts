// Full-snapshot SSE (contract "HTTP and SSE"): named events `snapshot` (id = projectionVersion),
// `command` (full CommandReceipt) and `run-reset`. Headers disable buffering and transforms so
// Vite's proxy and the cloudflared tunnel pass frames through immediately; nothing is compressed.
import type { HubEvent, ProjectionHub } from "./projection.ts"

const encoder = new TextEncoder()

export const SSE_HEADERS = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
}

export function formatEvent(event: HubEvent): string {
    switch (event.type) {
        case "snapshot":
            return `event: snapshot\nid: ${event.snapshot.projectionVersion}\ndata: ${JSON.stringify(event.snapshot)}\n\n`
        case "command":
            return `event: command\ndata: ${JSON.stringify(event.receipt)}\n\n`
        case "run-reset":
            return `event: run-reset\ndata: ${JSON.stringify({ previousRunId: event.previousRunId, activeRunId: event.activeRunId })}\n\n`
    }
}

export function sseResponse(hub: ProjectionHub, runId: string, signal: AbortSignal): Response {
    let unsubscribe: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    const cleanup = () => {
        unsubscribe?.()
        unsubscribe = null
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = null
    }
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const write = (text: string) => {
                try {
                    controller.enqueue(encoder.encode(text))
                } catch {
                    cleanup()
                }
            }
            // 2 KiB padding comment defeats proxies that hold the first bytes back.
            write(`: ${" ".repeat(2048)}\nretry: 1000\n\n`)
            unsubscribe = hub.subscribe(runId, event => write(formatEvent(event)))
            // Comment heartbeats keep idle proxies open; snapshots still prove freshness.
            heartbeat = setInterval(() => write(": hb\n\n"), 15_000)
            signal.addEventListener("abort", () => {
                cleanup()
                try {
                    controller.close()
                } catch {}
            })
        },
        cancel() {
            cleanup()
        },
    })
    return new Response(body, { headers: SSE_HEADERS })
}
