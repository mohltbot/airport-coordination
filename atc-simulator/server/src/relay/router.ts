// Verified inbox router (design §7): authenticate sender against the run registry, enforce the
// message-type/role matrix and payload identity, invoke the target's durable inbox, then emit
// a DOMAIN_ACK through Relay. The target actor is the dedup authority keyed by (runId, messageId);
// transport message IDs are never used for dedup.
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import {
    entityHandle,
    entityRole,
    type DomainResult,
    type EntityId,
    type EntityRegistration,
    type MessageType,
    type ProtocolEnvelope,
    type ReceivedEnvelope,
    type RelayTransport,
    type Role,
} from "@ghost-tower/domain/contracts"
import type { EntityInboxPort } from "./transport.ts"

// Who may send what to whom. DOMAIN_ACK is allowed between any two different entities.
const MATRIX: Record<Exclude<MessageType, "DOMAIN_ACK">, { from: Role[]; to: Role[] }> = {
    INCIDENT_CREATE: { from: ["CONTROLLER"], to: ["ATC", "PILOT"] },
    INCIDENT_CLEAR: { from: ["CONTROLLER"], to: ["ATC", "PILOT"] },
    COMMAND_RESULT: { from: ["ATC", "PILOT"], to: ["CONTROLLER"] },
    AIRPORT_STATUS: { from: ["ATC"], to: ["PILOT"] },
    LANDING_REQUEST: { from: ["PILOT"], to: ["ATC"] },
    LANDING_OFFER: { from: ["ATC"], to: ["PILOT"] },
    LANDING_REFUSED: { from: ["ATC"], to: ["PILOT"] },
    OFFER_ACCEPT: { from: ["PILOT"], to: ["ATC"] },
    OFFER_DECLINE: { from: ["PILOT"], to: ["ATC"] },
    LANDING_CONFIRMED: { from: ["ATC"], to: ["PILOT"] },
    RESERVATION_RELEASE: { from: ["PILOT"], to: ["ATC"] },
    RESERVATION_REVOKED: { from: ["ATC"], to: ["PILOT"] },
    RESERVATION_STATUS_REQUEST: { from: ["PILOT"], to: ["ATC"] },
    RESERVATION_STATUS: { from: ["ATC"], to: ["PILOT"] },
    CLEARANCE_REQUEST: { from: ["PILOT"], to: ["ATC"] },
    CLEARANCE_GRANTED: { from: ["ATC"], to: ["PILOT"] },
    CLEARANCE_REFUSED: { from: ["ATC"], to: ["PILOT"] },
}

const suffix = (id: EntityId) => (id === "controller" ? "controller" : id.slice(id.indexOf(":") + 1))

/** Returns a reason string when the envelope's type, roles or payload identity are not allowed. */
export function authorizationError(m: ProtocolEnvelope): string | null {
    if (m.fromEntityId === m.toEntityId) return "sender and recipient are the same entity"
    if (m.type === "DOMAIN_ACK") return null
    const rule = MATRIX[m.type]
    const fromRole = entityRole(m.fromEntityId)
    const toRole = entityRole(m.toEntityId)
    if (!rule.from.includes(fromRole) || !rule.to.includes(toRole)) return `${m.type} not allowed from ${fromRole} to ${toRole}`
    const from = suffix(m.fromEntityId)
    switch (m.type) {
        case "INCIDENT_CREATE":
        case "INCIDENT_CLEAR":
            return m.payload.target === m.toEntityId ? null : "incident target does not match recipient"
        case "LANDING_REQUEST":
        case "RESERVATION_RELEASE":
            return m.payload.flightId === from ? null : "payload flightId does not match sender"
        case "AIRPORT_STATUS":
        case "LANDING_OFFER":
        case "LANDING_REFUSED":
            return m.payload.airportId === from ? null : "payload airportId does not match sender"
        default:
            return null
    }
}

// ---------------------------------------------------------------- controller command proof

/** Fields bound by the server-issued proof on INCIDENT_CREATE / INCIDENT_CLEAR envelopes. */
export type CommandProofFields = {
    runId: string
    commandId: string
    commandSequence: number
    toEntityId: string
    type: "INCIDENT_CREATE" | "INCIDENT_CLEAR"
    incidentId: string
}
const proofInput = (f: CommandProofFields) => [f.runId, f.commandId, f.commandSequence, f.toEntityId, f.type, f.incidentId].join("|")

/** Gateway / SimulationActor side: `authorization` value for a controller command envelope. */
export function commandProof(secret: string, f: CommandProofFields): string {
    return `v1.${createHmac("sha256", secret).update(proofInput(f)).digest("hex")}`
}

export function verifyCommandProof(secret: string, f: CommandProofFields, proof: string): boolean {
    const expected = commandProof(secret, f)
    return proof.length === expected.length && timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
}

// ---------------------------------------------------------------- ACKs

