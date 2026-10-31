// Dependency-free unit assertions; execute with `bun web/src/lib/api.test.ts`.
import { z } from "zod";
import { ApiError, request } from "./api";
function check(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
const originalFetch = globalThis.fetch;
try {
  const sent: RequestInit[] = [];
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
    sent.push(options ?? {});
    return new Response(JSON.stringify({ commandId: "stable-command" }), {
      status: 202,
    });
  }) as typeof fetch;
  const body = { commandId: "stable-command", incidentId: "stable-incident" };
  for (let retry = 0; retry < 2; retry++)
    await request("/api/example", z.object({ commandId: z.string() }), {
      body,
      csrf: "session-csrf",
    });
  check(
    sent[0]?.body === sent[1]?.body,
    "retry payload preserves command and incident IDs",
  );
  check(
    sent[0]?.credentials === "same-origin",
    "requests include same-origin credentials",
  );
  check(
    (sent[0]?.headers as Record<string, string>)["X-CSRF-Token"] ===
      "session-csrf",
    "mutations use bootstrap CSRF",
  );
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "UNAUTHORIZED",
          message: "Join again.",
          retryable: false,
        },
      }),
      { status: 401 },
    )) as typeof fetch;
  try {
    await request("/api/example", z.object({ commandId: z.string() }));
    throw new Error("Expected API failure");
  } catch (failure) {
    check(
      failure instanceof ApiError &&
        failure.authFailure &&
        !failure.retryable &&
        failure.message === "Join again.",
      "typed auth errors preserve server meaning",
    );
  }
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ commandId: 3 }))) as typeof fetch;
  try {
    await request("/api/example", z.object({ commandId: z.string() }));
    throw new Error("Expected schema failure");
  } catch (failure) {
    check(
      failure instanceof ApiError &&
        failure.code === "INVALID_RESPONSE" &&
        failure.retryable,
      "invalid payloads are rejected",
    );
  }
  globalThis.fetch = (async () =>
    new Response("not-json", { status: 202 })) as typeof fetch;
  try {
    await request("/api/example", z.object({ commandId: z.string() }), {
      body,
      csrf: "session-csrf",
    });
    throw new Error("Expected malformed JSON failure");
  } catch (failure) {
    check(
      failure instanceof ApiError &&
        failure.retryable &&
        failure.status === 202,
      "malformed accepted response remains ambiguous and reconcilable",
    );
  }
  console.log("API assertions passed");
} finally {
  globalThis.fetch = originalFetch;
}
