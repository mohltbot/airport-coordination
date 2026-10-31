import { Actor, Persisted } from "terse-sdk/actor"

// Task 1 persistence probe: one aggregate {count, processedIds, outbox} written in one assignment.
export type ProbeAggregate = { count: number; processedIds: string[]; outbox: { messageId: string; operationId: string }[] }

export class Probe extends Actor<null, null> {
    @Persisted agg: ProbeAggregate = { count: 0, processedIds: [], outbox: [] }

    async apply(operationId: string, holdMs: number): Promise<ProbeAggregate & { duplicate: boolean }> {
        if (this.agg.processedIds.includes(operationId)) return { ...this.agg, duplicate: true }
        // Hold before the write so a test can kill the runtime mid-call.
        if (holdMs > 0) await new Promise(r => setTimeout(r, holdMs))
        this.agg = {
            count: this.agg.count + 1,
            processedIds: [...this.agg.processedIds, operationId],
            outbox: [...this.agg.outbox, { messageId: `msg-${operationId}`, operationId }],
        }
        return { ...this.agg, duplicate: false }
    }

    async read(): Promise<ProbeAggregate> {
        return this.agg
    }

    async onMessage() {}
}
