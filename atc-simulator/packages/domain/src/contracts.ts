// Shared Zod schemas and inferred types (plan §3, design §5 to §8).
// Simulation fields are seconds (…Sec); wall-clock fields are milliseconds (…Ms).
// Control messages reject unknown properties (strict objects).
import { z } from "zod"
import {
    AIRPORT_IDS,
    FLIGHT_COUNT_MAX,
    FLIGHT_COUNT_MIN,
    MAX_MESSAGE_SUMMARY_CHARS,
    MAX_REASON_CHARS,
    RUNWAY_IDS,
    SEED_MAX,
} from "./constants.js"

// ---------------------------------------------------------------- primitives

const Id = z.string().min(1).max(128)
export const UuidSchema = z.uuid()
export const RunIdSchema = z.uuid()
export const SimSecSchema = z.number().finite().nonnegative()
export const WallMsSchema = z.number().int().nonnegative()
export const RevisionSchema = z.number().int().nonnegative()

export const AirportIdSchema = z.enum(AIRPORT_IDS)
export type AirportId = z.infer<typeof AirportIdSchema>
export const FlightIdSchema = z.string().regex(/^F\d{3}$/)
export type FlightId = string
export const RunwayIdSchema = z.enum(RUNWAY_IDS)
export type RunwayId = z.infer<typeof RunwayIdSchema>

export type AirportEntityId = `airport:${string}`
export type FlightEntityId = `flight:${string}`
export type EntityId = AirportEntityId | FlightEntityId | "controller"

export const AirportEntityIdSchema = z.custom<AirportEntityId>(
    v => typeof v === "string" && /^airport:(ALP|BRV|CHR)$/.test(v),
    { message: "expected airport:<ALP|BRV|CHR>" },
)
export const FlightEntityIdSchema = z.custom<FlightEntityId>(
    v => typeof v === "string" && /^flight:F\d{3}$/.test(v),
    { message: "expected flight:F###" },
)
export const ControllerEntityIdSchema = z.literal("controller")
export const EntityIdSchema = z.union([AirportEntityIdSchema, FlightEntityIdSchema, ControllerEntityIdSchema])

export const airportEntityId = (id: AirportId): AirportEntityId => `airport:${id}`
export const flightEntityId = (id: string): FlightEntityId => `flight:${id}`

export const RunPhaseSchema = z.enum(["CONFIGURING", "STARTING", "PAUSED", "RUNNING", "COMPLETED", "RESETTING"])
export type RunPhase = z.infer<typeof RunPhaseSchema>
export const FlightPhaseSchema = z.enum(["ENROUTE", "HOLDING", "APPROACH", "LANDED", "UNRESOLVED"])
export type FlightPhase = z.infer<typeof FlightPhaseSchema>
export const PrioritySchema = z.enum(["NORMAL", "EMERGENCY"])
export type Priority = z.infer<typeof PrioritySchema>
export const RoleSchema = z.enum(["CONTROLLER", "PILOT", "ATC"])
export type Role = z.infer<typeof RoleSchema>

export const PointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() })
export type Point = z.infer<typeof PointSchema> // nautical miles

export const SpeedSchema = z.union([z.literal(1), z.literal(5), z.literal(10)])
export type Speed = z.infer<typeof SpeedSchema>

export const RunConfigSchema = z.strictObject({
    flightCount: z.number().int().min(FLIGHT_COUNT_MIN).max(FLIGHT_COUNT_MAX),
    seed: z.number().int().min(0).max(SEED_MAX),
    speed: SpeedSchema,
})
export type RunConfig = z.infer<typeof RunConfigSchema>

export const MutationContextSchema = z.strictObject({
    runId: RunIdSchema,
    workerEpoch: z.number().int().nonnegative(),
    leaseToken: z.string().min(1).max(256),
    simNowSec: SimSecSchema,
    wallNowMs: WallMsSchema,
    operationId: Id,
})
export type MutationContext = z.infer<typeof MutationContextSchema>

export const TickSchema = z.strictObject({ tickId: Id, fromSimSec: SimSecSchema, toSimSec: SimSecSchema })
export type Tick = z.infer<typeof TickSchema>

// ---------------------------------------------------------------- codes

export const DomainCodeSchema = z.enum([
    "OK",
    "CLOSED",
    "NO_CAPACITY",
    "UNREACHABLE",
    "DEADLINE_EXCEEDED",
    "OFFER_EXPIRED",
    "STALE_STATE",
    "WRONG_RUN",
    "UNAUTHORIZED",
    "INVALID_PAYLOAD",
    "UNKNOWN_INCIDENT",
    "REVISION_CONFLICT",
    "ALREADY_TERMINAL",
    "INVALID_LEASE",
    "WRONG_PHASE",
    "TIMEOUT",
    "NO_FEASIBLE_AIRPORT",
])
export type DomainCode = z.infer<typeof DomainCodeSchema>
export const TerminalReasonSchema = z.enum(["FUEL_EXHAUSTED", "EMERGENCY_DEADLINE"])
export type TerminalReason = z.infer<typeof TerminalReasonSchema>

const DomainResultBase = z.strictObject({
    outcome: z.enum(["APPLIED", "REJECTED"]),
    code: z.string().min(1).max(64),
    stateRevision: RevisionSchema,
})
export const DomainResultSchema = z.union([
    DomainResultBase,
    z.strictObject({
        outcome: z.literal("DUPLICATE"),
        code: z.string().min(1).max(64),
        stateRevision: RevisionSchema,
        original: DomainResultBase,
    }),
])
export type DomainResult = z.infer<typeof DomainResultSchema>

// ---------------------------------------------------------------- incidents

