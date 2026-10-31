# Actors

Requires Bun 1.4.2+ on your PATH.

```sh
bun install
terse actor dev
```

Define your actors in `src/actors.ts`. The starter contains a counter with persisted state and `read()`, `increment()`, and `decrement()` methods. Each counter ID has its own saved value. WebSocket clients can send `{ "type": "increment" }` or `{ "type": "decrement" }`, and every connected client receives the new value as an `@Emittable` state update.

`terse actor dev` watches your actor source and stores local state in `.durable-actors/`. It defaults to project ID `local`; choose another with `terse actor dev --project-id my-project`.

## Connect your application

In your separate application project's directory:

1. Run `bun add terse-sdk zod`.
2. Use the local defaults: project `local`, URL `http://127.0.0.1:7100`, and no secret. If you configure a different project, port, or optional secret on the actor server, put matching settings in your application’s `.env` or `.env.local` file.
3. Run `terse actor generate --language typescript`; the CLI loads both environment files automatically. Exported environment variables take precedence over `.env.local`, which takes precedence over `.env`.

Your application backend can then use the generated client:

```ts
import { actors } from "./generated/index.js"

const counter = actors.Counter.get("example")
console.log(await counter.increment())
```

Use `bun run --bun check` to check types. Deploy with `terse deploy`. See the [TypeScript SDK](https://docs.useterse.ai/reference/typescript-sdk).
