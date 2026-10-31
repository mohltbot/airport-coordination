import { useEffect, useState } from "react";
import { useSimulator } from "../hooks/useSimulator";
import { AirspaceMap } from "../components/AirspaceMap";
import { FlightList } from "../components/FlightList";
import { EntityInspector } from "../components/EntityInspector";
import { Timeline } from "../components/Timeline";
import { IncidentControls } from "../components/IncidentControls";
import { US_AIRPORTS } from "../lib/us-geography";
import {
  PhoneInvite,
  ResetDialog,
  RunSetup,
} from "../components/OperatorControls";
import "../components/display.css";
import "../components/controller.css";

function clock(seconds: number) {
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function Display() {
  const sim = useSimulator();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fleetOpen, setFleetOpen] = useState(false);
  const [mobileView, setMobileView] = useState<"map" | "list">("map");
  const [dialog, setDialog] = useState<"phone" | "reset" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const snapshot = sim.snapshot;
  const nationalMap = snapshot?.airports.some((airport) =>
    US_AIRPORTS.some((known) => known.airportId === String(airport.airportId)),
  ) ?? false;
  const operator =
    sim.bootstrap?.session.role === "OPERATOR" &&
    !sim.sessionExpired &&
    !sim.isFixture;
  const phase =
    snapshot?.phase ?? sim.bootstrap?.activeRun?.phase ?? "CONFIGURING";
  const needsSetup =
    !snapshot || phase === "CONFIGURING" || phase === "STARTING";
  const selected =
    snapshot?.flights.find((f) => f.entityId === selectedId) ??
    snapshot?.airports.find((a) => a.entityId === selectedId);
  useEffect(() => {
    setSelectedId(null);
    setDialog(null);
  }, [snapshot?.runId]);
  useEffect(() => {
    if (snapshot && selectedId && !selected) setSelectedId(null);
  }, [snapshot, selectedId, selected]);
  const select = (id: string) => {
    setSelectedId(id);
    setFleetOpen(false);
  };
  const act = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(
        e instanceof Error
          ? e.message
          : "The action could not complete. Try again.",
      );
    }
  };
  return (
    <div className="simulator" data-mobile-view={mobileView} data-national-map={nationalMap} data-inspector-open={!!selectedId}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="iATC home">
          <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
            <path
              d="M14 3c-1 0-1.5 1.5-1.5 3v5L4 17v2l8.5-3v6l-3 2v1l4.5-1 4.5 1v-1l-3-2v-6l8.5 3v-2l-8.5-6V6C15.5 4.5 15 3 14 3Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <h1>iATC</h1>
        </a>
        <span className={`phase-badge phase-${phase.toLowerCase()}`}>
          {phase.toLowerCase()}
        </span>
        <span className="sim-clock" aria-label="Simulation time">
          {clock(snapshot?.simTimeSec ?? 0)}
          <small>SIM</small>
        </span>
        <div className="toolbar-actions">
          <label className="speed-label">
            Speed
            <select
              aria-label="Run speed"
              value={snapshot?.config.speed ?? 5}
              disabled={!operator || sim.busy || !snapshot || ["STARTING", "RESETTING", "COMPLETED"].includes(phase)}
              onChange={(e) =>
                void act(() =>
                  sim.setSpeed(Number(e.target.value) as 1 | 5 | 10),
                )
              }
            >
              <option value={1}>1×</option>
              <option value={5}>5×</option>
              <option value={10}>10×</option>
            </select>
          </label>
          <button
            disabled={
              !operator || sim.busy || !["RUNNING", "PAUSED"].includes(phase)
            }
            onClick={() =>
              void act(phase === "PAUSED" ? sim.resume : sim.pause)
            }
          >
            {phase === "PAUSED" ? "Resume" : "Pause"}
          </button>
          <button
            disabled={!operator || sim.busy || !snapshot}
            onClick={() => setDialog("reset")}
          >
            Reset
          </button>
          <button
            className="phone-button"
            disabled={!operator || !snapshot || phase === "RESETTING"}
            onClick={() => setDialog("phone")}
          >
            Phone controls
          </button>
        </div>
        <span
          className={`connection connection-${sim.connection}`}
          role="status"
        >
          <span aria-hidden="true" />
          {sim.isFixture
            ? "Preview"
            : sim.connection === "live"
              ? "Connected"
              : sim.connection === "reconnecting"
                ? "Reconnecting"
                : sim.connection === "offline"
                  ? "Offline"
                  : "Connecting"}
        </span>
      </header>
      {sim.isFixture && (
        <div className="app-banner fixture-banner">
          <strong>Development preview</strong>
          <span>Static fixture · No live traffic · Controls disabled</span>
        </div>
      )}
      {(sim.error || actionError) && (
        <div className="app-banner error-banner" role="alert">
          <span>{actionError ?? sim.error}</span>
          <button onClick={() => void act(sim.refresh)}>Reconnect</button>
        </div>
      )}
      {sim.sessionExpired && (
        <div className="app-banner error-banner">
          This session no longer controls the active run. Open a fresh join
          invitation.
        </div>
      )}
      <nav className="mobile-navigation" aria-label="Airspace views">
        <button
          onClick={() => setFleetOpen(!fleetOpen)}
          aria-expanded={fleetOpen}
        >
          Flights & setup
        </button>
        <button
          aria-pressed={mobileView === "map"}
          onClick={() => setMobileView("map")}
        >
          Map
        </button>
        <button
          aria-pressed={mobileView === "list"}
          onClick={() => setMobileView("list")}
        >
          Flight list
        </button>
        <a href="/control">Phone view</a>
      </nav>
      <main className="workspace">
        <aside
          className={`left-panel ${fleetOpen ? "is-open" : ""}`}
          aria-label="Traffic and configuration"
        >
          <button className="drawer-close" onClick={() => setFleetOpen(false)}>
            Close flight list
          </button>
          {needsSetup ? (
            <RunSetup key={snapshot?.runId ?? "setup"} />
          ) : (
            <FlightList
              snapshot={snapshot!}
              selectedId={selectedId}
              onSelect={select}
            />
          )}
        </aside>
        <section className="map-column" aria-label="Live airspace">
          <div className="map-heading">
            <div>
              <h2>{nationalMap ? "United States airspace" : "Regional airspace"}</h2>
              <p>
                {snapshot
                  ? `${snapshot.airports.length} airports · ${snapshot.flights.length} flights`
                  : "Choose your airports · One shared sky"}
              </p>
            </div>
            <span className="mode-label">
              {snapshot?.agentMode === "live"
                ? "Model agents"
                : snapshot
                  ? "Rules agents"
                  : "Awaiting run"}
            </span>
          </div>
          <div className="map-viewport">
            {snapshot ? (
              <AirspaceMap
                snapshot={snapshot}
                selectedId={selectedId}
                onSelect={select}
                stale={
                  sim.connection !== "live" || snapshot.phase !== "RUNNING"
                }
              />
            ) : (
              <div className="map-empty">
                <svg
                  viewBox="0 0 80 60"
                  width="120"
                  height="90"
                  aria-hidden="true"
                >
                  <path
                    d="M14 40 40 15l26 25M14 40h52"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  <circle cx="14" cy="40" r="4" />
                  <circle cx="40" cy="15" r="4" />
                  <circle cx="66" cy="40" r="4" />
                </svg>
                <h2>Ready for traffic</h2>
                <p>Configure a run to bring your airport network online.</p>
              </div>
            )}
          </div>
          <div className="dependency-strip" aria-label="Dependency health">
            {snapshot ? (
              Object.entries(snapshot.health).map(([name, health]) => (
                <span
                  key={name}
                  className={`dependency dep-${health.status.toLowerCase()}`}
                  title={health.detail ?? undefined}
                >
                  <i aria-hidden="true" />
                  {name}
                  <strong>{health.status.toLowerCase()}</strong>
                </span>
              ))
            ) : (
              <span>Dependency health appears with the active run.</span>
            )}
          </div>
          <div className="timeline-slot">
            {snapshot ? (
              <Timeline snapshot={snapshot} selectedId={selectedId} />
            ) : (
              <div className="timeline-placeholder">
                <h2>Coordination feed</h2>
                <p>Agent requests, offers and decisions will appear here.</p>
              </div>
            )}
          </div>
        </section>
        <aside className="right-panel" aria-label="Entity details">
          {nationalMap && selectedId && <button className="inspector-close" aria-label="Close entity details" onClick={() => setSelectedId(null)}>Close details <span aria-hidden="true">×</span></button>}
          {snapshot ? (
            <EntityInspector snapshot={snapshot} selectedId={selectedId}>
              {selected && (
                <>
                  <IncidentControls
                    key={selected.entityId}
                    target={selected}
                    compact
                  />
                </>
              )}
            </EntityInspector>
          ) : (
            <div className="inspector-placeholder">
              <h2>
                Clear decisions.
                <br />
                Visible consequences.
              </h2>
              <p>
                Select an aircraft or airport to inspect its state, create an
                incident, and follow the response.
              </p>
              <dl>
                <dt>Airport incidents</dt>
                <dd>Weather closure, runway closure, reduced capacity.</dd>
                <dt>Flight emergencies</dt>
                <dd>Smoke, engine trouble, low fuel.</dd>
              </dl>
            </div>
          )}
        </aside>
      </main>
      {dialog === "phone" && <PhoneInvite onClose={() => setDialog(null)} />}
      {dialog === "reset" && <ResetDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
