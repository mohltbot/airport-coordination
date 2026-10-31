// Explicitly static design fixture. This module is dynamically imported in development only.
import { samplePublicSnapshot } from '../../../tests/fixtures';
import { createWorld } from '@ghost-tower/domain/world';
import { toPublicAirport, toPublicFlight } from '@ghost-tower/domain/projections';
import { PublicSnapshotSchema, type PublicSnapshot } from '@ghost-tower/domain/public';

const replaceLegacy = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replaceAll('ALP', 'ATL').replaceAll('BRV', 'DFW').replaceAll('CHR', 'DEN').replaceAll('Alpha', 'Atlanta').replaceAll('Bravo', 'Dallas Fort Worth').replaceAll('Charlie', 'Denver');
  if (Array.isArray(value)) return value.map(replaceLegacy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceLegacy(item)]));
  return value;
};
const base = PublicSnapshotSchema.parse(replaceLegacy(samplePublicSnapshot));
const config = { ...base.config, airportNetwork: 'US' as const };
const world = createWorld(config, { runId: base.runId, operationId: 'static-us-preview' });
const airports = world.airports.map((airport, index) => ({
  ...toPublicAirport(airport, base.simTimeSec),
  ...(index === 0 ? { status: 'CLOSED' as const, statusReason: 'Weather closure', runways: base.airports[0]!.runways } : {}),
}));
const flights = world.flights.map((flight, index) => {
  const sample = base.flights[index]!;
  const projected = toPublicFlight(flight, world.airports, base.serverWallTimeMs);
  return {
    ...sample, ...projected,
    priority: sample.priority, deadlineSimSec: sample.deadlineSimSec,
    phase: sample.phase,
    activeAssignment: sample.activeAssignment ? { ...sample.activeAssignment, airportId: flight.originalDestination, reservationId: `preview-${flight.flightId}` } : null,
    proposals: sample.proposals,
    negotiationStage: sample.negotiationStage,
    lastDecisionReason: sample.lastDecisionReason,
    lastDecisionSource: sample.lastDecisionSource,
  };
});
for (const airport of airports) airport.queue = flights.filter(flight => flight.activeAssignment?.airportId === airport.airportId).map(flight => ({
  ...flight.activeAssignment!, flightId: flight.flightId, priority: flight.priority, status: 'CONFIRMED' as const,
}));
export const usPreviewSnapshot: PublicSnapshot = PublicSnapshotSchema.parse({ ...base, config, airports, flights });
