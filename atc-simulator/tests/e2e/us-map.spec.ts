import { test, expect } from '@playwright/test';
import { bootstrap, harness } from './harness';
import { usPreviewSnapshot } from '../../web/src/dev/us-preview';

test('US map shows thirteen real towers and opens airport communications', async ({ page }) => {
  const h = await harness(page, bootstrap(structuredClone(usPreviewSnapshot), 'VIEWER'));
  await h.open('/');
  await expect(page.locator('.national-airport')).toHaveCount(13);
  await expect(page.locator('.national-states path')).toHaveCount(49);
  await expect(page.locator('.national-assignment[data-flight-id]')).toHaveCount(usPreviewSnapshot.flights.filter(f => f.activeAssignment && !['LANDED','UNRESOLVED'].includes(f.phase)).length);
  const atl = page.locator('.national-airport').filter({ has: page.locator('title', { hasText: 'Hartsfield' }) });
  await atl.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.inspector-header')).toContainText('Hartsfield');
  await expect(page.getByRole('tab', { name: 'Communications', exact: true })).toHaveAttribute('aria-selected','true');
  await page.getByRole('button', {name:'Close entity details'}).click();
  await expect(page.locator('.right-panel')).toBeHidden();
});

test('Bay Area preset preserves view across snapshots and has honest regional context', async ({ page }) => {
  const snapshot=structuredClone(usPreviewSnapshot);
  const h=await harness(page,bootstrap(snapshot,'VIEWER')); await h.open('/');
  await page.getByLabel('Map region').selectOption('bay');
  await expect(page.getByText('No active towers in this view.',{exact:true})).toHaveCount(0);
  for (const code of ['SFO','OAK','SJC']) await expect(page.locator('.national-label').filter({hasText:code})).toBeVisible();
  await expect(page.locator('.national-context-cities')).toContainText('San Francisco');
  const view=await page.locator('.national-map-svg').getAttribute('viewBox');
  const next=structuredClone(snapshot); next.projectionVersion++;
  await h.emit('snapshot',next);
  await expect(page.locator('.national-map-svg')).toHaveAttribute('viewBox',view!);
  await page.locator('.national-map-svg').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('.national-map-svg')).not.toHaveAttribute('viewBox',view!);
  await page.keyboard.press('Home');
  await expect(page.getByLabel('Map region')).toHaveValue('network');
});

test('US map is usable on a phone without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  const h=await harness(page,bootstrap(structuredClone(usPreviewSnapshot),'VIEWER')); await h.open('/');
  await expect(page.getByRole('button',{name:'Zoom in',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByLabel('Map region').selectOption('southwest');
  await expect(page.getByLabel('Map region')).toHaveValue('southwest');
});