export const AirportIncidentKindSchema = z.enum(["WEATHER_CLOSED", "RUNWAY_CLOSED", "CAPACITY_REDUCED"])
export const FlightIncidentKindSchema = z.enum(["SMOKE", "ENGINE_TROUBLE", "LOW_FUEL"])
export const IncidentKindSchema = z.enum([
    "WEATHER_CLOSED",
    "RUNWAY_CLOSED",
    "CAPACITY_REDUCED",
    "SMOKE",
    "ENGINE_TROUBLE",
    "LOW_FUEL",
])
export type IncidentKind = z.infer<typeof IncidentKindSchema>
export type AirportIncidentKind = z.infer<typeof AirportIncidentKindSchema>
export type FlightIncidentKind = z.infer<typeof FlightIncidentKindSchema>

const EmptyParams = z.record(z.string(), z.never())
const RunwayParams = z.strictObject({ runwayId: RunwayIdSchema })
export const IncidentParametersSchema = z.union([EmptyParams, RunwayParams])
export type IncidentParameters = Record<string, never> | { runwayId: RunwayId }

// Target-kind matrix: airport kinds need airport:*, flight kinds need flight:*,
// and only RUNWAY_CLOSED takes a runwayId.
export const IncidentCreateSchema = z.discriminatedUnion("kind", [
    z.strictObject({ incidentId: UuidSchema, target: AirportEntityIdSchema, kind: z.literal("WEATHER_CLOSED"), parameters: EmptyParams }),
    z.strictObject({ incidentId: UuidSchema, target: AirportEntityIdSchema, kind: z.literal("RUNWAY_CLOSED"), parameters: RunwayParams }),
    z.strictObject({ incidentId: UuidSchema, target: AirportEntityIdSchema, kind: z.literal("CAPACITY_REDUCED"), parameters: EmptyParams }),
    z.strictObject({ incidentId: UuidSchema, target: FlightEntityIdSchema, kind: z.literal("SMOKE"), parameters: EmptyParams }),
    z.strictObject({ incidentId: UuidSchema, target: FlightEntityIdSchema, kind: z.literal("ENGINE_TROUBLE"), parameters: EmptyParams }),
    z.strictObject({ incidentId: UuidSchema, target: FlightEntityIdSchema, kind: z.literal("LOW_FUEL"), parameters: EmptyParams }),
])
export type IncidentCreate = z.infer<typeof IncidentCreateSchema>

export const IncidentClearSchema = z.strictObject({
    incidentId: UuidSchema,
    target: z.union([AirportEntityIdSchema, FlightEntityIdSchema]),
    expectedIncidentRevision: RevisionSchema,
})
export type IncidentClear = z.infer<typeof IncidentClearSchema>

export const IncidentCommandSchema = z.discriminatedUnion("type", [
    z.strictObject({ commandId: UuidSchema, runId: RunIdSchema, type: z.literal("INCIDENT_CREATE"), payload: IncidentCreateSchema }),
    z.strictObject({ commandId: UuidSchema, runId: RunIdSchema, type: z.literal("INCIDENT_CLEAR"), payload: IncidentClearSchema }),
])
export type IncidentCommand = z.infer<typeof IncidentCommandSchema>

export const CommandStatusSchema = z.enum(["QUEUED", "SENT", "DELAYED", "APPLIED", "REJECTED"])
export type CommandStatus = z.infer<typeof CommandStatusSchema>
export const IncidentStatusSchema = z.enum(["ACTIVE", "RESOLVED"])
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>

// Durable incident record (design §5). Resolved records are kept for the run.
export const IncidentSchema = z.strictObject({
    incidentId: UuidSchema,
    runId: RunIdSchema,
    target: z.union([AirportEntityIdSchema, FlightEntityIdSchema]),
    kind: IncidentKindSchema,
    parameters: IncidentParametersSchema,
    createdAtSimSec: SimSecSchema,
    createdAtWallMs: WallMsSchema,
    createdBy: Id,
    status: IncidentStatusSchema,
    resolvedAtSimSec: SimSecSchema.nullable(),
    revision: RevisionSchema,
})
export type Incident = z.infer<typeof IncidentSchema>

// ---------------------------------------------------------------- protocol payloads (design §6)

export const FlightFactsSchema = z.strictObject({
    position: PointSchema,
    speedKnots: z.number().positive(),
    fuelRemainingSec: SimSecSchema,
    sampledAtSimSec: SimSecSchema,
    priority: PrioritySchema,
    deadlineSimSec: SimSecSchema.nullable(),
})
export type FlightFacts = z.infer<typeof FlightFactsSchema>

export const AirportRestrictionsSchema = z.strictObject({
    arrivalsClosed: z.boolean(),
    closedRunways: z.array(RunwayIdSchema),
    occupancySec: z.number().int().positive(),
    activeIncidentIds: z.array(UuidSchema),
})
export type AirportRestrictions = z.infer<typeof AirportRestrictionsSchema>

const Explanation = z.string().max(MAX_REASON_CHARS)

