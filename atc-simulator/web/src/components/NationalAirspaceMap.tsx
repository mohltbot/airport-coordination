import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { PublicSnapshot } from "@ghost-tower/domain/public";
import { US_AIRPORTS, US_STATES, projectUs } from "../lib/us-geography";
import "./national-map.css";
import { demoConfig } from "../lib/demo-config";

type Props = { snapshot: PublicSnapshot; selectedId: string | null; onSelect: (id: string) => void; stale: boolean };
type Point = { x: number; y: number };
type Label = { id: string; x: number; y: number; width: number; height: number; point: Point; title: string; airport: boolean; emergency: boolean };

export function NationalAirspaceMap({ snapshot, selectedId, onSelect, stale }: Props) {
  const { bayArea, newYork, featured } = demoConfig(snapshot);
  const svgRef = useRef<SVGSVGElement>(null);
  const previous = useRef(snapshot);
  const [zoom, setZoom] = useState(1);
  const [regionName, setRegionName] = useState("network");
  const [viewCenter, setViewCenter] = useState<Point | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; center: Point; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => { setZoom(bayArea ? 3.5 : newYork ? 3.5 : 1); setViewCenter(bayArea ? projectUs(-122.0, 37.2) : newYork ? projectUs(-74.0, 40.7) : null); setRegionName(bayArea ? "bay" : newYork ? "northeast" : "network"); }, [snapshot.runId, bayArea, newYork]);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [positions, setPositions] = useState<Record<string, Point>>(() => Object.fromEntries(snapshot.flights.map(f => [f.entityId, f.position])));
  useEffect(() => {
    if (!svgRef.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(svgRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const from = previous.current;
    previous.current = snapshot;
    let frame = 0;
    const start = performance.now();
    const immediate = stale || snapshot.phase !== "RUNNING" || from.runId !== snapshot.runId || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const update = (now: number) => {
      const progress = immediate ? 1 : Math.min(1, (now - start) / 250);
      setPositions(Object.fromEntries(snapshot.flights.map(f => {
        const p = from.flights.find(old => old.entityId === f.entityId)?.position ?? f.position;
        return [f.entityId, { x: p.x + (f.position.x - p.x) * progress, y: p.y + (f.position.y - p.y) * progress }];
      })));
      if (progress < 1) frame = requestAnimationFrame(update);
    };
    update(start);
    return () => cancelAnimationFrame(frame);
  }, [snapshot, stale]);
  // Include off-map aircraft in the initial fit. Zoom is a deliberate user action.
  const points = snapshot.flights.map(f => f.position);
  const minX = Math.min(0, ...points.map(p => p.x - 14));
  const minY = Math.min(0, ...points.map(p => p.y - 14));
  const maxX = Math.max(240, ...points.map(p => p.x + 14));
  const maxY = Math.max(160, ...points.map(p => p.y + 14));
  const width = (maxX - minX) / zoom, height = (maxY - minY) / zoom;
  const selectedPoint = snapshot.airports.find(a => a.entityId === selectedId)?.position
    ?? snapshot.flights.find(f => f.entityId === selectedId)?.position;
  const center = viewCenter ?? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const boundCenter = (point: Point) => ({ x: Math.max(minX, Math.min(maxX, point.x)), y: Math.max(minY, Math.min(maxY, point.y)) });
  const changeZoom = (amount: number) => {
    setRegionName("custom");
    setViewCenter(viewCenter ?? selectedPoint ?? center);
    setZoom(v => Math.max(1, Math.min(20, v + amount)));
  };
  const fit = () => { setZoom(1); setViewCenter(null); setRegionName("network"); };
  const region = (name: string) => {
    if (name === "network") { fit(); return; }
    const target = name === "bay" ? { lon: -122.0, lat: 37.2, zoom: 3.5 } : name === "northeast" ? { lon: -74.0, lat: 40.7, zoom: 3.5 } : { lon: -115, lat: 34, zoom: 3 };
    setRegionName(name); setViewCenter(projectUs(target.lon, target.lat)); setZoom(target.zoom);
  };
  const select = (id: string) => { if (!suppressClick.current) onSelect(id); };
  const visible = (point: Point) => point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
  const x = center.x - width / 2, y = center.y - height / 2;
  const unit = 1 / Math.max(.3, Math.min(size.width / width, size.height / height));
  // Aircraft hit rings overlap at regional zoom; the marker nearest the pointer wins.
  const nearestFlight = (e: MouseEvent<SVGGElement>, fallback: string) => {
    const ctm = (e.currentTarget.ownerSVGElement ?? null)?.getScreenCTM();
    if (!ctm || (e.clientX === 0 && e.clientY === 0)) return fallback;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    let best = fallback, bestDistance = Infinity;
    for (const f of snapshot.flights) { const p = positions[f.entityId] ?? f.position; const d = Math.hypot(p.x - pt.x, p.y - pt.y); if (d < bestDistance) { bestDistance = d; best = f.entityId; } }
    return bestDistance <= 16 * unit ? best : fallback;
  };
  const keySelect = (e: KeyboardEvent, id: string) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(id); } };
  const selectedFlight = snapshot.flights.find(f => f.entityId === selectedId);
  const [airportTextWidths, setAirportTextWidths] = useState<Record<string, number>>({});
  const labels: Label[] = [];
  const entries = [
    ...snapshot.airports.map(a => ({ id: a.entityId, point: a.position, title: a.airportId, airport: true, emergency: false })),
    ...[...snapshot.flights].sort((a,b) => Number(b.entityId === selectedId) - Number(a.entityId === selectedId) || Number(b.priority === "EMERGENCY") - Number(a.priority === "EMERGENCY")).map(f => ({ id: f.entityId, point: positions[f.entityId] ?? f.position, title: f.callsign, airport: false, emergency: f.priority === "EMERGENCY" })),
  ];
  const markerPoints = entries.map(e => e.point);
  for (const entry of entries) {
    if (!visible(entry.point) || (!entry.airport && zoom < 2)) continue;
    const w = (entry.airport ? (airportTextWidths[entry.title] ?? entry.title.length * 9) + 20 : entry.title.length * 7.5 + 14) * unit;
    const h = 24 * unit;
    const candidates: Point[] = [];
    if (entry.airport) candidates.push({ x: entry.point.x - w / 2, y: entry.point.y - h - 14 * unit });
    for (const radius of [14, 34, 58, 82, 112]) for (const [dx,dy] of [[1,-1],[1,1],[-1,-1],[-1,1],[0,-1],[0,1]]) candidates.push({ x: Math.max(x + 3*unit, Math.min(x+width-w-3*unit, entry.point.x + dx!*radius*unit - (dx === -1 ? w : dx === 0 ? w/2 : 0))), y: Math.max(y+3*unit, Math.min(y+height-h-3*unit, entry.point.y + dy!*radius*unit - (dy === -1 ? h : 0))) });
    const place = candidates.find(c => !labels.some(l => c.x < l.x+l.width+4*unit && c.x+w+4*unit > l.x && c.y < l.y+l.height+4*unit && c.y+h+4*unit > l.y) && !markerPoints.some(p => p.x > c.x-6*unit && p.x < c.x+w+6*unit && p.y > c.y-6*unit && p.y < c.y+h+6*unit));
    if (place) labels.push({ ...entry, ...place, width: w, height: h });
  }
  useLayoutEffect(() => {
    const widths: Record<string, number> = {};
    svgRef.current?.querySelectorAll<SVGTextElement>('.national-label.is-airport text').forEach(text => {
      widths[text.textContent ?? ''] = text.getComputedTextLength() / unit;
    });
    setAirportTextWidths(previous => Object.entries(widths).some(([code, value]) => Math.abs((previous[code] ?? 0) - value) > .25) ? { ...previous, ...widths } : previous);
  });
  return <section className="map-panel national-map" aria-label="United States airspace map">
    <div className="national-map-heading"><div><h2>National network</h2><p>{stale ? "Position updates stopped" : "Contiguous United States"} <span>· Compressed simulation scale</span></p></div><div className="national-map-tools"><label className="national-region"><span className="national-sr-only">Map region</span><select aria-label="Map region" value={regionName} onChange={e => region(e.target.value)}><option value="custom" disabled>Custom view</option><option value="network">US network</option><option value="bay">Bay Area</option><option value="northeast">New York · Northeast</option><option value="southwest">Southwest</option></select></label><div className="national-map-zoom" role="group" aria-label="Map zoom"><button aria-label="Zoom out" disabled={zoom <= 1} onClick={() => changeZoom(-Math.max(.5,zoom*.35))}>−</button><button onClick={fit} aria-label="Reset map view">Fit</button><button aria-label="Zoom in" disabled={zoom >= 20} onClick={() => changeZoom(Math.max(.5,zoom*.5))}>+</button></div></div></div>
    <svg ref={svgRef} className="national-map-svg" tabIndex={0}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        const offsets: Record<string, Point> = { ArrowLeft: {x:-width*.12,y:0}, ArrowRight:{x:width*.12,y:0}, ArrowUp:{x:0,y:-height*.12}, ArrowDown:{x:0,y:height*.12} };
        if (offsets[e.key]) { e.preventDefault(); setRegionName("custom"); const d = offsets[e.key]!; setViewCenter(boundCenter({x:center.x+d.x,y:center.y+d.y})); }
        else if (e.key === "+" || e.key === "=") { e.preventDefault(); changeZoom(Math.max(.5,zoom*.5)); }
        else if (e.key === "-") { e.preventDefault(); changeZoom(-Math.max(.5,zoom*.35)); }
        else if (e.key === "Home") { e.preventDefault(); fit(); }
      }}
      onPointerDown={e => {
        if (e.button !== 0) return;
        suppressClick.current = false;
        drag.current = { pointerId:e.pointerId,x:e.clientX,y:e.clientY,center,moved:false };
      }}
      onPointerMove={e => {
        const active = drag.current; if (!active || active.pointerId !== e.pointerId) return;
        const dx=e.clientX-active.x, dy=e.clientY-active.y;
        if (!active.moved && Math.hypot(dx,dy) < 5) return;
        active.moved=true; suppressClick.current=true; setRegionName("custom");
        e.currentTarget.setPointerCapture(e.pointerId);
        setViewCenter(boundCenter({x:active.center.x-dx*unit,y:active.center.y-dy*unit}));
      }}
      onPointerUp={e => { if (drag.current?.pointerId === e.pointerId) { drag.current=null; if(e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); } }}
      onPointerCancel={() => { drag.current=null; }}
      viewBox={`${x} ${y} ${width} ${height}`} role="img" aria-label="Map of the contiguous United States. Drag to pan. Arrow keys pan, plus and minus zoom, Home fits the network. Select an airport or aircraft for communications and details.">
      <g className="national-states" aria-hidden="true">{US_STATES.map(state => <path key={state.name} d={state.path} vectorEffect="non-scaling-stroke" />)}</g>
      <g className="national-place-labels" aria-hidden="true">{[{ name: "Pacific Ocean", lon: -126, lat: 35 }, { name: "Gulf of Mexico", lon: -91, lat: 25 }, { name: "Atlantic Ocean", lon: -70, lat: 34 }].map(place => { const p = projectUs(place.lon,place.lat); return <text key={place.name} x={p.x} y={p.y} style={{fontSize: 12*unit}}>{place.name}</text>; })}</g>
      <g className="national-routes">{snapshot.flights.map(f => { const a = snapshot.airports.find(a => a.airportId === f.activeAssignment?.airportId); if (!a || ["LANDED","UNRESOLVED"].includes(f.phase)) return null; const p = positions[f.entityId] ?? f.position; return <line key={f.entityId} className={`national-assignment ${selectedId === f.entityId || selectedId === a.entityId ? "is-selected" : ""}`} data-flight-id={f.flightId} data-airport-id={a.airportId} x1={p.x} y1={p.y} x2={a.position.x} y2={a.position.y} vectorEffect="non-scaling-stroke"><title>{f.callsign} → {a.airportId}: assigned destination</title></line>; })}{selectedFlight?.proposals.map(offer => { const a = snapshot.airports.find(a => a.airportId === offer.airportId); const p = positions[selectedFlight.entityId] ?? selectedFlight.position; return a && <line key={offer.offerId} className="national-offer" x1={p.x} y1={p.y} x2={a.position.x} y2={a.position.y} vectorEffect="non-scaling-stroke"><title>{a.airportId}: unconfirmed offer</title></line>; })}</g>
      {snapshot.airports.map(a => { const known = US_AIRPORTS.find(k => String(k.airportId) === String(a.airportId))!; return <g key={a.entityId} role="button" tabIndex={0} aria-label={`${a.airportId}, ${known.name}, ${a.status}, queue ${a.queue.length}`} className={`national-airport status-${a.status.toLowerCase()} ${a.entityId === selectedId || selectedFlight?.activeAssignment?.airportId === a.airportId ? "is-selected" : ""}`} transform={`translate(${a.position.x} ${a.position.y}) scale(${unit})`} onClick={() => select(a.entityId)} onKeyDown={e => keySelect(e,a.entityId)}><title>{known.name} · {known.city} · {a.status}</title><circle className="national-hit" r="22"/><circle className="national-airport-outer" r="9"/><circle className="national-airport-inner" r="4"/><path className="national-airport-runway" d={a.status === "CLOSED" ? "M-3-3 3 3M-3 3 3-3" : "M-1.5-3v6M1.5-3v6"}/></g>; })}
      {snapshot.flights.map(f => { const p = positions[f.entityId] ?? f.position; return <g key={f.entityId} role="button" tabIndex={0} aria-label={`${f.callsign}, ${f.phase}, ${f.priority}`} className={`national-aircraft ${f.priority === "EMERGENCY" ? "is-emergency" : ""} ${f.entityId === selectedId ? "is-selected" : ""} ${f.phase === "LANDED" ? "is-landed" : ""}`} transform={`translate(${p.x} ${p.y}) scale(${unit})`} onClick={e => select(nearestFlight(e, f.entityId))} onKeyDown={e => keySelect(e,f.entityId)}><title>{f.callsign} · {f.phase}</title><circle className="national-hit" r="14"/><path className="national-plane" d="M0-8 5.5 6 0 3-5.5 6Z" transform={`rotate(${f.headingDeg})`}/></g>; })}
      {labels.map(l => <g key={`label-${l.id}`} className={`national-label ${l.airport ? "is-airport" : ""} ${l.id === selectedId ? "is-selected" : ""} ${l.emergency ? "is-emergency" : ""} ${l.id === featured?.entityId ? "is-featured" : ""}`} role="button" tabIndex={0} aria-label={`Select ${l.title}`} onClick={() => select(l.id)} onKeyDown={e => keySelect(e,l.id)}><line x1={l.point.x} y1={l.point.y} x2={Math.max(l.x,Math.min(l.x+l.width,l.point.x))} y2={Math.max(l.y,Math.min(l.y+l.height,l.point.y))} vectorEffect="non-scaling-stroke"/><rect x={l.x} y={l.y} width={l.width} height={l.height} rx={5*unit} vectorEffect="non-scaling-stroke"/><text textAnchor={l.airport ? "middle" : "start"} x={l.airport ? l.x+l.width/2 : l.x+7*unit} y={l.y+16*unit} style={{fontSize: (l.airport ? 14 : 12)*unit}}>{l.title}</text></g>)}
    </svg>
    <div className="national-map-footer"><span><svg width="26" height="12" aria-hidden="true"><line className="national-assignment is-selected" x1="1" x2="25" y1="6" y2="6"/></svg>Assigned destination</span><span><svg width="26" height="12" aria-hidden="true"><line className="national-offer" x1="1" x2="25" y1="6" y2="6"/></svg>Unconfirmed offer</span><span className="national-scale">Geography: U.S. Census Bureau</span></div>
    {!snapshot.airports.some(a => visible(a.position)) && <p className="national-map-empty">No active towers in this view.</p>}
    {snapshot.flights.length === 0 && zoom === 1 && <p className="national-map-empty">No aircraft in this run.</p>}
  </section>;
}
