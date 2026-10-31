import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Bootstrap,
  CommandReceipt,
  IncidentCommand,
  IncidentKind,
  PublicAirport,
  PublicFlight,
  PublicIncident,
  PublicSnapshot,
  RunConfig,
} from "@ghost-tower/domain/public";
import { api, ApiError } from "../lib/api";
import {
  mergeReceipt,
  newerSnapshot,
  openRunStream,
  terminal,
  type Connection,
} from "../lib/stream";
export interface CommandView {
  commandId: string;
  incidentId: string;
  target: string | null;
  label: string;
  status: CommandReceipt["status"];
  code: string | null;
  error: string | null;
  canRetry: boolean;
  submissionFailed: boolean;
}
interface SimulatorContext {
  bootstrap: Bootstrap | null;
  snapshot: PublicSnapshot | null;
  connection: Connection;
  error: string | null;
  busy: boolean;
  sessionExpired: boolean;
  isFixture: boolean;
  commands: CommandView[];
  refresh(): Promise<void>;
  join(token: string): Promise<Bootstrap>;
  start(config: RunConfig): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setSpeed(speed: 1 | 5 | 10): Promise<void>;
  reset(): Promise<void>;
  invite(): Promise<{ joinUrl: string; expiresAtWallMs: number }>;
  createIncident(
    target: PublicAirport["entityId"] | PublicFlight["entityId"],
    kind: IncidentKind,
    runwayId?: "R1" | "R2",
  ): Promise<void>;
  resolveIncident(incident: PublicIncident): Promise<void>;
  retryCommand(commandId: string): Promise<void>;
}
const Context = createContext<SimulatorContext | null>(null);
type LocalCommand = {
  body: IncidentCommand;
  receipt: CommandReceipt;
  label: string;
  error: string | null;
  retry: boolean;
  sentAt: number;
  failed: boolean;
};
export function SimulatorProvider({
  children,
  fixture,
}: {
  children: ReactNode;
  fixture?: PublicSnapshot;
}) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null),
    [snapshot, setSnapshot] = useState<PublicSnapshot | null>(fixture ?? null),
    [connection, setConnection] = useState<Connection>(
      fixture ? "offline" : "connecting",
    ),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [sessionExpired, setExpired] = useState(false),
    [, render] = useState(0);
  const boot = useRef(bootstrap),
    snap = useRef(snapshot),
    expired = useRef(false),
    mounted = useRef(true),
    generation = useRef(0),
    bootstrapRequest = useRef(0),
    locked = useRef(false),
    commands = useRef(new Map<string, LocalCommand>()),
    receipts = useRef(new Map<string, CommandReceipt>()),
    inFlight = useRef(new Map<string, Promise<void>>()),
    actionIds = useRef(new Map<string, string>());
  const joining = useRef<{ token: string; promise: Promise<Bootstrap> } | null>(
    null,
  );
  const update = useCallback(() => {
    if (mounted.current) render((value) => value + 1);
  }, []);
  const fail = useCallback((failure: unknown) => {
    if (!mounted.current) return;
    setError(failure instanceof Error ? failure.message : "Request failed.");
    if (failure instanceof ApiError && failure.authFailure) {
      expired.current = true;
      setExpired(true);
    }
  }, []);
  const acceptReceipt = useCallback(
    (value: CommandReceipt) => {
      if (
        value.runId !== snap.current?.runId &&
        value.runId !== boot.current?.activeRun?.runId
      )
        return;
      const local = commands.current.get(value.commandId);
      const merged = mergeReceipt(
        receipts.current.get(value.commandId) ?? local?.receipt,
        value,
      );
      receipts.current.set(value.commandId, merged);
      if (local) {
        local.receipt = merged;
        if (terminal(merged.status)) {
          local.retry = false;
          local.error = null;
          local.failed = false;
        }
      }
      update();
    },
    [update],
  );
  const acceptSnapshot = useCallback(
    (value: PublicSnapshot) => {
      const runId = boot.current?.activeRun?.runId ?? snap.current?.runId;
      if (!runId || !newerSnapshot(snap.current, value, runId)) return;
      snap.current = value;
      setSnapshot(value);
      value.commands.forEach(acceptReceipt);
    },
    [acceptReceipt],
  );
  const applyBootstrap = useCallback(
    (value: Bootstrap) => {
      const old = boot.current?.activeRun?.runId;
      if (old !== value.activeRun?.runId) {
        generation.current++;
        commands.current.clear();
        receipts.current.clear();
        inFlight.current.clear();
        actionIds.current.clear();
        snap.current = null;
        setSnapshot(null);
      }
      boot.current = value;
      setBootstrap(value);
      expired.current = false;
      setExpired(false);
      setError(null);
      if (value.snapshot) acceptSnapshot(value.snapshot);
    },
    [acceptSnapshot],
  );
  const refresh = useCallback(async () => {
    if (fixture) return;
    if (joining.current) {
      await joining.current.promise;
      return;
    }
    const sequence = ++bootstrapRequest.current;
    try {
      const value = await api.bootstrap();
      if (mounted.current && sequence === bootstrapRequest.current)
        applyBootstrap(value);
    } catch (failure) {
      if (sequence === bootstrapRequest.current) fail(failure);
      throw failure;
    }
  }, [fixture, applyBootstrap, fail]);
  const join = useCallback(
    (token: string): Promise<Bootstrap> => {
      if (fixture)
        return Promise.reject(new Error("Development data is read only."));
      if (joining.current?.token === token) return joining.current.promise;
      const sequence = ++bootstrapRequest.current;
      const promise: Promise<Bootstrap> = api
        .join(token)
        .then((value) => {
          if (mounted.current && sequence === bootstrapRequest.current)
            applyBootstrap(value);
          return value;
        })
        .catch((failure) => {
          if (sequence === bootstrapRequest.current) fail(failure);
          if (joining.current?.promise === promise) joining.current = null;
          throw failure;
        });
      joining.current = { token, promise };
      // Keep successful exchange deduplication through StrictMode's effect replay.
      void promise.then(
        () => {
          queueMicrotask(() => {
            if (joining.current?.promise === promise) joining.current = null;
          });
        },
        () => {},
      );
      return promise;
    },
    [fixture, applyBootstrap, fail],
  );
  useEffect(() => {
    mounted.current = true;
    if (!fixture) void refresh().catch(() => setConnection("offline"));
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [fixture, refresh]);
  const runId = bootstrap?.activeRun?.runId;
  useEffect(() => {
    if (fixture || !runId) return;
    return openRunStream(runId, {
      snapshot: acceptSnapshot,
      command: acceptReceipt,
      connection: setConnection,
      error: fail,
      reset: () => {
        generation.current++;
        bootstrapRequest.current++;
        if (boot.current?.session.role === "CONTROLLER") {
          expired.current = true;
          setExpired(true);
          setError("This run was reset. Join again using a fresh invitation.");
          setConnection("offline");
        } else void refresh().catch(() => {});
      },
    });
  }, [runId, fixture, acceptSnapshot, acceptReceipt, refresh, fail]);
  const credentials = useCallback(
    (operator = false) => {
      if (fixture) throw new Error("Development data is read only.");
      const session = boot.current?.session;
      if (
        expired.current ||
        !session?.csrfToken ||
        session.role === "VIEWER" ||
        (operator && session.role !== "OPERATOR")
      )
        throw new Error(
          "Join with an authorized invitation to use these controls.",
        );
      return session.csrfToken;
    },
    [fixture],
  );
  const exclusive = useCallback(
    async (action: () => Promise<void>) => {
      if (locked.current)
        throw new Error("An operation is already in progress.");
      locked.current = true;
      setBusy(true);
      try {
        await action();
      } catch (failure) {
        fail(failure);
        throw failure;
      } finally {
        locked.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [fail],
  );
  const control = useCallback(
    async (action: string, speed?: 1 | 5 | 10) =>
      exclusive(async () => {
        const csrf = credentials(true),
          id = boot.current?.activeRun?.runId;
        if (!id) throw new Error("Create a run first.");
        const key = `${id}:${action}:${speed ?? ""}`,
          operationId = actionIds.current.get(key) ?? crypto.randomUUID();
        actionIds.current.set(key, operationId);
        const epoch = generation.current;
        await api.control(id, action, operationId, csrf, speed);
        if (epoch !== generation.current) return;
        await refresh();
        actionIds.current.delete(key);
      }),
    [credentials, exclusive, refresh],
  );
  const start = useCallback(
    async (config: RunConfig) =>
      exclusive(async () => {
        const csrf = credentials(true);
        let current = boot.current?.activeRun;
        if (
          current &&
          current.phase !== "CONFIGURING" &&
          current.phase !== "STARTING"
        )
          throw new Error("The current run has already started.");
        const key = `create:${JSON.stringify(config)}`;
        const requestId = actionIds.current.get(key) ?? crypto.randomUUID();
        actionIds.current.set(key, requestId);
        if (!current || current.phase === "CONFIGURING") {
          const epoch = generation.current;
          current = await api.create(requestId, config, csrf);
          if (epoch !== generation.current)
            throw new Error("The active run changed. Refresh before starting.");
          const sequence = ++bootstrapRequest.current;
          const value = await api.bootstrap();
          if (
            epoch !== generation.current ||
            sequence !== bootstrapRequest.current ||
            value.activeRun?.runId !== current.runId
          )
            throw new Error("The active run changed. Refresh before starting.");
          applyBootstrap(value);
        }
        const operationKey = `start:${current.runId}`,
          operationId =
            actionIds.current.get(operationKey) ?? crypto.randomUUID();
        actionIds.current.set(operationKey, operationId);
        await api.control(current.runId, "start", operationId, csrf);
        await refresh();
        actionIds.current.delete(key);
        actionIds.current.delete(operationKey);
      }),
    [credentials, exclusive, applyBootstrap, refresh],
  );
  const submit = useCallback(
    (local: LocalCommand): Promise<void> => {
      const existing = inFlight.current.get(local.body.commandId);
      if (existing) return existing;
      const csrf = credentials();
      if (local.body.runId !== boot.current?.activeRun?.runId)
        return Promise.reject(
          new Error("This command belongs to a previous run."),
        );
      const epoch = generation.current;
      local.retry = false;
      local.error = null;
      local.failed = false;
      const promise = api
        .command(local.body, csrf)
        .then(() => {})
        .catch((failure) => {
          if (epoch === generation.current && !terminal(local.receipt.status)) {
            local.error =
              failure instanceof Error
                ? failure.message
                : "Command outcome uncertain.";
            local.retry = failure instanceof ApiError && failure.retryable;
            local.failed = !local.retry;
            if (local.failed) local.error = `Not submitted: ${local.error}`;
            if (local.retry && Date.now() - local.sentAt >= 15000)
              local.receipt = { ...local.receipt, status: "DELAYED" };
            fail(failure);
          }
          throw failure;
        })
        .finally(() => {
          inFlight.current.delete(local.body.commandId);
          if (epoch === generation.current) update();
        });
      inFlight.current.set(local.body.commandId, promise);
      update();
      return promise;
    },
    [credentials, fail, update],
  );
  const queue = useCallback(
    async (body: IncidentCommand, label: string) => {
      credentials();
      const duplicate = [...commands.current.values()].find(
        (item) =>
          item.body.runId === body.runId &&
          item.body.type === body.type &&
          item.body.payload.target === body.payload.target &&
          item.label === label &&
          !item.failed &&
          !terminal(item.receipt.status),
      );
      if (duplicate) {
        const pending = inFlight.current.get(duplicate.body.commandId);
        if (pending) await pending;
        return;
      }
      const local: LocalCommand = {
        body,
        label,
        receipt: {
          commandId: body.commandId,
          incidentId: body.payload.incidentId,
          runId: body.runId,
          status: "QUEUED",
          code: null,
          resultingRevision: null,
        },
        error: null,
        retry: false,
        sentAt: Date.now(),
        failed: false,
      };
      commands.current.set(body.commandId, local);
      update();
      await submit(local);
    },
    [credentials, submit, update],
  );
  useEffect(() => {
    if (fixture || !runId) return;
    let polling = false;
    const abort = new AbortController();
    const timer = setInterval(() => {
      if (expired.current) return;
      const pending = [...commands.current.values()].filter(
        (item) =>
          item.body.runId === runId &&
          !item.failed &&
          !terminal(item.receipt.status),
      );
      for (const item of pending)
        if (
          Date.now() - item.sentAt >= 15000 &&
          item.receipt.status !== "DELAYED"
        ) {
          item.receipt = { ...item.receipt, status: "DELAYED" };
          receipts.current.set(item.body.commandId, item.receipt);
          update();
        }
      if (polling || abort.signal.aborted || pending.length === 0) return;
      polling = true;
      void Promise.allSettled(
        pending.map(async (item) => {
          try {
            const receipt = await api.receipt(
              runId,
              item.body.commandId,
              abort.signal,
            );
            if (!abort.signal.aborted) acceptReceipt(receipt);
          } catch (failure) {
            if (
              !abort.signal.aborted &&
              failure instanceof ApiError &&
              failure.authFailure
            )
              fail(failure);
          }
        }),
      ).finally(() => {
        polling = false;
      });
    }, 1000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [fixture, runId, acceptReceipt, fail, update]);
  const views: CommandView[] = [...receipts.current.values()]
    .filter((item) => item.runId === runId)
    .map((item) => {
      const local = commands.current.get(item.commandId);
      return {
        commandId: item.commandId,
        incidentId: item.incidentId,
        target:
          local?.body.payload.target ??
          snapshot?.incidents.find(
            (incident) => incident.incidentId === item.incidentId,
          )?.target ??
          null,
        label: local?.label ?? "Incident command",
        status: item.status,
        code: item.code,
        error: local?.error ?? null,
        canRetry: local?.retry ?? false,
        submissionFailed: local?.failed ?? false,
      };
    });
  for (const local of commands.current.values())
    if (
      local.body.runId === runId &&
      !receipts.current.has(local.body.commandId)
    )
      views.push({
        commandId: local.body.commandId,
        incidentId: local.receipt.incidentId,
        target: local.body.payload.target,
        label: local.label,
        status: local.receipt.status,
        code: local.receipt.code,
        error: local.error,
        canRetry: local.retry,
        submissionFailed: local.failed,
      });
  return (
    <Context.Provider
      value={{
        bootstrap,
        snapshot,
        connection,
        error,
        busy,
        sessionExpired,
        isFixture: !!fixture,
        commands: views,
        refresh,
        join,
        start,
        pause: () => control("pause"),
        resume: () => control("resume"),
        setSpeed: (speed) => control("speed", speed),
        reset: () => control("reset"),
        invite: async () => {
          const csrf = credentials(true);
          if (!runId) throw new Error("Create a run first.");
          try {
            return await api.invite(runId, csrf);
          } catch (failure) {
            fail(failure);
            throw failure;
          }
        },
        createIncident: async (target, kind, runwayId) => {
          if (!runId) throw new Error("Create a run first.");
          const { IncidentCommandSchema } =
            await import("@ghost-tower/domain/public");
          const body = IncidentCommandSchema.parse({
            commandId: crypto.randomUUID(),
            runId,
            type: "INCIDENT_CREATE",
            payload: {
              incidentId: crypto.randomUUID(),
              target,
              kind,
              parameters: kind === "RUNWAY_CLOSED" ? { runwayId } : {},
            },
          });
          await queue(body, `${kind}${runwayId ? ` ${runwayId}` : ""}`);
        },
        resolveIncident: async (incident) => {
          if (!runId || incident.runId !== runId)
            throw new Error("This incident belongs to a previous run.");
          await queue(
            {
              commandId: crypto.randomUUID(),
              runId,
              type: "INCIDENT_CLEAR",
              payload: {
                incidentId: incident.incidentId,
                target: incident.target,
                expectedIncidentRevision: incident.revision,
              },
            },
            `Resolve ${incident.kind} ${incident.incidentId}`,
          );
        },
        retryCommand: async (id) => {
          const local = commands.current.get(id);
          if (!local || !local.retry)
            throw new Error("This command cannot be retried.");
          await submit(local);
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSimulator() {
  const value = useContext(Context);
  if (!value) throw new Error("useSimulator requires SimulatorProvider.");
  return value;
}