export const PayloadSchemas = {
    INCIDENT_CREATE: IncidentCreateSchema,
    INCIDENT_CLEAR: IncidentClearSchema,
    COMMAND_RESULT: z.strictObject({
        commandId: UuidSchema,
        outcome: z.enum(["APPLIED", "REJECTED"]),
        code: DomainCodeSchema,
        resultingRevision: RevisionSchema.nullable(),
        incidentId: UuidSchema,
    }),
    AIRPORT_STATUS: z.strictObject({
        airportId: AirportIdSchema,
        statusRevision: RevisionSchema,
        restrictions: AirportRestrictionsSchema,
    }),
    LANDING_REQUEST: z.strictObject({
        negotiationId: Id,
        flightId: FlightIdSchema,
        flightDecisionRevision: RevisionSchema,
        position: PointSchema,
        speedKnots: z.number().positive(),
        fuelRemainingSec: SimSecSchema,
        sampledAtSimSec: SimSecSchema,
        priority: PrioritySchema,
        deadlineSimSec: SimSecSchema.nullable(),
    }),
    LANDING_OFFER: z.strictObject({
        negotiationId: Id,
        offerId: Id,
        airportId: AirportIdSchema,
        runwayId: RunwayIdSchema,
        slotStartSimSec: SimSecSchema,
        occupancySec: z.number().int().positive(),
        expiresAtWallMs: WallMsSchema,
        airportOperationalRevision: RevisionSchema,
    }),
    LANDING_REFUSED: z.strictObject({
        negotiationId: Id,
        airportId: AirportIdSchema,
        code: DomainCodeSchema,
        explanation: Explanation,
    }),
    OFFER_ACCEPT: z.strictObject({
        negotiationId: Id,
        offerId: Id,
        flightDecisionRevision: RevisionSchema,
        facts: FlightFactsSchema,
    }),
    OFFER_DECLINE: z.strictObject({ negotiationId: Id, offerId: Id }),
    LANDING_CONFIRMED: z.strictObject({
        negotiationId: Id,
        offerId: Id,
        reservationId: Id,
        runwayId: RunwayIdSchema,
        slotStartSimSec: SimSecSchema,
        occupancySec: z.number().int().positive(),
    }),
    RESERVATION_RELEASE: z.strictObject({ reservationId: Id, flightId: FlightIdSchema }),
    RESERVATION_REVOKED: z.strictObject({
        reservationId: Id,
        code: DomainCodeSchema,
        reason: Explanation,
        airportOperationalRevision: RevisionSchema,
    }),
    RESERVATION_STATUS_REQUEST: z.strictObject({ negotiationId: Id, offerId: Id, reservationId: Id.nullable() }),
    RESERVATION_STATUS: z.strictObject({
        negotiationId: Id,
        offerId: Id,
        reservationId: Id.nullable(),
        status: z.enum(["OFFERED", "CONFIRMED", "CLEARED", "OCCUPIED", "COMPLETED", "RELEASED", "REVOKED", "EXPIRED", "DECLINED", "UNKNOWN"]),
        reservation: z
            .strictObject({
                reservationId: Id,
                runwayId: RunwayIdSchema,
                slotStartSimSec: SimSecSchema,
                occupancySec: z.number().int().positive(),
            })
            .nullable(),
    }),
    CLEARANCE_REQUEST: z.strictObject({ reservationId: Id, facts: FlightFactsSchema }),
    CLEARANCE_GRANTED: z.strictObject({
        reservationId: Id,
        clearanceId: Id,
        airportOperationalRevision: RevisionSchema,
        windowStartSimSec: SimSecSchema,
        windowEndSimSec: SimSecSchema,
    }),
    CLEARANCE_REFUSED: z.strictObject({ reservationId: Id, code: DomainCodeSchema }),
    DOMAIN_ACK: z.strictObject({ processedMessageId: UuidSchema, resultCode: z.string().min(1).max(64) }),
} as const

export const MessageTypeSchema = z.enum([
    "INCIDENT_CREATE",
    "INCIDENT_CLEAR",
    "COMMAND_RESULT",
    "AIRPORT_STATUS",
    "LANDING_REQUEST",
    "LANDING_OFFER",
    "LANDING_REFUSED",
    "OFFER_ACCEPT",
    "OFFER_DECLINE",
    "LANDING_CONFIRMED",
    "RESERVATION_RELEASE",
    "RESERVATION_REVOKED",
    "RESERVATION_STATUS_REQUEST",
    "RESERVATION_STATUS",
    "CLEARANCE_REQUEST",
    "CLEARANCE_GRANTED",
    "CLEARANCE_REFUSED",
    "DOMAIN_ACK",
])
export type MessageType = z.infer<typeof MessageTypeSchema>
export type Payload<T extends MessageType> = z.infer<(typeof PayloadSchemas)[T]>

// ---------------------------------------------------------------- envelopes (design §7)

const envelopeBase = {
    schemaVersion: z.literal(1),
    messageId: UuidSchema,
    runId: RunIdSchema,
    fromEntityId: EntityIdSchema,
    toEntityId: EntityIdSchema,
    correlationId: Id,
    causationId: Id.nullable(),
    createdAtWallMs: WallMsSchema,
    expiresAtWallMs: WallMsSchema.nullable(),
}
// Incident commands also carry the ledger identity and a server-issued proof.
const commandFields = {
    commandId: UuidSchema,
    commandSequence: z.number().int().positive(),
    authorization: z.string().min(1).max(512),
}
const receivedFields = {
    transportMessageId: z.string().min(1).max(256),
    senderHandle: z.string().min(1).max(128),
    recipientHandle: z.string().min(1).max(128),
    receivedAtWallMs: WallMsSchema,
}

