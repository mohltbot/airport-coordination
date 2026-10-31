// DEVELOPMENT DATA for offline UI work. Parsed against the public schema so drift fails loudly.
// Not live agent or Relay activity; integration acceptance needs the real actor/Relay path.
import raw from "./fixtures/public-snapshot.json" with { type: "json" }
import { PublicSnapshotSchema, type PublicSnapshot } from "../packages/domain/src/contracts.ts"

export const samplePublicSnapshot: PublicSnapshot = PublicSnapshotSchema.parse(raw)
