// FlightActor step helpers (actors/src/flight-motion.ts) with real negotiation.ts.
import { describe, expect, test } from "bun:test"
import type { FlightState, MutationContext, Tick } from "../../packages/domain/src/contracts.ts"
import { advanceFlightStep, claimFlightWork, commitFlightDecision, receiveFlightStep } from "../../actors/src/flight-motion.ts"
import { memFlight, RUN_A } from "../integration/sim-harness.ts"

const ctx = (simNowSec: number, epoch = 1): MutationContext => ({ runId: RUN_A, workerEpoch: epoch, leaseToken: `tok-${epoch}`, simNowSec, wallNowMs: 5_000, operationId: `op-${simNowSec}` })
const tick = (from: number, to: number): Tick => ({ tickId: `t-${to}`, fromSimSec: from, toSimSec: to })
const near = (): FlightState =>
    memFlight(RUN_A, "F001", {
        position: { x: 56, y: 50 },
        phase: "HOLDING",
        holdCenter: { x: 50, y: 50 },
        holdAngle: 0,
        fencing: { workerEpoch: 1, leaseToken: "tok-1" },
        activeAssignment: { airportId: "ALP", runwayId: "R1", reservationId: "rsv-F001-N1@ALP", slotStartSimSec: 300, occupancySec: 60, clearanceId: null },
    })

describe("flight-motion steps", () => {
    test("IMMEDIATE mode sends CLEARANCE_REQUEST when the clearance window opens", () => {
        const s = advanceFlightStep({}, near(), ctx(92), tick(0, 92)).state!
        expect(s.outbox.map(e => e.envelope.type)).toEqual(["CLEARANCE_REQUEST"])
        expect(Object.values(s.jobs).map(j => j.status)).toEqual(["COMMITTED"])
    })

    test("JOB mode: the runner claims the clearance job and commits REQUEST_CLEARANCE under its lease", () => {
        const settings = { decisionMode: "JOB" as const }
        const s1 = advanceFlightStep(settings, near(), ctx(92), tick(0, 92)).state!
        expect(s1.outbox).toHaveLength(0)
        const claim = claimFlightWork(settings, s1, ctx(92))
        expect(claim.job?.allowedActions).toContain("REQUEST_CLEARANCE")
        const s2 = claim.state!
        const bad = commitFlightDecision(settings, s2, ctx(92), {
            jobId: claim.job!.jobId,
            jobLeaseToken: claim.job!.jobLeaseToken,
            decisionRevision: claim.job!.decisionRevision,
            decision: { type: "REFUSE", negotiationId: "x", flightId: "F001", code: "CLOSED", reason: "wrong role" },
            source: "MODEL",
        })
        expect(bad.result.code).toBe("INVALID_PAYLOAD")
        expect(bad.state).toBeNull() // job stays LEASED for the fallback
        const ok = commitFlightDecision(settings, s2, ctx(92), {
            jobId: claim.job!.jobId,
            jobLeaseToken: claim.job!.jobLeaseToken,
            decisionRevision: claim.job!.decisionRevision,
            decision: { type: "REQUEST_CLEARANCE", reservationId: "rsv-F001-N1@ALP", reason: "window open" },
            source: "MODEL",
        })
        expect(ok.result.outcome).toBe("APPLIED")
        expect(ok.state!.outbox.map(e => e.envelope.type)).toEqual(["CLEARANCE_REQUEST"])
    })

    test("CLEARANCE_GRANTED is recorded once; a DOMAIN_ACK marks the outbox entry acknowledged and keeps it for the timeline", () => {
        const s1 = advanceFlightStep({}, near(), ctx(92), tick(0, 92)).state!
        const req = s1.outbox[0]!.envelope
        const granted = {
            schemaVersion: 1 as const,
            messageId: crypto.randomUUID(),
            runId: RUN_A,
            fromEntityId: "airport:ALP" as const,
            toEntityId: "flight:F001" as const,
            type: "CLEARANCE_GRANTED" as const,
            correlationId: "F001-N1",
            causationId: req.messageId,
            createdAtWallMs: 5_000,
            expiresAtWallMs: null,
            payload: { reservationId: "rsv-F001-N1@ALP", clearanceId: "clr-1", airportOperationalRevision: 1, windowStartSimSec: 300, windowEndSimSec: 330 },
            transportMessageId: "t1",
            senderHandle: "a",
            recipientHandle: "b",
            receivedAtWallMs: 5_000,
        }
        const s2 = receiveFlightStep({}, s1, ctx(91), granted).state!
        expect(s2.activeAssignment?.clearanceId).toBe("clr-1")
        expect(receiveFlightStep({}, s2, ctx(91), granted).result.outcome).toBe("DUPLICATE")
        const ack = { ...granted, messageId: crypto.randomUUID(), type: "DOMAIN_ACK" as const, payload: { processedMessageId: req.messageId, resultCode: "OK" } }
        const s3 = receiveFlightStep({}, s2, ctx(92), ack).state!
        expect(s3.outbox.filter(e => !e.acknowledged)).toHaveLength(0)
        expect(s3.outbox.find(e => e.envelope.messageId === req.messageId)?.acknowledged).toBe(true)
    })

    test("an old worker epoch is fenced out of every step", () => {
        const s = { ...near(), fencing: { workerEpoch: 3, leaseToken: "tok-3" } }
        expect(advanceFlightStep({}, s, ctx(10, 2), tick(0, 10)).result.code).toBe("INVALID_LEASE")
        expect(claimFlightWork({}, s, ctx(10, 2)).job).toBeNull()
    })
})