// Written out member by member: the Terse client generator copies helper-function bodies into
// declarations and then fails ("An implementation cannot be declared in ambient contexts").
export const ProtocolEnvelopeSchema = z.discriminatedUnion("type", [
    z.strictObject({ ...envelopeBase, ...commandFields, type: z.literal("INCIDENT_CREATE"), payload: PayloadSchemas.INCIDENT_CREATE }),
    z.strictObject({ ...envelopeBase, ...commandFields, type: z.literal("INCIDENT_CLEAR"), payload: PayloadSchemas.INCIDENT_CLEAR }),
    z.strictObject({ ...envelopeBase, type: z.literal("COMMAND_RESULT"), payload: PayloadSchemas.COMMAND_RESULT }),
    z.strictObject({ ...envelopeBase, type: z.literal("AIRPORT_STATUS"), payload: PayloadSchemas.AIRPORT_STATUS }),
    z.strictObject({ ...envelopeBase, type: z.literal("LANDING_REQUEST"), payload: PayloadSchemas.LANDING_REQUEST }),
    z.strictObject({ ...envelopeBase, type: z.literal("LANDING_OFFER"), payload: PayloadSchemas.LANDING_OFFER }),
    z.strictObject({ ...envelopeBase, type: z.literal("LANDING_REFUSED"), payload: PayloadSchemas.LANDING_REFUSED }),
    z.strictObject({ ...envelopeBase, type: z.literal("OFFER_ACCEPT"), payload: PayloadSchemas.OFFER_ACCEPT }),
    z.strictObject({ ...envelopeBase, type: z.literal("OFFER_DECLINE"), payload: PayloadSchemas.OFFER_DECLINE }),
    z.strictObject({ ...envelopeBase, type: z.literal("LANDING_CONFIRMED"), payload: PayloadSchemas.LANDING_CONFIRMED }),
    z.strictObject({ ...envelopeBase, type: z.literal("RESERVATION_RELEASE"), payload: PayloadSchemas.RESERVATION_RELEASE }),
    z.strictObject({ ...envelopeBase, type: z.literal("RESERVATION_REVOKED"), payload: PayloadSchemas.RESERVATION_REVOKED }),
    z.strictObject({ ...envelopeBase, type: z.literal("RESERVATION_STATUS_REQUEST"), payload: PayloadSchemas.RESERVATION_STATUS_REQUEST }),
    z.strictObject({ ...envelopeBase, type: z.literal("RESERVATION_STATUS"), payload: PayloadSchemas.RESERVATION_STATUS }),
    z.strictObject({ ...envelopeBase, type: z.literal("CLEARANCE_REQUEST"), payload: PayloadSchemas.CLEARANCE_REQUEST }),
    z.strictObject({ ...envelopeBase, type: z.literal("CLEARANCE_GRANTED"), payload: PayloadSchemas.CLEARANCE_GRANTED }),
    z.strictObject({ ...envelopeBase, type: z.literal("CLEARANCE_REFUSED"), payload: PayloadSchemas.CLEARANCE_REFUSED }),
    z.strictObject({ ...envelopeBase, type: z.literal("DOMAIN_ACK"), payload: PayloadSchemas.DOMAIN_ACK }),
])
export type ProtocolEnvelope = z.infer<typeof ProtocolEnvelopeSchema>
export const ReceivedEnvelopeSchema = z.discriminatedUnion("type", [
    z.strictObject({ ...envelopeBase, ...commandFields, ...receivedFields, type: z.literal("INCIDENT_CREATE"), payload: PayloadSchemas.INCIDENT_CREATE }),
    z.strictObject({ ...envelopeBase, ...commandFields, ...receivedFields, type: z.literal("INCIDENT_CLEAR"), payload: PayloadSchemas.INCIDENT_CLEAR }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("COMMAND_RESULT"), payload: PayloadSchemas.COMMAND_RESULT }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("AIRPORT_STATUS"), payload: PayloadSchemas.AIRPORT_STATUS }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("LANDING_REQUEST"), payload: PayloadSchemas.LANDING_REQUEST }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("LANDING_OFFER"), payload: PayloadSchemas.LANDING_OFFER }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("LANDING_REFUSED"), payload: PayloadSchemas.LANDING_REFUSED }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("OFFER_ACCEPT"), payload: PayloadSchemas.OFFER_ACCEPT }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("OFFER_DECLINE"), payload: PayloadSchemas.OFFER_DECLINE }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("LANDING_CONFIRMED"), payload: PayloadSchemas.LANDING_CONFIRMED }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("RESERVATION_RELEASE"), payload: PayloadSchemas.RESERVATION_RELEASE }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("RESERVATION_REVOKED"), payload: PayloadSchemas.RESERVATION_REVOKED }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("RESERVATION_STATUS_REQUEST"), payload: PayloadSchemas.RESERVATION_STATUS_REQUEST }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("RESERVATION_STATUS"), payload: PayloadSchemas.RESERVATION_STATUS }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("CLEARANCE_REQUEST"), payload: PayloadSchemas.CLEARANCE_REQUEST }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("CLEARANCE_GRANTED"), payload: PayloadSchemas.CLEARANCE_GRANTED }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("CLEARANCE_REFUSED"), payload: PayloadSchemas.CLEARANCE_REFUSED }),
    z.strictObject({ ...envelopeBase, ...receivedFields, type: z.literal("DOMAIN_ACK"), payload: PayloadSchemas.DOMAIN_ACK }),
])
export type ReceivedEnvelope = z.infer<typeof ReceivedEnvelopeSchema>
export type EnvelopeOf<T extends MessageType> = Extract<ProtocolEnvelope, { type: T }>

// ---------------------------------------------------------------- durable records

export const OfferStatusSchema = z.enum(["OFFERED", "CONFIRMED", "DECLINED", "EXPIRED", "REVOKED"])
export const OfferSchema = PayloadSchemas.LANDING_OFFER.extend({
    flightId: FlightIdSchema,
    status: OfferStatusSchema,
    requestMessageId: UuidSchema,
    priority: PrioritySchema,
})
export type Offer = z.infer<typeof OfferSchema>

export const ReservationStatusSchema = z.enum(["CONFIRMED", "CLEARED", "OCCUPIED", "COMPLETED", "RELEASED", "REVOKED", "EXPIRED"])
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>
export const ReservationSchema = OfferSchema.omit({ status: true }).extend({
    reservationId: Id,
    status: ReservationStatusSchema,
})
export type Reservation = z.infer<typeof ReservationSchema>

export const ClearanceSchema = z.strictObject({
    clearanceId: Id,
    reservationId: Id,
    flightId: FlightIdSchema,
    runwayId: RunwayIdSchema,
    windowStartSimSec: SimSecSchema,
    windowEndSimSec: SimSecSchema,
    airportOperationalRevision: RevisionSchema,
    status: z.enum(["ACTIVE", "USED", "REVOKED", "EXPIRED"]),
})
export type Clearance = z.infer<typeof ClearanceSchema>

export const AssignmentSchema = z.strictObject({
    airportId: AirportIdSchema,
    runwayId: RunwayIdSchema,
    reservationId: Id,
    slotStartSimSec: SimSecSchema,
    occupancySec: z.number().int().positive(),
    clearanceId: Id.nullable(),
})
export type Assignment = z.infer<typeof AssignmentSchema>

