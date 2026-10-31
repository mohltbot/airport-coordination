import { Actor, Emittable, Persisted, type ActorSocket } from "terse-sdk/actor"

export type CounterMessage = { type: "increment" } | { type: "decrement" }

export class Counter extends Actor<null, CounterMessage> {
    @Persisted @Emittable value = 0

    async read() {
        return this.value
    }

    async increment() {
        return ++this.value
    }

    async decrement() {
        return --this.value
    }

    async onMessage(_socket: ActorSocket<null, CounterMessage>, message: CounterMessage) {
        if (message.type === "increment") await this.increment()
        else await this.decrement()
    }
}
