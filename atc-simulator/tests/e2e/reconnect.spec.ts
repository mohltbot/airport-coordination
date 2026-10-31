import { test, expect } from '@playwright/test';
import { bootstrap, fixture, harness, selectFlight } from './harness';
test.describe('Reconnect browser contract tests (mock transport)', () => {
  test('older, equal and wrong-run snapshots cannot replace current state', async ({ page }) => {
    const h = await harness(page); await h.open(); await selectFlight(page); const current = fixture(); current.projectionVersion += 5; current.flights[0]!.callsign = 'CURRENT 001'; await h.emit('snapshot', current);
    await expect(page.getByRole('heading', { name: 'CURRENT 001' })).toBeVisible();
    for (const version of [current.projectionVersion - 1, current.projectionVersion]) { const stale = fixture(); stale.projectionVersion = version; await h.emit('snapshot', stale); }
    const wrong = fixture(); wrong.runId = '00000000-0000-4000-8000-000000000088'; wrong.projectionVersion += 100; await h.emit('snapshot', wrong);
    await expect(page.getByRole('heading', { name: 'CURRENT 001' })).toBeVisible();
  });
  test('old-run controller reset disables controls and requests fresh invite', async ({ page }) => {
    const h = await harness(page); await h.open(); await selectFlight(page); await h.emit('run-reset', { previousRunId: fixture().runId, activeRunId: null });
    await expect(page.getByText(/Your controller session is no longer valid/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Smoke', exact: true })).toBeDisabled();
  });
  test('viewer reset fetches bootstrap and switches to new run', async ({ page }) => {
    const h = await harness(page, bootstrap(fixture(), 'VIEWER')); await h.open('/'); const next = fixture(); next.runId = '00000000-0000-4000-8000-000000000088'; next.projectionVersion = 1; next.flights[0]!.callsign = 'NEW RUN 001'; next.incidents = []; next.commands = []; h.state.bootstrap = bootstrap(next, 'VIEWER');
    await h.emit('run-reset', { previousRunId: fixture().runId, activeRunId: next.runId }); await expect(page.locator('.fleet-list')).toContainText('NEW RUN 001');
    await expect.poll(() => page.evaluate(() => (window as any).__streams.filter((s: any) => s.readyState !== 2).map((s: any) => s.url))).toEqual([`/api/runs/${next.runId}/events`]);
  });
  test('stale SSE polls newer projection but reconnects only after fresh SSE', async ({ page }) => {
    const h = await harness(page, bootstrap(fixture(), 'VIEWER')); await h.open('/'); await h.emit('snapshot', fixture()); await expect(page.getByRole('status', { name: '' }).filter({ hasText: 'Connected' })).toBeVisible();
    const next = fixture(); next.projectionVersion++; next.flights[0]!.callsign = 'POLLED 001'; h.state.polled = next;
    await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible({ timeout: 6000 }); await expect(page.locator('.fleet-list')).toContainText('POLLED 001'); expect(h.state.polls).toBeGreaterThan(0);
    await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible(); next.projectionVersion++; await h.emit('snapshot', next); await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  });
  test('repetitive equal SSE versions do not suppress stale polling', async ({ page }) => {
    const h = await harness(page, bootstrap(fixture(), 'VIEWER')); await h.open('/');
    await h.emit('snapshot', fixture());
    await page.evaluate(snapshot => {
      (window as any).__equalFrameTimer = setInterval(() => (window as any).__emit('snapshot', snapshot), 150);
    }, fixture());
    try {
      await expect.poll(() => h.state.polls, { timeout: 6000 }).toBeGreaterThan(0);
      await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
    } finally { await page.evaluate(() => clearInterval((window as any).__equalFrameTimer)); }
  });

});