export const NegotiationReplySchema = z.strictObject({
    airportId: AirportIdSchema,
    kind: z.enum(["PENDING", "OFFER", "REFUSED", "TIMEOUT"]),
    offerId: Id.nullable(),
    code: DomainCodeSchema.nullable(),
    slotStartSimSec: SimSecSchema.nullable(),
    explanation: Explanation.nullable(),
})
export type NegotiationReply = z.infer<typeof NegotiationReplySchema>

export const NegotiationStageSchema = z.enum(["REQUESTING", "COLLECTING", "ACCEPTING", "CONFIRMED", "NO_FEASIBLE_AIRPORT"])
export type NegotiationStage = z.infer<typeof NegotiationStageSchema>
export const NegotiationRoundSchema = z.strictObject({
    roundId: Id,
    trigger: z.string().min(1).max(64),
    candidateAirports: z.array(AirportIdSchema).max(3),
    replies: z.array(NegotiationReplySchema),
    collectUntilWallMs: WallMsSchema.nullable(),
    stage: NegotiationStageSchema,
})
export type NegotiationRound = z.infer<typeof NegotiationRoundSchema>

export const PendingAcceptanceSchema = z.strictObject({
    negotiationId: Id,
    offerId: Id,
    airportId: AirportIdSchema,
    messageId: UuidSchema,
    sentAtWallMs: WallMsSchema,
    statusRequestedAtWallMs: WallMsSchema.nullable(),
})
export type PendingAcceptance = z.infer<typeof PendingAcceptanceSchema>

export const ReleaseObligationSchema = z.strictObject({
    airportId: AirportIdSchema,
    reservationId: Id,
    messageId: UuidSchema,
    acknowledged: z.boolean(),
})
export type ReleaseObligation = z.infer<typeof ReleaseObligationSchema>

export const OutboxEntrySchema = z.strictObject({
    envelope: ProtocolEnvelopeSchema,
    recipientHandle: z.string().min(1).max(128),
    attemptCount: z.number().int().nonnegative(),
    nextAttemptAtWallMs: WallMsSchema,
    transportMessageId: z.string().max(256).nullable(),
    acknowledged: z.boolean(),
})
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>

// Domain dedup record keyed by (runId, messageId); kept for the whole run.
export const InboxResultSchema = z.strictObject({
    messageId: UuidSchema,
    type: MessageTypeSchema,
    fromEntityId: EntityIdSchema,
    result: DomainResultBase,
    processedAtWallMs: WallMsSchema,
})
export type InboxResult = z.infer<typeof InboxResultSchema>

export const AgentActionTypeSchema = z.enum(["REQUEST_LANDING", "SELECT_OFFER", "PROPOSE_OFFER", "REFUSE", "HOLD", "REQUEST_CLEARANCE"])
export type AgentActionType = z.infer<typeof AgentActionTypeSchema>
export const DecisionSourceSchema = z.enum(["MODEL", "RULES_FALLBACK"])
export type DecisionSource = z.infer<typeof DecisionSourceSchema>

export const JobSchema = z.strictObject({
    jobId: Id,
    kind: z.enum(["PILOT_DECISION", "ATC_DECISION"]),
    status: z.enum(["QUEUED", "LEASED", "COMMITTED", "CANCELLED", "FAILED"]),
    decisionRevision: RevisionSchema,
    input: z.strictObject({
        trigger: z.string().min(1).max(64),
        priority: PrioritySchema,
        allowedActions: z.array(AgentActionTypeSchema).min(1),
        relevantMessageIds: z.array(UuidSchema),
        createdAtWallMs: WallMsSchema,
    }),
    leaseToken: z.string().max(256).nullable(),
    leaseUntilWallMs: WallMsSchema.nullable(),
    attemptCount: z.number().int().nonnegative(),
    outcome: z
        .strictObject({
            source: DecisionSourceSchema,
            action: AgentActionTypeSchema,
            reason: Explanation,
            committedAtWallMs: WallMsSchema,
        })
        .nullable(),
})
export type Job = z.infer<typeof JobSchema>

export const FencingSchema = z.strictObject({
    workerEpoch: z.number().int().nonnegative(),
    leaseToken: z.string().max(256).nullable(),
})
export type Fencing = z.infer<typeof FencingSchema>

// Buffered controller messages wait here until their sequence is next.
export const BufferedControllerMessageSchema = z.strictObject({
    commandSequence: z.number().int().positive(),
    envelope: ReceivedEnvelopeSchema,
})

export const TouchdownReceiptSchema = z.strictObject({
    receiptId: Id,
    runId: RunIdSchema,
    flightId: FlightIdSchema,
    airportId: AirportIdSchema,
    runwayId: RunwayIdSchema,
    reservationId: Id,
    clearanceId: Id,
    touchdownAtSimSec: SimSecSchema,
    occupiedUntilSimSec: SimSecSchema,
})
export type TouchdownReceipt = z.infer<typeof TouchdownReceiptSchema>

const entityCommon = {
    runId: RunIdSchema,
    stateRevision: RevisionSchema,
    decisionRevision: RevisionSchema,
    lastTickId: Id.nullable(),
    lastAdvancedSimSec: SimSecSchema,
    inbox: z.record(z.string(), InboxResultSchema),
    outbox: z.array(OutboxEntrySchema),
    jobs: z.record(z.string(), JobSchema),
    lastControllerSequence: z.number().int().nonnegative(),
    bufferedControllerMessages: z.array(BufferedControllerMessageSchema),
    fencing: FencingSchema,
    initializedByOperationId: Id,
}

export const RunwayStateSchema = z.strictObject({
    runwayId: RunwayIdSchema,
    occupiedUntilSimSec: SimSecSchema.nullable(),
})
export type RunwayState = z.infer<typeof RunwayStateSchema>

