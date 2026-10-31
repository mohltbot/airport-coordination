import { useState } from "react";
import type { PublicSnapshot, TimelineEvent } from "@ghost-tower/domain/public";

const readable = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const threadTitle = (event: TimelineEvent) => /LAND|OFFER|SLOT|NEGOTIAT|CLEARANCE|RESERV/i.test(event.type) ? "Landing negotiation" : /INCIDENT|EMERGENCY|CLOSURE|WEATHER/i.test(event.type) ? "Incident" : "Activity";

export function Communications({ snapshot, selectedId }: { snapshot: PublicSnapshot; selectedId: string }) {
  const [counterpart, setCounterpart] = useState("all");
  const label = (id: string | null) => id === null ? "—" : snapshot.airports.find((airport) => airport.entityId === id)?.airportId ?? snapshot.flights.find((flight) => flight.entityId === id)?.callsign ?? readable(id);
  const events = [...new Map(snapshot.timeline.filter((event) => event.fromEntityId === selectedId || event.toEntityId === selectedId).map((event) => [event.eventId, event])).values()].sort((a, b) => a.wallTimeMs - b.wallTimeMs || a.eventId.localeCompare(b.eventId));
  const counterparts = [...new Set(events.flatMap((event) => [event.fromEntityId, event.toEntityId]).filter((id): id is string => id !== null && id !== selectedId))];
  const effectiveCounterpart = counterparts.includes(counterpart) ? counterpart : "all";
  const visible = events.filter((event) => effectiveCounterpart === "all" || event.fromEntityId === effectiveCounterpart || event.toEntityId === effectiveCounterpart);
  const threads = new Map<string, TimelineEvent[]>();
  for (const event of visible) {
    const key = event.correlationId ? `thread:${event.correlationId}` : `event:${event.eventId}`;
    threads.set(key, [...(threads.get(key) ?? []), event]);
  }
  return <div className="comm-content">
    <div className="comm-intro"><h3>Communications</h3><span>Recent message summaries</span></div>
    <label className="comm-filter">Conversation with
      <select value={effectiveCounterpart} onChange={(event) => setCounterpart(event.target.value)}>
        <option value="all">All counterparts</option>
        {counterparts.map((id) => <option key={id} value={id}>{label(id)}</option>)}
      </select>
    </label>
    {threads.size ? <div className="comm-threads">{[...threads].map(([key, thread]) => <section className="comm-thread" key={key} aria-label={`${threadTitle(thread[0]!)} thread`}>
      <h4>{threadTitle(thread[0]!)}<span>{thread.length} {thread.length === 1 ? "summary" : "summaries"}</span></h4>
      <ol>{thread.map((event) => <li className="comm-message" key={event.eventId}>
        <div className="comm-route"><strong>{label(event.fromEntityId)} <span aria-label="to">→</span> {label(event.toEntityId)}</strong><time dateTime={new Date(event.wallTimeMs).toISOString()}>{new Date(event.wallTimeMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time></div>
        <div className="comm-type">{readable(event.type)}</div>
        <p>{event.summary}</p>
        <div className="comm-meta"><span className={`comm-status comm-status-${event.status.toLowerCase()}`}>{event.status}</span><span>{event.source === "RULES_FALLBACK" ? "Rules fallback" : readable(event.source)}</span></div>
      </li>)}</ol>
    </section>)}</div> : <div className="comm-empty"><h4>{events.length ? "No matching messages" : "Awaiting activity"}</h4><p>{events.length ? "Choose another counterpart to see their message summaries." : "Message summaries involving this entity will appear here as activity is recorded."}</p></div>}
  </div>;
}
