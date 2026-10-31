import { useState } from "react";
import { useSimulator } from "../hooks/useSimulator";
import {
  IncidentControls,
  IncidentRecord,
} from "../components/IncidentControls";
import { CommandStatus } from "../components/CommandStatus";
import "../components/controller.css";

export function Controller() {
  const sim = useSimulator();
  const [tab, setTab] = useState<"Airports" | "Flights" | "Active incidents">(
    "Airports",
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [retryError, setRetryError] = useState(false);
  const snapshot = sim.snapshot;
  const targets = snapshot ? [...snapshot.airports, ...snapshot.flights] : [];
  const detail = targets.find((target) => target.entityId === selected);
  const active =
    snapshot?.incidents.filter((incident) => incident.status === "ACTIVE") ??
    [];
  return (
    <main className="ctrl-page">
      <header className="ctrl-header">
        <p>GHOST TOWER / PHONE CONTROL</p>
        <h1>Incident controller</h1>
        {snapshot && <p>Run {snapshot.runId}</p>}
        <span className="ctrl-connection" role="status">
          {sim.connection}
          {snapshot ? ` · ${snapshot.phase}` : ""}
        </span>
      </header>
      {sim.isFixture && (
        <p className="ctrl-banner">DEVELOPMENT DATA — commands disabled</p>
      )}
      {(sim.error || retryError) && (
        <div className="ctrl-banner" role="alert">
          <p>{sim.error || "Refresh failed. Try again."}</p>
          <button
            type="button"
            disabled={sim.busy}
            onClick={() => {
              setRetryError(false);
              void sim.refresh().catch(() => setRetryError(true));
            }}
          >
            Retry connection
          </button>
        </div>
      )}
      {!snapshot ? (
        <section className="ctrl-empty">
          <h2>{sim.busy ? "Loading run…" : "No active run"}</h2>
          <p>
            The operator must start a run before incident controls are
            available.
          </p>
        </section>
      ) : (
        <>
          <nav className="ctrl-tabs" aria-label="Controller sections">
            {(["Airports", "Flights", "Active incidents"] as const).map(
              (name) => (
                <button
                  type="button"
                  key={name}
                  aria-pressed={tab === name}
                  onClick={() => {
                    setTab(name);
                    setSelected(null);
                  }}
                >
                  {name}
                  {name === "Active incidents" ? ` (${active.length})` : ""}
                </button>
              ),
            )}
          </nav>
          {tab === "Flights" && (
            <label className="ctrl-search">
              Search flights
              <input
                type="search"
                placeholder="Callsign or flight ID"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          {detail ? (
            <section className="ctrl-detail">
              <button type="button" onClick={() => setSelected(null)}>
                ← Back to {tab.toLowerCase()}
              </button>
              <h2>{"callsign" in detail ? detail.callsign : detail.name}</h2>
              <p>
                {"phase" in detail
                  ? `${detail.flightId} · ${detail.phase} · ${Math.max(0, Math.floor(detail.fuelRemainingSec / 60))} min fuel`
                  : `${detail.airportId} · ${detail.status}`}
              </p>
              <IncidentControls target={detail} />
            </section>
          ) : (
            <>
              {tab === "Airports" && (
                <section aria-label="Airports">
                  <h2>Airports</h2>
                  <ul className="ctrl-targets">
                    {snapshot.airports.map((airport) => (
                      <li key={airport.entityId}>
                        <button
                          type="button"
                          onClick={() => setSelected(airport.entityId)}
                        >
                          <strong>
                            {airport.airportId} · {airport.name}
                          </strong>
                          <span>
                            {airport.status} · {airport.queue.length} queued
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!snapshot.airports.length && <p>No airports in this run.</p>}
                </section>
              )}
              {tab === "Flights" && (
                <section aria-label="Flights">
                  <h2>Flights</h2>
                  <ul className="ctrl-targets">
                    {snapshot.flights
                      .filter((flight) =>
                        `${flight.callsign} ${flight.flightId}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((flight) => (
                        <li key={flight.entityId}>
                          <button
                            type="button"
                            onClick={() => setSelected(flight.entityId)}
                          >
                            <strong>
                              {flight.callsign} · {flight.flightId}
                            </strong>
                            <span>
                              {flight.phase} · {flight.priority}
                            </span>
                          </button>
                        </li>
                      ))}
                  </ul>
                  {!snapshot.flights.some((flight) =>
                    `${flight.callsign} ${flight.flightId}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  ) && <p>No flights match your search.</p>}
                </section>
              )}
              {tab === "Active incidents" && (
                <section>
                  <h2>Active incidents</h2>
                  {!active.length && <p>No active incidents.</p>}
                  <ul className="ctrl-targets">
                    {active.map((incident) => (
                      <IncidentRecord
                        key={incident.incidentId}
                        incident={incident}
                      />
                    ))}
                  </ul>
                  <CommandStatus />
                </section>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