export const AirportStateSchema = z.strictObject({
    ...entityCommon,
    entityId: AirportEntityIdSchema,
    airportId: AirportIdSchema,
    name: z.string().min(1).max(64),
    position: PointSchema,
    incidents: z.record(z.string(), IncidentSchema),
    restrictions: AirportRestrictionsSchema,
    statusRevision: RevisionSchema,
    operationalRevision: RevisionSchema,
    runways: z.array(RunwayStateSchema),
    offers: z.record(z.string(), OfferSchema),
    reservations: z.record(z.string(), ReservationSchema),
    clearances: z.record(z.string(), ClearanceSchema),
    touchdowns: z.record(z.string(), TouchdownReceiptSchema),
})
export type AirportState = z.infer<typeof AirportStateSchema>

export const FlightStateSchema = z.strictObject({
    ...entityCommon,
    entityId: FlightEntityIdSchema,
    flightId: FlightIdSchema,
    callsign: z.string().min(1).max(32),
    originalDestination: AirportIdSchema,
    position: PointSchema,
    headingDeg: z.number().finite(),
    speedKnots: z.number().positive(),
    fuelRemainingSec: z.number().finite(),
    phase: FlightPhaseSchema,
    holdCenter: PointSchema.nullable(),
    holdAngle: z.number().finite().nullable(),
    incidents: z.record(z.string(), IncidentSchema),
    priority: PrioritySchema,
    deadlineSimSec: SimSecSchema.nullable(),
    knownAirportStatus: z.partialRecord(AirportIdSchema, PayloadSchemas.AIRPORT_STATUS),
    negotiation: NegotiationRoundSchema.nullable(),
    negotiationCounter: z.number().int().nonnegative(),
    pendingAcceptance: PendingAcceptanceSchema.nullable(),
    activeAssignment: AssignmentSchema.nullable(),
    releaseObligations: z.array(ReleaseObligationSchema),
    landingReceipt: TouchdownReceiptSchema.nullable(),
    terminalReason: TerminalReasonSchema.nullable(),
})
export type FlightState = z.infer<typeof FlightStateSchema>

export const EntityRegistrationSchema = z.strictObject({
    entityId: EntityIdSchema,
    handle: z.string().min(1).max(128),
    role: RoleSchema,
})
export type EntityRegistration = z.infer<typeof EntityRegistrationSchema>

// ---------------------------------------------------------------- run registry

export const RunDescriptorSchema = z.object({ runId: RunIdSchema, phase: RunPhaseSchema, config: RunConfigSchema })
export type RunDescriptor = z.infer<typeof RunDescriptorSchema>

export const WorkerLeaseSchema = z.strictObject({
    runId: RunIdSchema,
    ownerId: z.string().min(1).max(128),
    epoch: z.number().int().positive(),
    token: z.string().min(1).max(256),
    expiresAtWallMs: WallMsSchema,
})
export type WorkerLease = z.infer<typeof WorkerLeaseSchema>

export const PendingTickSchema = TickSchema.extend({
    entityIds: z.array(EntityIdSchema),
    acknowledgedEntityIds: z.array(EntityIdSchema),
})
export type PendingTick = z.infer<typeof PendingTickSchema>

// Browser-safe (frontend-backend-contract.md): exactly these fields.
export const CommandReceiptSchema = z.object({
    runId: RunIdSchema,
    commandId: UuidSchema,
    status: CommandStatusSchema,
    incidentId: UuidSchema,
    code: z.string().max(64).nullable(),
    resultingRevision: RevisionSchema.nullable(),
})
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>

// Issued by the authenticated gateway; never parsed from browser JSON.
export const ControllerPrincipalSchema = z.strictObject({
    principalId: z.string().min(1).max(128),
    role: z.enum(["OPERATOR", "CONTROLLER"]),
    runId: RunIdSchema,
    sessionId: z.string().min(1).max(128),
})
export type ControllerPrincipal = z.infer<typeof ControllerPrincipalSchema>

export const RunEventSchema = z.strictObject({
    eventIndex: z.number().int().nonnegative(),
    wallMs: WallMsSchema,
    simSec: SimSecSchema,
    type: z.string().min(1).max(64),
    summary: Explanation,
    operationId: Id.nullable(),
})
export type RunEvent = z.infer<typeof RunEventSchema>

export const CommandLedgerEntrySchema = z.strictObject({
    command: IncidentCommandSchema,
    principal: ControllerPrincipalSchema,
    commandSequence: z.number().int().positive(),
    target: z.union([AirportEntityIdSchema, FlightEntityIdSchema]),
    contentHash: z.string().min(1).max(128),
    messageId: UuidSchema,
    receipt: CommandReceiptSchema,
    submittedAtWallMs: WallMsSchema,
    updatedAtWallMs: WallMsSchema,
})
export type CommandLedgerEntry = z.infer<typeof CommandLedgerEntrySchema>

export const InitStepSchema = z.enum(["WORLD_CREATED", "IDENTITIES_REGISTERED", "AIRPORTS_INITIALIZED", "FLIGHTS_INITIALIZED", "READY"])
export type InitStep = z.infer<typeof InitStepSchema>

// ---------------------------------------------------------------- public projection
// Browser-safe shapes agreed in docs/coordination/frontend-backend-contract.md.
// Non-strict objects so an additive backend field never breaks an older browser.
// No raw aggregate, token, job lease, inbox or outbox appears here.

export const PublicIncidentSchema = z.object({
    incidentId: UuidSchema,
    runId: RunIdSchema,
    target: z.union([AirportEntityIdSchema, FlightEntityIdSchema]),
    kind: IncidentKindSchema,
    parameters: IncidentParametersSchema,
    status: IncidentStatusSchema,
    revision: RevisionSchema,
    createdAtSimSec: SimSecSchema,
    createdAtWallMs: WallMsSchema,
    resolvedAtSimSec: SimSecSchema.nullable(),
})
export type PublicIncident = z.infer<typeof PublicIncidentSchema>

