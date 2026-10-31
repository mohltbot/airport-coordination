// RelayTransport contract plus the wire codec shared by the hosted adapter, the router and tests.
//
// Wire format on hosted Relaycast (measured 2026-10-31; numbers in agent-relay.ts):
//   every entity has its own Relay identity (handle from entityHandle()), and posts to the
//   run's channel `ghost-<runId first 8>` with its own token.
//   text     = JSON.stringify(ProtocolEnvelope)          (max 8 KiB UTF-8)
//   data     = { to: <recipient handle>, messageId, runId, type, correlationId }   (comes back as `metadata`)
// correlationId is the stable thread key (roundId, incidentId or commandId) and travels unchanged;
// a DOMAIN_ACK carries the correlationId of the message it acknowledges.
// Relay authenticates the sender (event `agent_name` is the token's identity). Recipient
// addressing is application level: metadata.to must equal the envelope's toEntityId handle.
// DMs were measured at 7 to 12 s per send and `dm.received` events carry no recipient or
// metadata, so the channel path is used instead.
import {
    ProtocolEnvelopeSchema,
    entityHandle,
    entityRole,
    type DomainResult,
    type EntityId,
    type EntityRegistration,
    type ProtocolEnvelope,
    type ReceivedEnvelope,
    type RelayTransport,
} from "@ghost-tower/domain/contracts"
import { MAX_RELAY_BODY_BYTES } from "@ghost-tower/domain/constants"

export type { RelayTransport }

export const runChannelName = (runId: string) => `ghost-${runId.slice(0, 8)}`

export function registrationsFor(runId: string, entityIds: EntityId[]): EntityRegistration[] {
    return entityIds.map(entityId => ({ entityId, handle: entityHandle(runId, entityId), role: entityRole(entityId) }))
}

export class RelayTransportError extends Error {
    constructor(
        message: string,
        readonly code: string,
        readonly retryable: boolean,
        readonly status: number | null = null,
    ) {
        super(message)
        this.name = "RelayTransportError"
    }
}

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength

/** Encode an envelope for Relay. Throws INVALID_PAYLOAD if it is malformed or over 8 KiB. */
export function encodeEnvelope(envelope: ProtocolEnvelope): { text: string; data: RelayMessageData } {
    const parsed = ProtocolEnvelopeSchema.safeParse(envelope)
    if (!parsed.success) throw new RelayTransportError(`invalid envelope: ${parsed.error.issues[0]?.message ?? "schema"}`, "INVALID_PAYLOAD", false)
    const text = JSON.stringify(parsed.data)
    if (utf8Bytes(text) > MAX_RELAY_BODY_BYTES) throw new RelayTransportError("envelope exceeds 8 KiB", "INVALID_PAYLOAD", false)
    return {
        text,
        data: {
            to: entityHandle(envelope.runId, envelope.toEntityId),
            messageId: envelope.messageId,
            runId: envelope.runId,
            type: envelope.type,
            correlationId: envelope.correlationId,
        },
    }
}

export type RelayMessageData = { to: string; messageId: string; runId: string; type: string; correlationId: string }

/** A message as Relay reported it, before any application validation. */
export type RawRelayMessage = {
    transportMessageId: string
    senderHandle: string // authenticated by Relay (agent_name of the posting token)
    recipientHandle: string | null // metadata.to, application level
    text: string
    channel: string
    receivedAtWallMs: number
    via: "poll" | "echo" | "test"
}

export type DecodeResult =
    | { ok: true; message: ReceivedEnvelope }
    | { ok: false; code: "INVALID_PAYLOAD" | "WRONG_RUN" | "UNAUTHORIZED"; detail: string; messageId: string | null }

/**
 * Turn a raw Relay message into a ReceivedEnvelope. The size check runs before JSON parsing.
 * The envelope is parsed strictly first (so a sender cannot smuggle senderHandle or
 * transportMessageId inside its text), then Relay-authenticated fields are attached.
 */
export function decodeRelayMessage(raw: RawRelayMessage, expectedRunId: string): DecodeResult {
    if (utf8Bytes(raw.text) > MAX_RELAY_BODY_BYTES) return { ok: false, code: "INVALID_PAYLOAD", detail: "body exceeds 8 KiB", messageId: null }
    let json: unknown
    try {
        json = JSON.parse(raw.text)
    } catch {
        return { ok: false, code: "INVALID_PAYLOAD", detail: "not JSON", messageId: null }
    }
    const parsed = ProtocolEnvelopeSchema.safeParse(json)
    const idGuess = typeof (json as any)?.messageId === "string" ? String((json as any).messageId) : null
    if (!parsed.success) return { ok: false, code: "INVALID_PAYLOAD", detail: parsed.error.issues[0]?.message ?? "schema", messageId: idGuess }
    const env = parsed.data
    if (env.runId !== expectedRunId) return { ok: false, code: "WRONG_RUN", detail: `run ${env.runId}`, messageId: env.messageId }
    if (raw.senderHandle !== entityHandle(env.runId, env.fromEntityId))
        return { ok: false, code: "UNAUTHORIZED", detail: `sender ${raw.senderHandle} is not ${env.fromEntityId}`, messageId: env.messageId }
    const expectedTo = entityHandle(env.runId, env.toEntityId)
    if (raw.recipientHandle !== null && raw.recipientHandle !== expectedTo)
        return { ok: false, code: "UNAUTHORIZED", detail: `recipient ${raw.recipientHandle} is not ${env.toEntityId}`, messageId: env.messageId }
    return {
        ok: true,
        message: {
            ...env,
            transportMessageId: raw.transportMessageId,
            senderHandle: raw.senderHandle,
            recipientHandle: expectedTo,
            receivedAtWallMs: raw.receivedAtWallMs,
        } as ReceivedEnvelope,
    }
}

