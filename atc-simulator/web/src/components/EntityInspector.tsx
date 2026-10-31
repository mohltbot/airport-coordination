import { useEffect, useState, type ReactNode } from "react";
import type { PublicSnapshot } from "@ghost-tower/domain/public";
import "./display.css";
import { Communications } from "./Communications";
import "./communications.css";
const clock = (sec: number) =>
  `${Math.floor(Math.max(0, sec) / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(Math.max(0, sec) % 60)
    .toString()
    .padStart(2, "0")}`;
export function EntityInspector({
  snapshot,
  selectedId,
  children,
}: {
  snapshot: PublicSnapshot;
  selectedId: string | null;
  children?: ReactNode;
}) {
  const [tab, setTab] = useState("Communications");
  useEffect(() => setTab("Communications"), [selectedId]);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(timer);
  }, [snapshot.serverWallTimeMs]);
  const wallNow = snapshot.serverWallTimeMs + elapsed;
  const airport = snapshot.airports.find((a) => a.entityId === selectedId);
  const flight = snapshot.flights.find((f) => f.entityId === selectedId);
  if (!airport && !flight)
    return (
      <aside className="inspector-panel">
        <h2>Entity inspector</h2>
        <div className="inspector-empty">
          <h3>Select an aircraft or airport</h3>
          <p>
            Inspect operational state, confirmed commitments and agent
            decisions.
          </p>
        </div>
      </aside>
    );
  return (
    <aside className="inspector-panel" aria-label="Entity inspector">
      <header className="inspector-header">
        <h2>{airport?.airportId ?? flight?.callsign}</h2>
        <p>{airport?.name ?? flight?.flightId}</p>
      </header>
      <div className="comm-tabs" role="tablist" aria-label="Entity details">
        {["Communications", "State", "Controls"].map((name, index, tabs) => (
          <button key={name} id={`entity-tab-${name}`} role="tab" aria-selected={tab === name}
            aria-controls={`entity-panel-${name}`} tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)} onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
              if (next) { event.preventDefault(); setTab(next); document.getElementById(`entity-tab-${next}`)?.focus(); }
            }}>{name}</button>
        ))}
      </div>
      <section role="tabpanel" id={`entity-panel-${tab}`} aria-labelledby={`entity-tab-${tab}`} className="comm-panel">
      {tab === "Communications" && <Communications key={selectedId} snapshot={snapshot} selectedId={selectedId!} />}
      {tab === "State" && <>
      {airport && (
        <>
          <div className="inspector-status">{airport.status}</div>
          {airport.statusReason && <p>{airport.statusReason}</p>}
          <h3>Runways</h3>
          <ul className="inspector-runways">
            {airport.runways.map((r) => (
              <li key={r.runwayId}>
                <strong>{r.runwayId}</strong>
                <span>{r.status}</span>
                {r.occupiedUntilSimSec !== null && (
                  <small>Until {clock(r.occupiedUntilSimSec)} sim</small>
                )}
              </li>
            ))}
          </ul>
          <h3>
            Arrival queue <span>({airport.queue.length})</span>
          </h3>
          {airport.queue.length ? (
            <ol className="inspector-queue">
              {airport.queue.map((q) => (
                <li key={q.reservationId}>
                  <strong>
                    {snapshot.flights.find((f) => f.flightId === q.flightId)
                      ?.callsign ?? q.flightId}
                  </strong>
                  <span>
                    {q.runwayId} · {clock(q.slotStartSimSec)} sim
                  </span>
                  <small>
                    {q.priority === "EMERGENCY" ? "! Emergency · " : ""}
                    {q.status}
                  </small>
                </li>
              ))}
            </ol>
          ) : (
            <p className="inspector-muted">No queued arrivals.</p>
          )}
        </>
      )}
      {flight && (
        <>
          <div
            className={`inspector-status ${flight.priority === "EMERGENCY" ? "inspector-emergency" : ""}`}
          >
            {flight.phase}{" "}
            {flight.priority === "EMERGENCY" ? "· ! EMERGENCY" : ""}
          </div>
          <dl className="inspector-facts">
            {flight.originAirportId && <div><dt>Departed from</dt><dd>{snapshot.airports.find((airport) => airport.airportId === flight.originAirportId)?.name ?? flight.originAirportId}</dd></div>}
            <div>
              <dt>Fuel remaining</dt>
              <dd>{clock(flight.fuelRemainingSec)} sim</dd>
            </div>
            <div>
              <dt>Original destination</dt>
              <dd>{flight.originalDestination}</dd>
            </div>
            <div>
              <dt>Heading / speed</dt>
              <dd>
                {Math.round(flight.headingDeg)}° /{" "}
                {Math.round(flight.speedKnots)} kt
              </dd>
            </div>
            {flight.deadlineSimSec !== null && (
              <div>
                <dt>Emergency deadline</dt>
                <dd>
                  {clock(flight.deadlineSimSec)} sim (
                  {clock(flight.deadlineSimSec - snapshot.simTimeSec)} left)
                </dd>
              </div>
            )}
          </dl>
          <h3>Commitment</h3>
          {flight.activeAssignment ? (
            <div className="inspector-commitment">
              <strong>
                {flight.activeAssignment.airportId} ·{" "}
                {flight.activeAssignment.runwayId}
              </strong>
              <span>
                Confirmed · {clock(flight.activeAssignment.slotStartSimSec)} sim
              </span>
              <small>
                {flight.activeAssignment.clearanceId
                  ? "Landing clearance granted"
                  : "Awaiting landing clearance"}
              </small>
            </div>
          ) : (
            <p className="inspector-muted">No confirmed assignment.</p>
          )}
          {flight.negotiationStage && (
            <p className="inspector-muted">
              Negotiation: {flight.negotiationStage.replaceAll("_", " ")}
            </p>
          )}
          {flight.lastDecisionReason && (
            <div className="inspector-decision">
              <span className="inspector-source">
                {flight.lastDecisionSource === "MODEL"
                  ? "Model decision"
                  : flight.lastDecisionSource === "RULES_FALLBACK"
                    ? "Rules fallback"
                    : "Decision"}
              </span>
              <p>{flight.lastDecisionReason}</p>
            </div>
          )}
          {flight.unresolvedReason && (
            <p className="inspector-emergency">
              Unresolved: {flight.unresolvedReason}
            </p>
          )}
          {flight.proposals.length > 0 && (
            <>
              <h3>Proposals · unconfirmed</h3>
              <ul className="inspector-proposals">
                {flight.proposals.map((p) => (
                  <li key={p.offerId}>
                    <strong>
                      {p.airportId} · {p.runwayId}
                    </strong>
                    <span>{clock(p.slotStartSimSec)} sim</span>
                    <small>
                      {p.expiresAtWallMs > wallNow
                        ? `${Math.ceil((p.expiresAtWallMs - wallNow) / 1000)}s offer validity`
                        : "Validity elapsed · awaiting agent update"}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      </>}
      {tab === "Controls" && (children ?? <p className="inspector-muted">No controls available for this entity.</p>)}
      </section>
    </aside>
  );
}
