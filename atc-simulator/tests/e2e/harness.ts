/** Browser contract tests use development fixtures and mocked transport, never live acceptance evidence. */
import { expect, type Page } from '@playwright/test';
import { samplePublicSnapshot } from '../fixtures';
import type { Bootstrap, PublicSnapshot } from '../../packages/domain/src/public';
export const fixture = (): PublicSnapshot => structuredClone(samplePublicSnapshot);
export const descriptor = (snapshot: PublicSnapshot) => ({ runId: snapshot.runId, phase: snapshot.phase, config: snapshot.config });
export function bootstrap(snapshot: PublicSnapshot | null, role: Bootstrap['session']['role'] = 'CONTROLLER'): Bootstrap {
  return { schemaVersion: 1, session: { role, runId: snapshot?.runId ?? null, csrfToken: role === 'VIEWER' ? null : 'browser-test-csrf' }, activeRun: snapshot ? descriptor(snapshot) : null, snapshot };
}
export async function harness(page: Page, initial = bootstrap(fixture())) {
  const state = { bootstrap: initial, polled: initial.snapshot, posts: [] as { path: string; body: any; csrf: string | undefined }[], polls: 0, commandStatus: 202, malformedCommand: false, joinStatus: 200 };
  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1; onerror: ((event: Event) => void) | null = null;
      constructor(public url: string) { super(); (window as any).__streams ??= []; (window as any).__streams.push(this); }
      close() { this.readyState = 2; }
    }
    (window as any).EventSource = MockEventSource;
    (window as any).__emit = (name: string, data: unknown) => {
      for (const source of (window as any).__streams ?? []) if (source.readyState !== 2) source.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
    };
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'POST') {
      const body = request.postDataJSON(); state.posts.push({ path, body, csrf: request.headers()['x-csrf-token'] });
      if (path === '/api/join') return state.joinStatus === 200 ? json(state.bootstrap) : json({ error: { code: 'INVITE_EXPIRED', message: 'Invitation expired', retryable: false } }, state.joinStatus);
      if (path.endsWith('/commands')) return state.commandStatus === 202 ? json(state.malformedCommand ? { accepted: true } : { commandId: body.commandId }, 202) : json({ error: { code: 'SESSION_EXPIRED', message: 'Session expired', retryable: false } }, state.commandStatus);
      if (path === '/api/runs') { const next = state.bootstrap.snapshot ? structuredClone(state.bootstrap.snapshot) : fixture(); next.config = body.config; next.phase = 'CONFIGURING'; state.bootstrap = bootstrap(next, 'OPERATOR'); return json(descriptor(next)); }
      if (path.endsWith('/speed') && state.bootstrap.snapshot) { state.bootstrap.snapshot.config.speed = body.speed; state.bootstrap.snapshot.projectionVersion++; state.bootstrap.activeRun = descriptor(state.bootstrap.snapshot); }
      if (path.endsWith('/start') && state.bootstrap.snapshot) { state.bootstrap.snapshot.phase = 'RUNNING'; state.bootstrap.activeRun = descriptor(state.bootstrap.snapshot); }
      return json(state.bootstrap.activeRun);
    }
    if (path === '/api/bootstrap') return json(state.bootstrap);
    if (path.endsWith('/snapshot')) { state.polls++; return json(state.polled); }
    return json({ error: { code: 'NOT_FOUND', message: 'No receipt yet', retryable: false } }, 404);
  });
  return {
    state,
    async open(path = '/control') { await page.goto(path); await expect.poll(() => page.evaluate(() => ((window as any).__streams ?? []).filter((s: any) => s.readyState !== 2).length)).toBeGreaterThan(0); },
    async emit(name: string, data: unknown) { await page.evaluate(({ name, data }) => (window as any).__emit(name, data), { name, data }); },
  };
}
export async function selectFlight(page: Page, callsign = 'GHOST 001') {
  await page.getByRole('button', { name: 'Flights', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`${callsign} ·`) }).click();
}
