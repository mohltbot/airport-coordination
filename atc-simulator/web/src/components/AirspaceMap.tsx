import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PublicSnapshot } from "@ghost-tower/domain/public";
import "./display.css";
type Label = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: { x: number; y: number };
  lines: string[];
  airport: boolean;
  urgent: boolean;
};
type Props = {
  snapshot: PublicSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  stale: boolean;
};
export function AirspaceMap({ snapshot, selectedId, onSelect, stale }: Props) {
  const previous = useRef(snapshot);
  const svgRef = useRef<SVGSVGElement>(null);
  const [scale, setScale] = useState(2.5);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setScale(
          Math.max(
            0.5,
            Math.min(
              entry.contentRect.width / 240,
              entry.contentRect.height / 160,
            ),
          ),
        );
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const [wallElapsed, setWallElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    setWallElapsed(0);
    const timer = setInterval(() => setWallElapsed(Date.now() - start), 250);
    return () => clearInterval(timer);
  }, [snapshot.serverWallTimeMs]);
  const [positions, setPositions] = useState(() =>
    Object.fromEntries(snapshot.flights.map((f) => [f.entityId, f.position])),
  );
  useEffect(() => {
    const from = previous.current;
    previous.current = snapshot;
    const snap = () =>
      setPositions(
        Object.fromEntries(
          snapshot.flights.map((f) => [f.entityId, f.position]),
        ),
      );
    if (
      stale ||
      snapshot.phase !== "RUNNING" ||
      from.runId !== snapshot.runId ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      snap();
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 250);
      setPositions(
        Object.fromEntries(
          snapshot.flights.map((f) => {
            const p =
              from.flights.find((v) => v.entityId === f.entityId)?.position ??
              f.position;
            return [
              f.entityId,
              {
                x: p.x + (f.position.x - p.x) * t,
                y: p.y + (f.position.y - p.y) * t,
              },
            ];
          }),
        ),
      );
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [snapshot, stale]);
  const selected = snapshot.flights.find((f) => f.entityId === selectedId);
  const selectKey = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };
  const revocations = snapshot.timeline.filter(
    (e) =>
      e.type === "RESERVATION_REVOKED" &&
      (e.toEntityId === selectedId || e.fromEntityId === selectedId) &&
      snapshot.serverWallTimeMs + wallElapsed - e.wallTimeMs < 3000,
  );
  const unit = 1 / scale;
  const labels: Label[] = [];
  const markers = [
    ...snapshot.airports.map((a) => a.position),
    ...snapshot.flights.map((f) => positions[f.entityId] ?? f.position),
  ];
  const items = [
    ...snapshot.airports.map((a) => ({
      id: a.entityId,
      anchor: a.position,
      lines: [a.airportId, `${a.status} · Q ${a.queue.length}`],
      airport: true,
      urgent: false,
    })),
    ...[...snapshot.flights]
      .sort(
        (a, b) =>
          Number(b.entityId === selectedId) -
            Number(a.entityId === selectedId) ||
          Number(b.priority === "EMERGENCY") -
            Number(a.priority === "EMERGENCY") ||
          a.callsign.localeCompare(b.callsign),
      )
      .map((f) => ({
        id: f.entityId,
        anchor: positions[f.entityId] ?? f.position,
        lines: [`${f.callsign}${f.priority === "EMERGENCY" ? " !" : ""}`],
        airport: false,
        urgent: f.priority === "EMERGENCY" || f.entityId === selectedId,
      })),
  ];
  for (const item of items) {
    const width =
      (Math.max(...item.lines.map((line) => line.length)) * 7.2 + 12) * unit;
    const height = (item.airport ? 38 : 24) * unit;
    const candidates: { x: number; y: number }[] = [];
    for (const radius of [12, 36, 62, 90, 126]) {
      for (const [dx, dy] of [
        [1, -1],
        [1, 1],
        [-1, -1],
        [-1, 1],
        [0, -1],
        [0, 1],
      ]) {
        candidates.push({
          x: Math.max(
            2,
            Math.min(
              238 - width,
              item.anchor.x +
                dx! * radius * unit -
                (dx === -1 ? width : dx === 0 ? width / 2 : 0),
            ),
          ),
          y: Math.max(
            2,
            Math.min(
              158 - height,
              item.anchor.y + dy! * radius * unit - (dy === -1 ? height : 0),
            ),
          ),
        });
      }
    }
    const clear = (c: { x: number; y: number }) =>
      !labels.some(
        (l) =>
          c.x < l.x + l.width + 3 * unit &&
          c.x + width + 3 * unit > l.x &&
          c.y < l.y + l.height + 3 * unit &&
          c.y + height + 3 * unit > l.y,
      ) &&
      !markers.some(
        (m) =>
          m.x > c.x - 3 * unit &&
          m.x < c.x + width + 3 * unit &&
          m.y > c.y - 3 * unit &&
          m.y < c.y + height + 3 * unit,
      );
    let place = candidates.find(clear);
    if (
      !place &&
      (snapshot.flights.length <= 10 || item.airport || item.urgent)
    ) {
      const fallback = [];
      for (let y = 2; y < 158 - height; y += height + 4 * unit)
        for (let x = 2; x < 238 - width; x += width + 4 * unit)
          fallback.push({ x, y });
      place = fallback
        .sort(
          (a, b) =>
            Math.hypot(a.x - item.anchor.x, a.y - item.anchor.y) -
            Math.hypot(b.x - item.anchor.x, b.y - item.anchor.y),
        )
        .find(clear);
    }
    if (place) labels.push({ ...item, ...place, width, height });
  }
  return (
    <section className="map-panel" aria-label="Airspace map">
      <div className="map-caption">
        <span>
          N ↑ · 240 × 160 NM {stale ? "· Position updates stopped" : ""}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="map-svg"
        viewBox="0 0 240 160"
        role="img"
        aria-label="North-up airspace. Select an airport or aircraft for details."
      >
        <defs>
          <pattern
            id="airport-closed-hatch"
            width="3"
            height="3"
            patternUnits="userSpaceOnUse"
          >
            <path d="M0 3L3 0" stroke="var(--red)" strokeWidth=".65" />
          </pattern>
          <pattern
            id="airspace-grid"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M20 0H0V20"
              fill="none"
              stroke="var(--border)"
              strokeWidth=".25"
            />
          </pattern>
        </defs>
        <rect width="240" height="160" fill="url(#airspace-grid)" />
        {selected && (
          <g className="map-routes">
            {selected.proposals.map((p) => {
              const a = snapshot.airports.find(
                (a) => a.airportId === p.airportId,
              );
              return (
                a && (
                  <line
                    key={p.offerId}
                    className="map-proposal"
                    x1={positions[selected.entityId]?.x ?? selected.position.x}
                    y1={positions[selected.entityId]?.y ?? selected.position.y}
                    x2={a.position.x}
                    y2={a.position.y}
                  />
                )
              );
            })}
            {selected.activeAssignment &&
              (() => {
                const a = snapshot.airports.find(
                  (a) => a.airportId === selected.activeAssignment?.airportId,
                );
                return (
                  a && (
                    <line
                      className="map-confirmed"
                      x1={
                        positions[selected.entityId]?.x ?? selected.position.x
                      }
                      y1={
                        positions[selected.entityId]?.y ?? selected.position.y
                      }
                      x2={a.position.x}
                      y2={a.position.y}
                    />
                  )
                );
              })()}
            {revocations.map((e) => {
              const airportId = [e.fromEntityId, e.toEntityId].find((id) =>
                id?.startsWith("airport:"),
              );
              const a = snapshot.airports.find((a) => a.entityId === airportId);
              if (!a) return null;
              const x = (a.position.x + selected.position.x) / 2,
                y = (a.position.y + selected.position.y) / 2;
              return (
                <g key={e.eventId} className="map-revoked">
                  <line
                    x1={selected.position.x}
                    y1={selected.position.y}
                    x2={a.position.x}
                    y2={a.position.y}
                  />
                  <path d={`M${x - 2} ${y - 2}l4 4m-4 0l4-4`} />
                </g>
              );
            })}
          </g>
        )}
        {snapshot.airports.map((a) => (
          <g
            key={a.entityId}
            className={`map-airport ${a.entityId === selectedId ? "map-selected" : ""}`}
            transform={`translate(${a.position.x} ${a.position.y})`}
            role="button"
            tabIndex={0}
            aria-label={`${a.airportId}, ${a.status}, queue ${a.queue.length}`}
            onClick={() => onSelect(a.entityId)}
            onKeyDown={(e) => selectKey(e, a.entityId)}
          >
            <rect
              className="map-hit"
              x={-22 * unit}
              y={-22 * unit}
              width={44 * unit}
              height={44 * unit}
            />
            <rect
              x="-3.5"
              y="-3.5"
              width="7"
              height="7"
              fill={
                a.status === "CLOSED"
                  ? "url(#airport-closed-hatch)"
                  : "var(--panel)"
              }
              stroke={
                a.status === "OPEN"
                  ? "var(--green)"
                  : a.status === "CLOSED"
                    ? "var(--red)"
                    : "var(--amber)"
              }
              strokeWidth=".8"
            />
          </g>
        ))}
        {snapshot.flights.map((f) => {
          const p = positions[f.entityId] ?? f.position;
          return (
            <g
              key={f.entityId}
              className={`map-flight ${f.priority === "EMERGENCY" ? "map-emergency" : ""} ${selectedId === f.entityId ? "map-selected" : ""} ${f.phase === "LANDED" ? "map-landed" : ""}`}
              transform={`translate(${p.x} ${p.y})`}
              tabIndex={0}
              role="button"
              aria-label={`${f.callsign}, ${f.phase}, ${f.priority}`}
              onClick={() => onSelect(f.entityId)}
              onKeyDown={(e) => selectKey(e, f.entityId)}
            >
              <circle className="map-hit" r={22 * unit} />
              <path
                d="M0 -2.8L2 2L0 1.1L-2 2Z"
                transform={`rotate(${f.headingDeg})`}
              />
            </g>
          );
        })}
        {labels.map((l) => (
          <g
            key={`label-${l.id}`}
            className={`map-label ${l.airport ? "map-label-airport" : ""} ${l.urgent ? "map-label-urgent" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`Select ${l.lines.join(", ")}`}
            onClick={() => onSelect(l.id)}
            onKeyDown={(e) => selectKey(e, l.id)}
          >
            <line
              className="map-leader"
              x1={l.anchor.x}
              y1={l.anchor.y}
              x2={Math.max(l.x, Math.min(l.x + l.width, l.anchor.x))}
              y2={Math.max(l.y, Math.min(l.y + l.height, l.anchor.y))}
            />
            <rect
              x={l.x}
              y={l.y}
              width={l.width}
              height={l.height}
              rx={2 * unit}
            />
            {l.lines.map((line, i) => (
              <text
                key={line}
                x={l.x + 6 * unit}
                y={l.y + (i ? 29 : l.airport ? 14 : 16) * unit}
                style={{
                  fontSize: (l.airport && i === 0 ? 14 : 12) * unit,
                  strokeWidth: 0,
                }}
              >
                {line}
              </text>
            ))}
          </g>
        ))}
      </svg>
      <div className="map-legend">
        <span>━ Confirmed</span>
        <span>┄ Proposal</span>
        <span>⊠ Closed</span>
        <span>▲ Aircraft</span>
      </div>
    </section>
  );
}
