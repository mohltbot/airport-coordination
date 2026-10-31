import { test, expect } from '@playwright/test';
import { bootstrap, fixture, harness } from './harness';

test('communications scope, thread grouping, counterpart filtering and full recent history', async ({ page }) => {
  const snapshot = fixture();
  const flight = snapshot.flights[0]!, airport = snapshot.airports[0]!;
  const other = snapshot.airports[1]!;
  snapshot.timeline = Array.from({ length: 16 }, (_, index) => ({ eventId: `message-${index}`, simTimeSec: index, wallTimeMs: snapshot.serverWallTimeMs + index, fromEntityId: flight.entityId, toEntityId: airport.entityId, type: 'LANDING_REQUEST', summary: `Recorded summary ${index}`, status: 'PENDING' as const, source: 'MODEL' as const, correlationId: 'round-one' }));
  snapshot.timeline.push({ ...snapshot.timeline[0]!, eventId: 'other-airport', toEntityId: other.entityId, summary: 'Second counterpart', correlationId: null });
  snapshot.timeline.push({ ...snapshot.timeline[0]!, eventId: 'unrelated', fromEntityId: other.entityId, summary: 'Unrelated activity' });
  snapshot.timeline.push(snapshot.timeline[0]!);
  const h = await harness(page, bootstrap(snapshot, 'VIEWER')); await h.open('/');
  await page.locator('.fleet-flight').filter({ hasText: flight.callsign }).click();
  await expect(page.getByRole('tab', { name: 'Communications', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.comm-message')).toHaveCount(17);
  await expect(page.locator('.comm-content').getByText('Recorded summary 0', { exact: true })).toHaveCount(1);
  await expect(page.locator('.comm-content').getByText('Unrelated activity', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Landing negotiation thread' })).toHaveCount(2);
  await page.getByLabel('Conversation with').selectOption(other.entityId);
  await expect(page.locator('.comm-message')).toHaveCount(1);
  await expect(page.locator('.comm-route')).toContainText(other.airportId);
  await expect(page.locator('.comm-meta')).toContainText('PENDING');
  const next = structuredClone(snapshot); next.projectionVersion++;
  await h.emit('snapshot', next);
  await expect(page.getByLabel('Conversation with')).toHaveValue(other.entityId);
  await page.getByRole('tab', { name: 'Controls', exact: true }).click();
  await page.locator('.fleet-flight').filter({ hasText: snapshot.flights[1]!.callsign }).click();
  await expect(page.getByRole('tab', { name: 'Communications', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Awaiting activity', { exact: true })).toBeVisible();
});

test('inspector tabs support keyboard navigation and preserve operational state', async ({ page }) => {
  const snapshot = fixture(); const h = await harness(page, bootstrap(snapshot, 'VIEWER')); await h.open('/');
  await page.locator('.fleet-flight').filter({ hasText: 'GHOST 001' }).click();
  await expect(page.getByRole('tab', { name: 'State', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Flight state' })).toContainText('Fuel remaining');
  await page.getByRole('tab', { name: 'Communications', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Controls', exact: true })).toBeFocused();
  await expect(page.getByText('Fuel remaining', { exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Controls', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Communications', exact: true })).toBeFocused();
});


test('expired counterpart filter returns to all when recent history advances', async ({ page }) => {
  const snapshot = fixture();
  const flight = snapshot.flights[0]!, first = snapshot.airports[0]!, second = snapshot.airports[1]!;
  const event = { eventId: 'first-event', simTimeSec: 1, wallTimeMs: snapshot.serverWallTimeMs, fromEntityId: flight.entityId, toEntityId: first.entityId, type: 'LANDING_REQUEST', summary: 'Older counterpart summary', status: 'INFO' as const, source: 'SYSTEM' as const, correlationId: null };
  snapshot.timeline = [event, { ...event, eventId: 'second-event', toEntityId: second.entityId, summary: 'Remaining counterpart summary' }];
  const h = await harness(page, bootstrap(snapshot, 'VIEWER')); await h.open('/');
  await page.locator('.fleet-flight').filter({ hasText: flight.callsign }).click();
  await page.getByLabel('Conversation with').selectOption(first.entityId);
  await expect(page.locator('.comm-message')).toHaveCount(1);
  await expect(page.locator('.comm-content')).toContainText('Older counterpart summary');
  const next = structuredClone(snapshot); next.projectionVersion++;
  next.timeline = next.timeline.filter((item) => item.toEntityId !== first.entityId);
  await h.emit('snapshot', next);
  await expect(page.getByLabel('Conversation with')).toHaveValue('all');
  await expect(page.locator('.comm-message')).toHaveCount(1);
  await expect(page.locator('.comm-content')).toContainText('Remaining counterpart summary');
});
