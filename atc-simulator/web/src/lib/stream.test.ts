// Dependency-free unit assertions; execute with `bun web/src/lib/stream.test.ts`.
import type {
  CommandReceipt,
  PublicSnapshot,
} from "@ghost-tower/domain/public";
import { acceptStreamVersion, mergeReceipt, newerSnapshot } from "./stream";
function check(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
const receipt = (
  status: CommandReceipt["status"],
  runId = "run-a",
): CommandReceipt => ({
  commandId: "command-a",
  incidentId: "incident-a",
  runId,
  status,
  code: null,
  resultingRevision: null,
});
for (const status of ["APPLIED", "REJECTED"] as const) {
  for (const next of [
    "QUEUED",
    "SENT",
    "DELAYED",
    "APPLIED",
    "REJECTED",
  ] as const)
    check(
      mergeReceipt(receipt(status), receipt(next)).status === status,
      `${status} must remain terminal against ${next}`,
    );
}
check(
  mergeReceipt(receipt("SENT"), receipt("QUEUED")).status === "SENT",
  "older queued receipt must not regress SENT",
);
check(
  mergeReceipt(receipt("DELAYED"), receipt("SENT")).status === "DELAYED",
  "older SENT must not erase uncertainty",
);
check(
  mergeReceipt(receipt("DELAYED"), receipt("APPLIED")).status === "APPLIED",
  "delayed command can eventually apply",
);
const snapshot = (runId: string, projectionVersion: number) =>
  ({ runId, projectionVersion }) as PublicSnapshot;
check(
  newerSnapshot(null, snapshot("run-a", 0), "run-a"),
  "initial projection zero is accepted",
);
check(
  !newerSnapshot(snapshot("run-a", 7), snapshot("run-a", 7), "run-a"),
  "duplicate snapshots are ignored",
);
check(
  !newerSnapshot(snapshot("run-a", 7), snapshot("run-a", 6), "run-a"),
  "old snapshots cannot regress command state",
);
check(
  !newerSnapshot(snapshot("run-a", 7), snapshot("run-b", 8), "run-a"),
  "wrong-run snapshots are ignored",
);
check(
  newerSnapshot(snapshot("run-a", 7), snapshot("run-b", 0), "run-b"),
  "new run starts its own version sequence",
);
console.log("stream reducer assertions passed");

const versions = { latestSse: -1, latestObserved: -1 };
check(
  acceptStreamVersion(versions, 4, "sse"),
  "initial SSE establishes freshness",
);
check(
  !acceptStreamVersion(versions, 4, "sse"),
  "equal-version replay does not refresh SSE freshness",
);
check(
  acceptStreamVersion(versions, 7, "poll"),
  "newer poll advances the data fence",
);
check(versions.latestSse === 4, "poll does not count as SSE recovery");
check(
  !acceptStreamVersion(versions, 6, "sse"),
  "SSE behind polling cannot claim live connection",
);
check(
  acceptStreamVersion(versions, 7, "sse"),
  "SSE matching poll can recover when new to SSE",
);
check(
  !acceptStreamVersion(versions, 7, "sse"),
  "replayed recovery frame cannot remain fresh forever",
);
check(
  !acceptStreamVersion(versions, 6, "poll"),
  "older polls do not lower the data fence",
);
console.log("stream freshness regression assertions passed");
