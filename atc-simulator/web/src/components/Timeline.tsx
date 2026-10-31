import { useState } from "react";
import type { PublicSnapshot } from "@ghost-tower/domain/public";
import "./display.css";
export function Timeline({
  snapshot,
  selectedId,
}: {
  snapshot: PublicSnapshot;
  selectedId: string | null;
}) {
  const [scope, setScope] = useState("all");
  const events = snapshot.timeline
    .slice(-200)
    .filter(
      (e) =>
        scope === "all" ||
        !selectedId ||
        e.fromEntityId === selectedId ||
        e.toEntityId === selectedId,
    );
  return (
    <section className="timeline-panel" aria-label="Activity timeline">
      <header className="timeline-header">
        <h2>Activity</h2>
        <label>
          Events
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All entities</option>
            <option value="selection" disabled={!selectedId}>
              Selected entity
            </option>
          </select>
        </label>
        <span>{events.length} / 200 latest</span>
      </header>
      <div
        className="timeline-scroll"
        tabIndex={0}
        aria-label="Scrollable event history"
      >
        <ol className="timeline-events">
          {events.map((e) => (
            <li
              key={e.eventId}
              className={`timeline-event timeline-${e.status.toLowerCase()}`}
            >
              <time>
                {Math.floor(e.simTimeSec / 60)
                  .toString()
                  .padStart(2, "0")}
                :
                {Math.floor(e.simTimeSec % 60)
                  .toString()
                  .padStart(2, "0")}
              </time>
              <span className="timeline-route">
                {e.fromEntityId.replace("airport:", "").replace("flight:", "")}
                {e.toEntityId
                  ? ` → ${e.toEntityId.replace("airport:", "").replace("flight:", "")}`
                  : ""}
              </span>
              <p>{e.summary}</p>
              <span className="timeline-source">
                {e.source === "RULES_FALLBACK"
                  ? "Rules fallback"
                  : e.source.toLowerCase()}
              </span>
              <span className="timeline-status">{e.status.toLowerCase()}</span>
            </li>
          ))}
        </ol>
        {!events.length && (
          <p className="timeline-empty">
            No activity recorded
            {scope === "selection" ? " for this entity" : ""}.
          </p>
        )}
      </div>
    </section>
  );
}
