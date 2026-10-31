import { useState } from "react";
import { useSimulator } from "../hooks/useSimulator";
import "./controller.css";

export function CommandStatus({ targetId }: { targetId?: string }) {
  const {
    commands,
    retryCommand,
    bootstrap,
    snapshot,
    sessionExpired,
    isFixture,
  } = useSimulator();
  const [retrying, setRetrying] = useState<string | null>(null);
  const session = bootstrap?.session;
  const canMutate =
    !isFixture &&
    !sessionExpired &&
    session &&
    session.role !== "VIEWER" &&
    (session.role !== "CONTROLLER" || session.runId === snapshot?.runId);
  const [error, setError] = useState<string | null>(null);
  const visible = commands.filter(
    (command) => !targetId || command.target === targetId,
  );
  if (!visible.length) return null;
  return (
    <section className="command-status" aria-label="Command delivery">
      <h3>Command delivery</h3>
      <p className="command-note">
        Queued commands become incidents only after application is confirmed.
      </p>
      {error && <p role="alert">{error}</p>}
      <ul>
        {visible.map((command) => (
          <li key={command.commandId}>
            <div>
              <strong>{command.label}</strong>
              <span className="command-state">
                {command.submissionFailed ? "Not submitted" : command.status}
              </span>
            </div>
            {!command.submissionFailed && command.status === "SENT" && (
              <p>Sent to the agent. Awaiting application.</p>
            )}
            {!command.submissionFailed && command.status === "DELAYED" && (
              <p>Application is delayed. Reconciliation continues.</p>
            )}
            {!command.submissionFailed && command.status === "APPLIED" && (
              <p>Application confirmed. Incident state is shown below.</p>
            )}
            {(command.error || command.code) && (
              <p>{command.error || command.code}</p>
            )}
            {command.canRetry && (
              <button
                type="button"
                disabled={
                  !canMutate ||
                  retrying === command.commandId ||
                  snapshot?.flights.some(
                    (flight) =>
                      flight.entityId === command.target &&
                      (flight.phase === "LANDED" ||
                        flight.phase === "UNRESOLVED"),
                  ) ||
                  !snapshot ||
                  [
                    "CONFIGURING",
                    "STARTING",
                    "COMPLETED",
                    "RESETTING",
                  ].includes(snapshot.phase)
                }
                onClick={() => {
                  setError(null);
                  setRetrying(command.commandId);
                  void retryCommand(command.commandId)
                    .catch(() =>
                      setError("Retry could not be delivered. Try again."),
                    )
                    .finally(() => setRetrying(null));
                }}
              >
                Retry same command
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
