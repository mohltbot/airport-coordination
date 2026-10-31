import { z } from "zod";
import {
  ApiErrorSchema,
  BootstrapSchema,
  CommandReceiptSchema,
  PublicSnapshotSchema,
  RunDescriptorSchema,
  type IncidentCommand,
  type RunConfig,
} from "@ghost-tower/domain/public";
export class ApiError extends Error {
  constructor(
    message: string,
    public code = "NETWORK_ERROR",
    public status = 0,
    public retryable = true,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get authFailure() {
    return this.status === 401 || this.status === 403;
  }
}
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { body?: unknown; csrf?: string | null; signal?: AbortSignal } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      method: options.body === undefined ? "GET" : "POST",
      headers:
        options.body === undefined
          ? undefined
          : {
              "Content-Type": "application/json",
              ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
            },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
        ? AbortSignal.any([timeout, options.signal])
        : timeout,
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = ApiErrorSchema.safeParse(json);
      throw error.success
        ? new ApiError(
            error.data.error.message,
            error.data.error.code,
            response.status,
            error.data.error.retryable,
          )
        : new ApiError(
            `Request failed (${response.status})`,
            "HTTP_ERROR",
            response.status,
            response.status >= 500,
          );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new ApiError(
        "The server returned an invalid response. The request outcome is uncertain; retry safely.",
        "INVALID_RESPONSE",
        response.status,
        true,
      );
    return parsed.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      timeout.aborted
        ? "The request timed out. Its outcome is uncertain; retry safely."
        : "Unable to reach the server. Its outcome may be uncertain.",
    );
  }
}
const base = (runId: string) => `/api/runs/${encodeURIComponent(runId)}`;
export const api = {
  bootstrap: (signal?: AbortSignal) =>
    request("/api/bootstrap", BootstrapSchema, { signal }),
  join: (token: string) =>
    request("/api/join", BootstrapSchema, { body: { token } }),
  snapshot: (runId: string, signal?: AbortSignal) =>
    request(`${base(runId)}/snapshot`, PublicSnapshotSchema, { signal }),
  receipt: (runId: string, commandId: string, signal?: AbortSignal) =>
    request(
      `${base(runId)}/commands/${encodeURIComponent(commandId)}`,
      CommandReceiptSchema,
      { signal },
    ),
  create: (requestId: string, config: RunConfig, csrf: string) =>
    request("/api/runs", RunDescriptorSchema, {
      body: { requestId, config },
      csrf,
    }),
  control: (
    runId: string,
    action: string,
    operationId: string,
    csrf: string,
    speed?: 1 | 5 | 10,
  ) =>
    request(`${base(runId)}/${action}`, RunDescriptorSchema, {
      body: { operationId, ...(speed === undefined ? {} : { speed }) },
      csrf,
    }),
  command: (command: IncidentCommand, csrf: string) =>
    request(
      `${base(command.runId)}/commands`,
      z.object({ commandId: z.string() }),
      { body: command, csrf },
    ),
  invite: (runId: string, csrf: string) =>
    request(
      `${base(runId)}/controller-invites`,
      z.object({ joinUrl: z.string(), expiresAtWallMs: z.number() }),
      { body: {}, csrf },
    ),
};