/** Deterministic UUID (version 8 layout) so a re-sent ACK reuses its Relay idempotency key. */
export function derivedUuid(seed: string): string {
    const h = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("")
    h[12] = "8"
    h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
    const s = h.join("")
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

export function buildDomainAck(m: ReceivedEnvelope, resultCode: string, nowWallMs: number): ProtocolEnvelope {
    return {
        schemaVersion: 1,
        messageId: derivedUuid(`ack:${m.runId}:${m.messageId}`),
        runId: m.runId,
        fromEntityId: m.toEntityId,
        toEntityId: m.fromEntityId,
        type: "DOMAIN_ACK",
        correlationId: m.correlationId,
        causationId: m.messageId,
        createdAtWallMs: nowWallMs,
        expiresAtWallMs: null,
        payload: { processedMessageId: m.messageId, resultCode: resultCode.slice(0, 64) },
    }
}

// ---------------------------------------------------------------- routing

export type RouteEvent = {
    messageId: string
    type: MessageType
    from: EntityId
    to: EntityId
    transportMessageId: string
    outcome: DomainResult["outcome"] | "SKIPPED"
    code: string
    detail: string | null
    ackSent: boolean
    latencyMs: number // createdAtWallMs to routed
}

export type RouterContext = {
    runId: string
    registry: EntityRegistration[]
    inbox: EntityInboxPort
    /** Used to send DOMAIN_ACKs from the recipient's identity. Omit to disable ACKs. */
    transport?: RelayTransport
    /** When set, INCIDENT_* envelopes must carry a valid proof from commandProof(). */
    commandSecret?: string | null
    now?: () => number
    log?: (e: RouteEvent) => void
    /**
     * Messages whose actor receive already committed in this process. Lets the router skip the
     * second copy (local echo plus log reconciliation) without an actor call. Not the dedup authority.
     */
    memo?: Set<string>
    /** "background" (default) sends the ACK without blocking the caller; "await" waits for Relay. */
    ackMode?: "background" | "await"
    pendingAcks?: Set<Promise<boolean>>
}

const reject = (code: string): DomainResult => ({ outcome: "REJECTED", code, stateRevision: 0 })

/**
 * Validate and deliver one received envelope. Throws only when the target inbox is
 * unreachable, so the caller (log reconciliation) keeps the message for a retry.
 */
export async function routeReceived(m: ReceivedEnvelope, ctx: RouterContext): Promise<DomainResult> {
    const now = ctx.now ?? Date.now
    const started = now()
    const emit = (outcome: RouteEvent["outcome"], code: string, detail: string | null, ackSent = false) =>
        ctx.log?.({
            messageId: m.messageId,
            type: m.type,
            from: m.fromEntityId,
            to: m.toEntityId,
            transportMessageId: m.transportMessageId,
            outcome,
            code,
            detail,
            ackSent,
            latencyMs: started - m.createdAtWallMs,
        })

    if (m.runId !== ctx.runId) {
        emit("REJECTED", "WRONG_RUN", `run ${m.runId}`)
        return reject("WRONG_RUN")
    }
    const sender = ctx.registry.find(r => r.handle === m.senderHandle)
    if (!sender || sender.entityId !== m.fromEntityId || m.senderHandle !== entityHandle(ctx.runId, m.fromEntityId)) {
        emit("REJECTED", "UNAUTHORIZED", `sender ${m.senderHandle} is not registered as ${m.fromEntityId}`)
        return reject("UNAUTHORIZED")
    }
    const recipient = ctx.registry.find(r => r.entityId === m.toEntityId)
    if (!recipient || recipient.handle !== m.recipientHandle) {
        emit("REJECTED", "UNAUTHORIZED", `recipient ${m.toEntityId} is not registered in this run`)
        return reject("UNAUTHORIZED")
    }
    const authError = authorizationError(m)
    if (authError) {
        emit("REJECTED", "UNAUTHORIZED", authError)
        return reject("UNAUTHORIZED")
    }
    if ((m.type === "INCIDENT_CREATE" || m.type === "INCIDENT_CLEAR") && ctx.commandSecret) {
        const ok = verifyCommandProof(
            ctx.commandSecret,
            {
                runId: m.runId,
                commandId: m.commandId,
                commandSequence: m.commandSequence,
                toEntityId: m.toEntityId,
                type: m.type,
                incidentId: m.payload.incidentId,
            },
            m.authorization,
        )
        if (!ok) {
            emit("REJECTED", "UNAUTHORIZED", "invalid command proof")
            return reject("UNAUTHORIZED")
        }
    }

    const memoKey = `${m.runId}:${m.messageId}`
    if (ctx.memo?.has(memoKey)) {
        emit("SKIPPED", "DUPLICATE", "already committed in this process")
        return { outcome: "DUPLICATE", code: "DUPLICATE", stateRevision: 0, original: { outcome: "APPLIED", code: "OK", stateRevision: 0 } }
    }

    // Throws if the actor is unavailable; reconciliation retries from the unchanged cursor.
    const result = await ctx.inbox.receive(m.toEntityId, m)
    ctx.memo?.add(memoKey)

    // ACK after the actor persisted the receipt. ACKs are never ACKed. A lost ACK is recovered
    // when the sender's retry reaches us again and the actor answers DUPLICATE.
    // A hosted send takes 2.5 to 4 s, so by default the ACK goes out in the background and the
    // reconciliation loop moves on; ctx.pendingAcks lets tests and shutdown wait for them.
    let ackSent = false
    if (m.type !== "DOMAIN_ACK" && ctx.transport) {
        const code = result.outcome === "DUPLICATE" ? result.original.code : result.code
        const sending = ctx.transport.send(buildDomainAck(m, code, now())).then(
            () => true,
            err => {
                emit(result.outcome, result.code, `ack send failed: ${(err as Error).message}`)
                return false
            },
        )
        if (ctx.ackMode === "await") ackSent = await sending
        else {
            ctx.pendingAcks?.add(sending)
            void sending.finally(() => ctx.pendingAcks?.delete(sending))
            ackSent = true
        }
    }
    emit(result.outcome, result.code, null, ackSent)
    return result
}

/** Subscribe the router to a transport. Returns the unsubscribe function. */
export function attachRouter(transport: RelayTransport, ctx: Omit<RouterContext, "transport">): () => void {
    const full: RouterContext = { ...ctx, transport, memo: ctx.memo ?? new Set() }
    return transport.onMessage(async m => {
        await routeReceived(m, full)
    })
}
