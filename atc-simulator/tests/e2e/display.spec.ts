import { test, expect } from '@playwright/test';
import { bootstrap, fixture, harness } from './harness';
test.describe('Display browser contract tests (mock transport)', () => {
  test('renders three airports and ten flight rows; selection survives ten authoritative snapshots', async ({ page }) => {
    const h = await harness(page, bootstrap(fixture(), 'VIEWER')); await h.open('/');
    await expect(page.getByText('3 airports · 10 flights')).toBeVisible();
    await expect(page.locator('.map-airport')).toHaveCount(3); await expect(page.locator('.fleet-list > li')).toHaveCount(10);
    await page.locator('.fleet-flight').filter({ hasText: 'GHOST 001' }).click();
    for (let i = 1; i <= 10; i++) { const next = fixture(); next.projectionVersion += i; next.flights[0]!.position.x += i; next.flights[0]!.lastDecisionReason = `Update ${i}`; await h.emit('snapshot', next); }
    await expect(page.getByRole('heading', { name: 'GHOST 001', exact: true })).toBeVisible();
    await expect(page.locator('.fleet-selected')).toContainText('GHOST 001'); await page.getByRole('tab', { name: 'State', exact: true }).click(); await expect(page.getByText('Update 10')).toBeVisible();
  });
  test('creates the chosen count and starts with UUID operation and CSRF', async ({ page }) => {
    const h = await harness(page, bootstrap(null, 'OPERATOR')); await page.goto('/');
    await page.getByRole('spinbutton', { name: /Flights/ }).fill('17'); await page.getByRole('button', { name: 'Start simulation' }).click();
    await expect.poll(() => h.state.posts.length).toBe(2);
    expect(h.state.posts[0]!.body).toEqual({ requestId: expect.any(String), config: { flightCount: 17, seed: 20261031, speed: 5, airportNetwork: 'US', continuousTraffic: true } });
    expect(h.state.posts[0]!.csrf).toBe('browser-test-csrf'); expect(h.state.posts[1]!.body.operationId).toMatch(/^[\da-f-]{36}$/);
  });
  test('updates an existing configuring run with the chosen count before start', async ({ page }) => {
    const snapshot = fixture(); snapshot.phase = 'CONFIGURING';
    const h = await harness(page, bootstrap(snapshot, 'OPERATOR')); await h.open('/');
    await page.getByRole('spinbutton', { name: /Flights/ }).fill('23'); await page.getByRole('button', { name: 'Start simulation' }).click();
    await expect.poll(() => h.state.posts.length).toBe(2);
    expect(h.state.posts[0]!.path).toBe('/api/runs'); expect(h.state.posts[0]!.body.config.flightCount).toBe(23);
    expect(h.state.posts[1]!.path).toBe(`/api/runs/${snapshot.runId}/start`);
  });
  test('STARTING retry starts the existing run without recreating configuration', async ({ page }) => {
    const snapshot = fixture(); snapshot.phase = 'STARTING';
    const h = await harness(page, bootstrap(snapshot, 'OPERATOR')); await h.open('/');
    await page.getByRole('button', { name: /Retry initialization|Start simulation/i }).click();
    await expect.poll(() => h.state.posts.length).toBe(1);
    expect(h.state.posts[0]!.path).toBe(`/api/runs/${snapshot.runId}/start`);
  });
  test('rejects invalid count locally', async ({ page }) => {
    const h = await harness(page, bootstrap(null, 'OPERATOR')); await page.goto('/');
    await page.getByRole('spinbutton', { name: /Flights/ }).fill('31'); await expect(page.getByRole('button', { name: 'Start simulation' })).toBeDisabled(); expect(h.state.posts).toHaveLength(0);
  });
  test('viewer sees operational state with mutations disabled', async ({ page }) => {
    const h = await harness(page, bootstrap(fixture(), 'VIEWER')); await h.open('/');
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: /^Select ALP, CLOSED/ }).click(); await page.getByRole('tab', { name: 'Controls', exact: true }).click(); await expect(page.getByRole('button', { name: 'Weather closure', exact: true })).toBeDisabled();
  });
});

for (const phase of ['CONFIGURING', 'RUNNING', 'PAUSED'] as const) {
  test(`operator can change speed in ${phase}`, async ({ page }) => {
    const snapshot = fixture(); snapshot.phase = phase; snapshot.config.speed = 10;
    const h = await harness(page, bootstrap(snapshot, 'OPERATOR')); await h.open('/');
    await page.getByLabel('Run speed', {exact:true}).selectOption('1');
    await expect.poll(() => h.state.posts.length).toBe(1);
    expect(h.state.posts[0]!.path).toBe(`/api/runs/${snapshot.runId}/speed`);
    expect(h.state.posts[0]!.body.speed).toBe(1);
    await expect(page.getByLabel('Run speed', {exact:true})).toHaveValue('1');
    if (phase === 'CONFIGURING') {
      await expect(page.getByLabel('Simulation speed', {exact:true})).toHaveValue('1');
      await page.getByRole('button',{name:'Start simulation',exact:true}).click();
      await expect.poll(() => h.state.posts.length).toBe(3);
      expect(h.state.posts[1]!.body.config.speed).toBe(1);
    }
  });
}
