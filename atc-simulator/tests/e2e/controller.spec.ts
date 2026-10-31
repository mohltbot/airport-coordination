import { test, expect } from '@playwright/test';
import { bootstrap, fixture, harness, selectFlight } from './harness';
test.describe('Controller browser contract tests (mock transport)', () => {
  test('strips invitation fragment and exchanges it once under StrictMode', async ({ page }) => {
    const h = await harness(page); await page.goto('/join#token=one-time-browser-test');
    await expect(page).toHaveURL(/\/control$/); expect(h.state.posts.filter(p => p.path === '/api/join').map(p => p.body)).toEqual([{ token: 'one-time-browser-test' }]);
    expect(page.url()).not.toContain('token');
  });
  test('expired invite removes fragment and requests a fresh invitation', async ({ page }) => {
    const h = await harness(page); h.state.joinStatus = 401; await page.goto('/join#token=expired-browser-test');
    await expect(page.getByRole('heading', { name: 'Could not join' })).toBeVisible(); expect(page.url()).not.toContain('#'); expect(h.state.posts).toHaveLength(1);
  });
  test('202 and APPLIED receipt do not invent active smoke; authoritative snapshot does', async ({ page }) => {
    const h = await harness(page); await h.open(); await selectFlight(page);
    await page.getByRole('button', { name: 'Smoke', exact: true }).click(); await expect.poll(() => h.state.posts.length).toBe(1);
    await expect(page.getByText('No active incidents.', { exact: true })).toBeVisible();
    const body = h.state.posts[0]!.body; expect(body.type).toBe('INCIDENT_CREATE'); expect(body.payload).toMatchObject({ target: 'flight:F001', kind: 'SMOKE', parameters: {} });
    const receipt = { commandId: body.commandId, incidentId: body.payload.incidentId, runId: body.runId, status: 'APPLIED', code: 'OK', resultingRevision: 1 };
    await h.emit('command', receipt); await expect(page.getByText('No active incidents.', { exact: true })).toBeVisible();
    const next = fixture(); next.projectionVersion++; next.commands.push(receipt as any); next.incidents.push({ incidentId: body.payload.incidentId, runId: body.runId, target: 'flight:F001', kind: 'SMOKE', parameters: {}, status: 'ACTIVE', revision: 1, createdAtSimSec: 420, createdAtWallMs: Date.now(), resolvedAtSimSec: null });
    await h.emit('snapshot', next); await expect(page.getByRole('button', { name: 'Resolve smoke' })).toBeVisible();
  });
  test('rapid double tap submits one command', async ({ page }) => {
    const h = await harness(page); await h.open(); await selectFlight(page);
    await page.getByRole('button', { name: 'Smoke', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect.poll(() => h.state.posts.length).toBe(1); await expect(page.getByRole('button', { name: 'Smoke', exact: true })).toBeDisabled();
  });
  test('resolve uses exact current incident revision and low fuel warning', async ({ page }) => {
    const snapshot = fixture(); snapshot.incidents.push({ ...snapshot.incidents[2]!, incidentId: '00000000-0000-4000-8000-000000000099', target: 'flight:F001', kind: 'LOW_FUEL', revision: 7 });
    const h = await harness(page, bootstrap(snapshot)); await h.open(); await selectFlight(page);
    await expect(page.getByText('Resolves the report; remaining fuel does not increase.')).toBeVisible(); await page.getByRole('button', { name: 'Resolve low fuel' }).click();
    await expect.poll(() => h.state.posts.length).toBe(1); expect(h.state.posts[0]!.body).toMatchObject({ type: 'INCIDENT_CLEAR', payload: { expectedIncidentRevision: 7, target: 'flight:F001', incidentId: '00000000-0000-4000-8000-000000000099' } });
  });
  test('requires explicit runway before runway closure', async ({ page }) => {
    const h = await harness(page); await h.open(); await page.getByRole('button', { name: /BRV · Bravo/ }).click();
    await expect(page.getByRole('button', { name: 'Runway closure', exact: true })).toBeDisabled(); await page.getByLabel('Runway for closure').selectOption('R2'); await page.getByRole('button', { name: 'Runway closure', exact: true }).click();
    await expect.poll(() => h.state.posts.length).toBe(1); expect(h.state.posts[0]!.body.payload.parameters).toEqual({ runwayId: 'R2' });
  });
  test('authorization failure disables future mutations', async ({ page }) => {
    const h = await harness(page); h.state.commandStatus = 403; await h.open(); await selectFlight(page); await page.getByRole('button', { name: 'Smoke', exact: true }).click();
    await expect(page.getByText(/Your controller session is no longer valid/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Engine trouble' })).toBeDisabled();
  });
  for (const status of [400, 409]) test(`definitive HTTP ${status} leaves target available for another action`, async ({ page }) => {
    const h = await harness(page); h.state.commandStatus = status; await h.open(); await selectFlight(page);
    await page.getByRole('button', { name: 'Smoke', exact: true }).click();
    await expect(page.getByText('Not submitted', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Engine trouble' })).toBeEnabled();
    h.state.commandStatus = 202; await page.getByRole('button', { name: 'Engine trouble' }).click();
    await expect.poll(() => h.state.posts.length).toBe(2);
    expect(h.state.posts[1]!.body.commandId).not.toBe(h.state.posts[0]!.body.commandId);
  });
  test('malformed 202 is uncertain and retry reuses the exact command', async ({ page }) => {
    const h = await harness(page); h.state.malformedCommand = true; await h.open(); await selectFlight(page);
    await page.getByRole('button', { name: 'Smoke', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry same command' })).toBeVisible();
    await expect(page.getByText('Not submitted', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No active incidents.', { exact: true })).toBeVisible();
    h.state.malformedCommand = false; await page.getByRole('button', { name: 'Retry same command' }).click();
    await expect.poll(() => h.state.posts.length).toBe(2);
    expect(h.state.posts[1]!.body).toEqual(h.state.posts[0]!.body);
  });

});