// ---------------------------------------------------------------- ports the worker wires to actors

/**
 * The durable inbox of a target entity. The worker implements this by calling the target
 * actor's `receive(context, message)` (or the SimulationActor controller inbox for
 * `controller`) with its current MutationContext. The actor is the dedup authority,
 * keyed by (runId, messageId), and returns DUPLICATE with the stored result on replay.
 * Throw when the actor is unreachable; the router then leaves the message for reconciliation.
 */
export interface EntityInboxPort {
    receive(entityId: EntityId, message: ReceivedEnvelope): Promise<DomainResult>
}

/**
 * Durable outbox access for the dispatcher. `list` returns un-acknowledged entries;
 * `recordAttempt` persists the transport receipt and next retry time
 * (actor `markTransportAccepted`). Entries are removed or marked acknowledged only by the
 * owning actor when a DOMAIN_ACK / COMMAND_RESULT for the message arrives through Relay.
 */
export interface OutboxPort {
    entities(): Promise<EntityId[]>
    list(entityId: EntityId): Promise<import("@ghost-tower/domain/contracts").OutboxEntry[]>
    recordAttempt(
        entityId: EntityId,
        attempt: { messageId: string; transportMessageId: string | null; attemptCount: number; nextAttemptAtWallMs: number },
    ): Promise<void>
}

/** Where the hosted adapter keeps its workspace-event read cursor (SimulationRootState.relayEventCursor). */
export interface CursorStore {
    load(): Promise<number>
    save(seq: number): Promise<void>
}

export const memoryCursorStore = (start = 0): CursorStore & { value: () => number } => {
    let v = start
    return { load: async () => v, save: async s => void (v = s), value: () => v }
}

export type RejectedRelayMessage = { raw: RawRelayMessage; code: string; detail: string; messageId: string | null }

/** In-process transport for contract tests. Same codec and checks as the hosted adapter, no network. */
export class LoopbackRelayTransport implements RelayTransport {
    private handlers = new Set<(m: ReceivedEnvelope) => Promise<void>>()
    private runId: string | null = null
    private handles = new Map<string, EntityRegistration>()
    private seq = 0
    readonly sent: { transportMessageId: string; text: string; senderHandle: string; recipientHandle: string }[] = []
    readonly rejected: RejectedRelayMessage[] = []

    async connect(runId: string, entities: EntityRegistration[]) {
        this.runId = runId
        for (const e of entities) this.handles.set(e.handle, e)
    }
    async send(envelope: ProtocolEnvelope) {
        if (!this.runId) throw new RelayTransportError("not connected", "NOT_CONNECTED", true)
        const { text, data } = encodeEnvelope(envelope)
        const senderHandle = entityHandle(envelope.runId, envelope.fromEntityId)
        if (!this.handles.has(senderHandle)) throw new RelayTransportError(`no identity for ${envelope.fromEntityId}`, "UNKNOWN_IDENTITY", false)
        const transportMessageId = `loop-${++this.seq}`
        this.sent.push({ transportMessageId, text, senderHandle, recipientHandle: data.to })
        await this.deliverRaw({ transportMessageId, senderHandle, recipientHandle: data.to, text, channel: runChannelName(this.runId), receivedAtWallMs: Date.now(), via: "test" })
        return { transportMessageId }
    }
    /** Inject a raw message as if Relay delivered it (spoofed sender, other runs, oversize bodies). */
    async deliverRaw(raw: RawRelayMessage) {
        if (!this.runId) return
        const decoded = decodeRelayMessage(raw, this.runId)
        if (!decoded.ok) {
            this.rejected.push({ raw, code: decoded.code, detail: decoded.detail, messageId: decoded.messageId })
            return
        }
        for (const h of this.handlers) await h(decoded.message)
    }
    onMessage(handler: (m: ReceivedEnvelope) => Promise<void>) {
        this.handlers.add(handler)
        return () => void this.handlers.delete(handler)
    }
    async disconnect() {
        this.handlers.clear()
    }
}
