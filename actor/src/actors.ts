import { Actor, Emittable, Persisted } from "terse-sdk/actor"

export type EventData = Record<string, string | number | boolean | null>

export type RoomEvent = {
    id: string
    from: string
    text: string
    data: EventData | null
    at: string
    source: "relay" | "alarm" | "phone"
}

type Incoming = { type: "ping" }

// One Room per coordination session. It holds the shared event log every screen watches.
export class Room extends Actor<null, Incoming> {
    @Persisted @Emittable events: RoomEvent[] = []
    @Persisted @Emittable alarmAt: number | null = null

    async record(event: RoomEvent) {
        if (this.events.some(e => e.id === event.id)) return false
        // Reassign instead of push so the change is persisted and emitted.
        this.events = [...this.events, event].slice(-200)
        return true
    }

    async snapshot() {
        return { events: this.events, alarmAt: this.alarmAt }
    }

    async armAlarm(delayMs: number) {
        const at = Date.now() + delayMs
        this.alarm.set(at)
        this.alarmAt = at
        return at
    }

    async onAlarm() {
        const firedAt = Date.now()
        const scheduled = this.alarmAt
        await this.record({
            id: `alarm-${scheduled ?? firedAt}`,
            from: "room",
            text: `Alarm fired ${scheduled ? `${firedAt - scheduled} ms after it was due` : ""}`.trim(),
            data: { scheduledAt: scheduled, firedAt },
            at: new Date(firedAt).toISOString(),
            source: "alarm",
        })
        this.alarmAt = null
    }

    async onMessage() {}
}