export const AirportStatusLabelSchema = z.enum(["OPEN", "RESTRICTED", "CLOSED"])
export type AirportStatusLabel = z.infer<typeof AirportStatusLabelSchema>

export const PublicAirportSchema = z.object({
    entityId: AirportEntityIdSchema,
    airportId: AirportIdSchema,
    name: z.string(),
    position: PointSchema,
    status: AirportStatusLabelSchema,
    statusReason: z.string().nullable(),
    stateRevision: RevisionSchema,
    runways: z.array(
        z.object({
            runwayId: z.string(),
            status: z.enum(["OPEN", "CLOSED", "OCCUPIED"]),
            occupiedUntilSimSec: SimSecSchema.nullable(),
        }),
    ),
    // Sorted by slot start, then runway ID.
    queue: z.array(
        z.object({
            reservationId: z.string(),
            flightId: z.string(),
            runwayId: z.string(),
            slotStartSimSec: SimSecSchema,
            status: z.string(),
            priority: PrioritySchema,
        }),
    ),
})
export type PublicAirport = z.infer<typeof PublicAirportSchema>

export const PublicFlightSchema = z.object({
    entityId: FlightEntityIdSchema,
    flightId: z.string(),
    callsign: z.string(),
    position: PointSchema,
    // Degrees clockwise from north: 0 up, 90 right. Map y grows downward (south).
    headingDeg: z.number().finite(),
    speedKnots: z.number().nonnegative(),
    fuelRemainingSec: z.number().finite(),
    phase: FlightPhaseSchema,
    priority: PrioritySchema,
    deadlineSimSec: SimSecSchema.nullable(),
    originalDestination: z.string(),
    activeAssignment: AssignmentSchema.nullable(),
    negotiationStage: z.string().nullable(),
    stateRevision: RevisionSchema,
    lastDecisionReason: z.string().nullable(),
    lastDecisionSource: DecisionSourceSchema.nullable(),
    unresolvedReason: z.string().nullable(),
    // Display proposals only, never confirmed routes.
    proposals: z.array(
        z.object({
            offerId: z.string(),
            airportId: z.string(),
            runwayId: z.string(),
            slotStartSimSec: SimSecSchema,
            expiresAtWallMs: WallMsSchema,
        }),
    ),
})
export type PublicFlight = z.infer<typeof PublicFlightSchema>

export const TimelineEventSchema = z.object({
    eventId: z.string(),
    simTimeSec: SimSecSchema,
    wallTimeMs: WallMsSchema,
    fromEntityId: z.string(),
    toEntityId: z.string().nullable(),
    type: z.string(),
    summary: z.string(),
    status: z.enum(["PENDING", "APPLIED", "REFUSED", "INFO"]),
    source: z.enum(["MODEL", "RULES_FALLBACK", "SYSTEM"]),
    correlationId: z.string().nullable(),
})
export type TimelineEvent = z.infer<typeof TimelineEventSchema>

export const DependencyHealthSchema = z.object({
    status: z.enum(["READY", "DEGRADED", "UNAVAILABLE"]),
    detail: z.string().nullable(),
})
export type DependencyHealth = z.infer<typeof DependencyHealthSchema>

export const AgentModeSchema = z.enum(["live", "rules"])
export type AgentMode = z.infer<typeof AgentModeSchema>

export const PublicSnapshotSchema = z.object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    projectionVersion: z.number().int().nonnegative(),
    phase: RunPhaseSchema,
    simTimeSec: SimSecSchema,
    serverWallTimeMs: WallMsSchema,
    config: RunConfigSchema,
    airports: z.array(PublicAirportSchema),
    flights: z.array(PublicFlightSchema),
    incidents: z.array(PublicIncidentSchema),
    commands: z.array(CommandReceiptSchema),
    // Last 200, oldest first.
    timeline: z.array(TimelineEventSchema),
    health: z.object({
        actors: DependencyHealthSchema,
        relay: DependencyHealthSchema,
        model: DependencyHealthSchema,
        worker: DependencyHealthSchema,
    }),
    agentMode: AgentModeSchema,
})
export type PublicSnapshot = z.infer<typeof PublicSnapshotSchema>

// GET /api/bootstrap and POST /api/join response.
export const BootstrapSchema = z.object({
    schemaVersion: z.literal(1),
    session: z.object({
        role: z.enum(["VIEWER", "CONTROLLER", "OPERATOR"]),
        runId: z.string().nullable(),
        csrfToken: z.string().nullable(),
    }),
    activeRun: RunDescriptorSchema.nullable(),
    snapshot: PublicSnapshotSchema.nullable(),
})
export type Bootstrap = z.infer<typeof BootstrapSchema>

