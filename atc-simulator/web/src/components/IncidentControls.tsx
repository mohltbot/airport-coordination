import { useState } from "react";
import type {
  IncidentKind,
  PublicAirport,
  PublicFlight,
  PublicIncident,
} from "@ghost-tower/domain/public";
import { useSimulator } from "../hooks/useSimulator";
import { CommandStatus } from "./CommandStatus";
import "./controller.css";

const labels: Record<IncidentKind, string> = {
  WEATHER_CLOSED: "Weather closure",
  RUNWAY_CLOSED: "Runway closure",
  CAPACITY_REDUCED: "Reduce capacity",
  SMOKE: "Smoke",
  ENGINE_TROUBLE: "Engine trouble",
  LOW_FUEL: "Low fuel",
};
export function IncidentControls({
  target,
  compact = false,
}: {
  target: PublicAirport | PublicFlight;
  compact?: boolean;
}) {
  const sim = useSimulator();
  const [runway, setRunway] = useState<"" | "R1" | "R2">("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const airport = "airportId" in target;
  const terminal =
    !airport && (target.phase === "LANDED" || target.phase === "UNRESOLVED");
  const session = sim.bootstrap?.session;
  const mismatch =
    session?.role === "CONTROLLER" && session.runId !== sim.snapshot?.runId;
  const authorized =
    session &&
    session.role !== "VIEWER" &&
    !sim.sessionExpired &&
    !mismatch &&
    !sim.isFixture;
  const phaseBlocked =
    !sim.snapshot ||
    ["CONFIGURING", "STARTING", "COMPLETED", "RESETTING"].includes(
      sim.snapshot.phase,
    );
  const pending = sim.commands.some(
    (command) =>
      command.target === target.entityId &&
      !command.submissionFailed &&
      !["APPLIED", "REJECTED"].includes(command.status),
  );
  const disabled =
    !authorized || terminal || phaseBlocked || submitting || pending;
  const incidents =
    sim.snapshot?.incidents.filter(
      (incident) => incident.target === target.entityId,
    ) ?? [];
  const kinds: IncidentKind[] = airport
    ? ["WEATHER_CLOSED", "RUNWAY_CLOSED", "CAPACITY_REDUCED"]
    : ["SMOKE", "ENGINE_TROUBLE", "LOW_FUEL"];
  async function perform(action: () => Promise<void>) {
    setError(null);
    setSubmitting(true);
    try {
      await action();
    } catch {
      setError(
        "Command could not be submitted. Check command delivery for a retry. If the run was reset, request a fresh invite.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section
      className={`incident-controls${compact ? " incident-compact" : ""}`}
      aria-label="Incident controls"
    >
      <h3>Incident controls</h3>
      {!authorized && (
        <p className="incident-notice">
          {sim.isFixture
            ? "Development data — commands are disabled."
            : sim.sessionExpired || mismatch
              ? "Your controller session is no longer valid for this run. Request a fresh invite from the operator and open its join link."
              : "View only. Ask the operator for a controller invite and open its join link."}
        </p>
      )}
      {terminal && (
        <p>This flight has finished. Incident controls are disabled.</p>
      )}
      {phaseBlocked && (
        <p>Incident commands are unavailable in this run phase.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {airport && (
        <label className="incident-runway">
          Runway for closure
          <select
            value={runway}
            onChange={(event) =>
              setRunway(event.target.value as "" | "R1" | "R2")
            }
            disabled={disabled}
          >
            <option value="">Select runway</option>
            <option value="R1">R1</option>
            <option value="R2">R2</option>
          </select>
        </label>
      )}
      <div className="incident-actions">
        {kinds.map((kind) => (
          <button
            type="button"
            key={kind}
            disabled={disabled || (kind === "RUNWAY_CLOSED" && !runway)}
            onClick={() =>
              void perform(() =>
                sim.createIncident(
                  target.entityId,
                  kind,
                  kind === "RUNWAY_CLOSED" ? runway || undefined : undefined,
                ),
              )
            }
          >
            {labels[kind]}
          </button>
        ))}
      </div>
      {pending && (
        <p role="status">
          A command is awaiting a terminal receipt for this target.
        </p>
      )}
      <CommandStatus targetId={target.entityId} />
      <h4>Active incidents</h4>
      {incidents.some((i) => i.status === "ACTIVE") ? (
        <ul>
          {incidents
            .filter((i) => i.status === "ACTIVE")
            .map((incident) => (
              <IncidentRecord key={incident.incidentId} incident={incident} />
            ))}
        </ul>
      ) : (
        <p>No active incidents.</p>
      )}
      {incidents.some((i) => i.status === "RESOLVED") && (
        <details>
          <summary>Resolved incidents</summary>
          <ul>
            {incidents
              .filter((i) => i.status === "RESOLVED")
              .map((incident) => (
                <IncidentRecord key={incident.incidentId} incident={incident} />
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function IncidentRecord({ incident }: { incident: PublicIncident }) {
  const sim = useSimulator();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = sim.bootstrap?.session;
  const target = sim.snapshot?.flights.find(
    (flight) => flight.entityId === incident.target,
  );
  const terminal = target?.phase === "LANDED" || target?.phase === "UNRESOLVED";
  const authorized =
    session &&
    session.role !== "VIEWER" &&
    !sim.sessionExpired &&
    !sim.isFixture &&
    (session.role !== "CONTROLLER" || session.runId === sim.snapshot?.runId);
  const phaseBlocked =
    !sim.snapshot ||
    ["CONFIGURING", "STARTING", "COMPLETED", "RESETTING"].includes(
      sim.snapshot.phase,
    );
  const pending = sim.commands.some(
    (command) =>
      command.incidentId === incident.incidentId &&
      !command.submissionFailed &&
      !["APPLIED", "REJECTED"].includes(command.status),
  );
  async function resolve() {
    setSubmitting(true);
    setError(null);
    try {
      await sim.resolveIncident(incident);
    } catch {
      setError(
        "Resolve could not be submitted. Check command delivery; after a run reset, request a fresh invite.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <li className="incident-record">
      <div>
        <strong>{labels[incident.kind]}</strong>
        <span>{incident.status}</span>
      </div>
      <p>
        {incident.target} · Applied at{" "}
        {Math.floor(incident.createdAtSimSec / 60)}:
        {String(Math.floor(incident.createdAtSimSec % 60)).padStart(2, "0")} sim
      </p>
      {"runwayId" in incident.parameters && (
        <p>Runway {incident.parameters.runwayId}</p>
      )}
      {incident.kind === "LOW_FUEL" && (
        <p>Resolves the report; remaining fuel does not increase.</p>
      )}
      {!authorized && incident.status === "ACTIVE" && (
        <p>
          {sim.isFixture
            ? "Development data — commands are disabled."
            : "To resolve incidents, ask the operator for a fresh controller invite and open its join link."}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {incident.status === "ACTIVE" && (
        <button
          type="button"
          disabled={
            !authorized || terminal || phaseBlocked || submitting || pending
          }
          onClick={() => void resolve()}
        >
          Resolve {labels[incident.kind].toLowerCase()}
        </button>
      )}
    </li>
  );
}
