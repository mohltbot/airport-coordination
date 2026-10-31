import { useMemo, useState } from "react";
import type { PublicSnapshot } from "@ghost-tower/domain/public";
import "./display.css";
export function FlightList({
  snapshot,
  selectedId,
  onSelect,
}: {
  snapshot: PublicSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const flights = useMemo(
    () =>
      snapshot.flights
        .filter(
          (f) =>
            `${f.callsign} ${f.flightId} ${f.originalDestination} ${f.activeAssignment?.airportId ?? ""}`
              .toLowerCase()
              .includes(query.toLowerCase()) &&
            (filter === "All" ||
              (filter === "Emergency" && f.priority === "EMERGENCY") ||
              (filter === "Negotiating" && !!f.negotiationStage) ||
              (filter === "Landed" && f.phase === "LANDED") ||
              (filter === "Unresolved" && f.phase === "UNRESOLVED")),
        )
        .sort((a, b) => a.callsign.localeCompare(b.callsign)),
    [snapshot, query, filter],
  );
  return (
    <section className="fleet-panel" aria-label="Flight list">
      <div className="fleet-heading">
        <h2>Fleet</h2>
        <span>{snapshot.flights.length} aircraft</span>
      </div>
      <label className="fleet-search">
        Search flights
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Callsign or airport"
        />
      </label>
      <label className="fleet-filter">
        Show
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {["All", "Emergency", "Negotiating", "Landed", "Unresolved"].map(
            (v) => (
              <option key={v}>{v}</option>
            ),
          )}
        </select>
      </label>
      <div className="fleet-results" aria-live="polite">
        {flights.length} matching flights
      </div>
      <ul className="fleet-list">
        {flights.map((f) => (
          <li key={f.entityId}>
            <button
              className={`fleet-flight ${selectedId === f.entityId ? "fleet-selected" : ""}`}
              onClick={() => onSelect(f.entityId)}
              aria-pressed={selectedId === f.entityId}
            >
              <span className="fleet-row">
                <strong>{f.callsign}</strong>
                <span
                  className={
                    f.priority === "EMERGENCY"
                      ? "fleet-emergency"
                      : "fleet-phase"
                  }
                >
                  {f.priority === "EMERGENCY"
                    ? "! Emergency"
                    : f.phase.toLowerCase()}
                </span>
              </span>
              <span className="fleet-row">
                <span>Fuel {Math.ceil(f.fuelRemainingSec / 60)} min</span>
                <span>Orig. {f.originalDestination}</span>
              </span>
              <span className="fleet-assignment">
                {f.activeAssignment
                  ? `→ ${f.activeAssignment.airportId} · ${f.activeAssignment.runwayId} confirmed`
                  : f.phase === "UNRESOLVED"
                    ? "Unresolved"
                    : f.phase === "LANDED"
                      ? "Landed"
                      : f.negotiationStage
                        ? `Negotiating · ${f.negotiationStage.replaceAll("_", " ").toLowerCase()}`
                        : "Awaiting assignment"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!flights.length && (
        <p className="fleet-empty">No flights match your search.</p>
      )}
    </section>
  );
}
