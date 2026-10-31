import {
  CommandReceiptSchema,
  PublicSnapshotSchema,
  type CommandReceipt,
  type PublicSnapshot,
} from "@ghost-tower/domain/public";
import { api, ApiError } from "./api";
export type Connection = "connecting" | "live" | "reconnecting" | "offline";
export const terminal = (status: CommandReceipt["status"]) =>
  status === "APPLIED" || status === "REJECTED";
export function mergeReceipt(
  previous: CommandReceipt | undefined,
  next: CommandReceipt,
): CommandReceipt {
  if (previous && previous.runId === next.runId) {
    if (terminal(previous.status)) return previous;
    const rank = { QUEUED: 0, SENT: 1, DELAYED: 2, APPLIED: 3, REJECTED: 3 };
    if (rank[previous.status] > rank[next.status]) return previous;
  }
  return next;
}
export function newerSnapshot(
  current: PublicSnapshot | null,
  next: PublicSnapshot,
  runId: string,
) {
  return (
    next.runId === runId &&
    (!current ||
      current.runId !== runId ||
      next.projectionVersion > current.projectionVersion)
  );
}
export interface StreamVersions {
  latestSse: number;
  latestObserved: number;
}
// A poll advances the data fence, while only a new SSE frame restores freshness.
export function acceptStreamVersion(
  state: StreamVersions,
  version: number,
  source: "sse" | "poll",
) {
  if (
    version < state.latestObserved ||
    (source === "sse" && version <= state.latestSse)
  )
    return false;
  state.latestObserved = version;
  if (source === "sse") state.latestSse = version;
  return true;
}
export function openRunStream(
  runId: string,
  callbacks: {
    snapshot: (value: PublicSnapshot) => void;
    command: (value: CommandReceipt) => void;
    connection: (value: Connection) => void;
    reset: () => void;
    error: (error: unknown) => void;
  },
) {
  let disposed = false,
    polling = false,
    lastSnapshot = Date.now(),
    stale = false;
  const versions: StreamVersions = { latestSse: -1, latestObserved: -1 };
  const abort = new AbortController();
  const source = new EventSource(
    `/api/runs/${encodeURIComponent(runId)}/events`,
  );
  callbacks.connection("connecting");
  source.addEventListener("snapshot", (event) => {
    try {
      const value = PublicSnapshotSchema.parse(
        JSON.parse((event as MessageEvent).data),
      );
      if (
        value.runId !== runId ||
        disposed ||
        !acceptStreamVersion(versions, value.projectionVersion, "sse")
      )
        return;
      lastSnapshot = Date.now();
      stale = false;
      callbacks.connection("live");
      callbacks.snapshot(value);
    } catch {
      /* Invalid frames never establish freshness. */
    }
  });
  source.addEventListener("command", (event) => {
    try {
      const value = CommandReceiptSchema.parse(
        JSON.parse((event as MessageEvent).data),
      );
      if (!disposed && value.runId === runId) callbacks.command(value);
    } catch {
      /* Ignore malformed frames. */
    }
  });
  source.addEventListener("run-reset", (event) => {
    try {
      const value: unknown = JSON.parse((event as MessageEvent).data);
      if (
        typeof value === "object" &&
        value !== null &&
        "previousRunId" in value &&
        value.previousRunId === runId &&
        !disposed
      ) {
        callbacks.reset();
        stop();
      }
    } catch {
      /* Ignore malformed frames. */
    }
  });
  source.onerror = () => {
    if (!disposed) {
      stale = true;
      callbacks.connection("reconnecting");
    }
  };
  const poll = async () => {
    if (disposed || polling || !stale) return;
    polling = true;
    try {
      const value = await api.snapshot(runId, abort.signal);
      if (
        !disposed &&
        value.runId === runId &&
        acceptStreamVersion(versions, value.projectionVersion, "poll")
      )
        callbacks.snapshot(value);
    } catch (error) {
      if (!disposed) {
        callbacks.error(error);
        if (error instanceof ApiError && error.authFailure) stop();
      }
    } finally {
      polling = false;
    }
  };
  const freshness = setInterval(() => {
    if (Date.now() - lastSnapshot >= 2000) {
      stale = true;
      callbacks.connection("reconnecting");
    }
  }, 250);
  const interval = setInterval(() => {
    void poll();
  }, 1000);
  const stop = () => {
    disposed = true;
    abort.abort();
    source.close();
    clearInterval(interval);
    clearInterval(freshness);
  };
  return stop;
}
