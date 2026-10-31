import type { PublicSnapshot } from '@ghost-tower/domain/public';
// Optional backend metadata; no client-created scenario state.
export function demoConfig(snapshot: PublicSnapshot) {
  const config = snapshot.config;
  const featured = snapshot.flights.find(f => f.flightId === config.featuredFlightId || f.entityId === config.featuredFlightId);
  return { bayArea: config.focusRegion === 'BAY_AREA', featured };
}
