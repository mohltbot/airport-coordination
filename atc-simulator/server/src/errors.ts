// API error shape agreed in docs/coordination/frontend-backend-contract.md:
// {error:{code,message,retryable}} with the HTTP statuses from design §8.
export class ApiFailure extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly retryable = false,
    ) {
        super(message)
    }
}

export const fail = (status: number, code: string, message: string, retryable = false) => new ApiFailure(status, code, message, retryable)

export function errorResponse(err: ApiFailure, headers?: HeadersInit): Response {
    return Response.json({ error: { code: err.code, message: err.message, retryable: err.retryable } }, { status: err.status, headers })
}

// Actor-side failures arrive as thrown errors or {ok:false,httpStatus,code,message} results.
// Map the known domain codes; anything else is an upstream failure the client may retry.
const CODE_STATUS: Record<string, number> = {
    INVALID_PAYLOAD: 400,
    UNAUTHORIZED: 403,
    NOT_FOUND: 404,
    UNKNOWN_RUN: 404,
    UNKNOWN_ENTITY: 404,
    UNKNOWN_COMMAND: 404,
    WRONG_RUN: 409,
    WRONG_PHASE: 409,
    RUN_ACTIVE: 409,
    COMMAND_ID_CONFLICT: 409,
    REQUEST_ID_CONFLICT: 409,
    REVISION_CONFLICT: 409,
}

export function toApiFailure(err: unknown): ApiFailure {
    if (err instanceof ApiFailure) return err
    const result = err as { ok?: boolean; httpStatus?: number; code?: string; message?: string } | null
    if (result && result.ok === false && typeof result.code === "string") {
        return new ApiFailure(result.httpStatus ?? CODE_STATUS[result.code] ?? 409, result.code, result.message ?? result.code)
    }
    const message = err instanceof Error ? err.message : String(err)
    // Actors throw `CODE: message`; the generated client may wrap it, so search the text.
    const lead = message.match(/\b([A-Z][A-Z_]{3,}): /)
    if (lead && CODE_STATUS[lead[1]!]) return new ApiFailure(CODE_STATUS[lead[1]!]!, lead[1]!, message.slice(message.indexOf(lead[0]) + lead[0].length).slice(0, 240))
    for (const [code, status] of Object.entries(CODE_STATUS)) {
        if (message.includes(code)) return new ApiFailure(status, code, message.slice(0, 240))
    }
    return new ApiFailure(503, "UPSTREAM_UNAVAILABLE", "The simulation service did not answer. Try again.", true)
}