export const ApiErrorSchema = z.object({
    error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

export const SimulationStateSchema = z.strictObject({
    runId: RunIdSchema,
    stateRevision: RevisionSchema,
    createRequestId: Id,
    config: RunConfigSchema,
    phase: RunPhaseSchema,
    entities: z.array(EntityRegistrationSchema),
    simNowSec: SimSecSchema,
    tickCounter: z.number().int().nonnegative(),
    pendingTick: PendingTickSchema.nullable(),
    lastCompletedTickId: Id.nullable(),
    commands: z.record(z.string(), CommandLedgerEntrySchema),
    targetSequences: z.record(z.string(), z.number().int().nonnegative()),
    controllerOutbox: z.array(OutboxEntrySchema),
    controllerInbox: z.record(z.string(), InboxResultSchema),
    initialization: z.strictObject({
        steps: z.array(InitStepSchema),
        completedAtWallMs: WallMsSchema.nullable(),
    }),
    workerLease: WorkerLeaseSchema.nullable(),
    workerEpoch: z.number().int().nonnegative(),
    projectionVersion: z.number().int().nonnegative(),
    publicSnapshot: PublicSnapshotSchema.nullable(),
    events: z.array(RunEventSchema),
    operations: z.record(z.string(), z.string()),
    createdAtWallMs: WallMsSchema,
    fencedAtWallMs: WallMsSchema.nullable(),
})
export type SimulationState = z.infer<typeof SimulationStateSchema>

export const SimulationRootStateSchema = z.strictObject({
    activeRunId: RunIdSchema.nullable(),
    runs: z.record(z.string(), SimulationStateSchema),
    createRequests: z.record(z.string(), z.string()),
    relayEventCursor: z.number().int().nonnegative(),
})
export type SimulationRootState = z.infer<typeof SimulationRootStateSchema>

// ---------------------------------------------------------------- landing checks

export const ClearanceCheckSchema = z.strictObject({ flightId: FlightIdSchema, reservationId: Id, clearanceId: Id })
export type ClearanceCheck = z.infer<typeof ClearanceCheckSchema>
export const ClearanceCheckResultSchema = z.strictObject({
    valid: z.boolean(),
    reason: z.string().max(MAX_REASON_CHARS),
    reservationId: Id,
    clearanceId: Id,
})
export type ClearanceCheckResult = z.infer<typeof ClearanceCheckResultSchema>
export const TouchdownInputSchema = ClearanceCheckSchema.extend({ position: PointSchema, tickId: Id })
export type TouchdownInput = z.infer<typeof TouchdownInputSchema>

// ---------------------------------------------------------------- agents (design §7)

const Reason = z.string().min(1).max(MAX_REASON_CHARS)

export const PilotDecisionSchema = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("REQUEST_LANDING"), airportIds: z.array(AirportIdSchema).min(1).max(3), reason: Reason }),
    z.strictObject({ type: z.literal("SELECT_OFFER"), offerId: Id, airportId: AirportIdSchema, reason: Reason }),
    z.strictObject({ type: z.literal("HOLD"), reason: Reason }),
    z.strictObject({ type: z.literal("REQUEST_CLEARANCE"), reservationId: Id, reason: Reason }),
])
export const AtcDecisionSchema = z.discriminatedUnion("type", [
    z.strictObject({
        type: z.literal("PROPOSE_OFFER"),
        negotiationId: Id,
        flightId: FlightIdSchema,
        runwayId: RunwayIdSchema,
        slotStartSimSec: SimSecSchema,
        reason: Reason,
    }),
    z.strictObject({ type: z.literal("REFUSE"), negotiationId: Id, flightId: FlightIdSchema, code: DomainCodeSchema, reason: Reason }),
])
export const AgentDecisionSchema = z.discriminatedUnion("type", [...PilotDecisionSchema.options, ...AtcDecisionSchema.options])
export type AgentDecision = z.infer<typeof AgentDecisionSchema>
export type PilotDecision = z.infer<typeof PilotDecisionSchema>
export type AtcDecision = z.infer<typeof AtcDecisionSchema>

export const RelevantMessageSchema = z.strictObject({
    messageId: UuidSchema,
    type: MessageTypeSchema,
    fromEntityId: EntityIdSchema,
    summary: z.string().max(MAX_MESSAGE_SUMMARY_CHARS),
})
export const AgentDecisionInputSchema = z.strictObject({
    jobId: Id,
    entityId: z.union([AirportEntityIdSchema, FlightEntityIdSchema]),
    role: z.enum(["PILOT", "ATC"]),
    decisionRevision: RevisionSchema,
    allowedActions: z.array(AgentActionTypeSchema).min(1),
    localState: z.record(z.string(), z.unknown()),
    relevantMessages: z.array(RelevantMessageSchema),
})
export type AgentDecisionInput = z.infer<typeof AgentDecisionInputSchema>

export const ClaimedJobSchema = AgentDecisionInputSchema.extend({ jobLeaseToken: z.string().min(1).max(256), leaseUntilWallMs: WallMsSchema })
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>

export const DecisionCommitSchema = z.strictObject({
    jobId: Id,
    jobLeaseToken: z.string().min(1).max(256),
    decisionRevision: RevisionSchema,
    decision: AgentDecisionSchema,
    source: DecisionSourceSchema,
})
export type DecisionCommit = z.infer<typeof DecisionCommitSchema>

// ---------------------------------------------------------------- interfaces between tasks

export type Transition<S> = { state: S; result: DomainResult }

export interface RelayTransport {
    connect(runId: string, entities: EntityRegistration[]): Promise<void>
    send(envelope: ProtocolEnvelope): Promise<{ transportMessageId: string }>
    onMessage(handler: (message: ReceivedEnvelope) => Promise<void>): () => void
    disconnect(): Promise<void>
}

export interface ModelAdapter {
    decide(input: AgentDecisionInput, signal: AbortSignal): Promise<AgentDecision>
}

export type InitialWorld = { airports: AirportState[]; flights: FlightState[] }

// Handles: ghost-<runId first 8>-controller, -atc-alp, -flight-f001. Actor IDs use the full run ID.
// Terse actor IDs allow only letters, digits, dots, underscores and hyphens (1 to 128 chars), so the
// plan's `<runId>/airport/ALP` is written `<runId>.airport.ALP` (see docs/integration-evidence.md).
export function entityHandle(runId: string, entityId: EntityId): string {
    const prefix = `ghost-${runId.slice(0, 8)}`
    if (entityId === "controller") return `${prefix}-controller`
    if (entityId.startsWith("airport:")) return `${prefix}-atc-${entityId.slice(8).toLowerCase()}`
    return `${prefix}-flight-${entityId.slice(7).toLowerCase()}`
}
export function entityActorId(runId: string, entityId: AirportEntityId | FlightEntityId): string {
    if (entityId.startsWith("airport:")) return `${runId}.airport.${entityId.slice(8)}`
    return `${runId}.flight.${entityId.slice(7)}`
}
export function entityRole(entityId: EntityId): Role {
    return entityId === "controller" ? "CONTROLLER" : entityId.startsWith("airport:") ? "ATC" : "PILOT"
}
