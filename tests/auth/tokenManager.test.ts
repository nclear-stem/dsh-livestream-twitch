import { describe, expect, it } from 'vitest';
import { ReauthorizationRequiredError, TokenManager, type Scheduler } from '../../src/auth/tokenManager';
import { StatusStore } from '../../src/runtime/status';
import { MemoryCredentialStore } from '../../src/storage/credentialStore';
import { FAKE, fakeFetch, grant, json, memoryLogger, tick } from '../helpers';

class ManualScheduler implements Scheduler {
  fns: Array<{ fn: () => void; ms: number }> = [];
  setInterval(fn: () => void, ms: number) {
    this.fns.push({ fn, ms });
    return this.fns.length - 1;
  }
  clearInterval() {
    this.fns = [];
  }
  fire() {
    for (const f of this.fns) f.fn();
  }
}

const validOk = (token = FAKE.access) => () => json({ client_id: FAKE.clientId, login: 'streamer', user_id: '1001', scopes: ['user:read:chat', 'user:write:chat'], expires_in: 9000, token });

function setup(routes: Parameters<typeof fakeFetch>[0], store = new MemoryCredentialStore(grant())) {
  const scheduler = new ManualScheduler();
  const status = new StatusStore();
  const { logger, lines } = memoryLogger();
  const f = fakeFetch(routes);
  const tm = new TokenManager({ store, fetch: f, logger, status, scheduler, clientCredentials: async () => ({ clientId: FAKE.clientId, clientSecret: FAKE.clientSecret }) });
  return { tm, f, store, scheduler, status, lines };
}

const refreshed = (n: number) => json({ access_token: `rotatedaccess${n}xxxxxxxxxxxxxxx`, refresh_token: `rotatedrefresh${n}xxxxxxxxxxxxxxx`, expires_in: 14000, scope: ['user:read:chat', 'user:write:chat'] });

describe('TokenManager', () => {
  it('validates on start and schedules hourly validation', async () => {
    const { tm, f, scheduler, status } = setup({ 'GET https://id.twitch.tv/oauth2/validate': validOk() });
    expect(await tm.start()).toBe('valid');
    expect(f.calls.filter((c) => c.url.endsWith('/validate'))).toHaveLength(1);
    expect(scheduler.fns[0]!.ms).toBe(3_600_000);
    scheduler.fire();
    await tick();
    expect(f.calls.filter((c) => c.url.endsWith('/validate'))).toHaveLength(2);
    expect(status.snapshot().auth.identity?.userId).toBe('1001');
  });

  it('is unauthorized without a stored grant and refuses to hand out tokens', async () => {
    const { tm } = setup({}, new MemoryCredentialStore());
    expect(await tm.start()).toBe('unauthorized');
    await expect(tm.accessToken()).rejects.toBeInstanceOf(ReauthorizationRequiredError);
  });

  it('refreshes when validation returns 401 and persists the rotated refresh token', async () => {
    const { tm, store } = setup({
      'GET https://id.twitch.tv/oauth2/validate': () => json({ status: 401, message: 'invalid access token' }, 401),
      'POST https://id.twitch.tv/oauth2/token': () => refreshed(1),
    });
    expect(await tm.start()).toBe('valid');
    expect(store.grant!.accessToken).toBe('rotatedaccess1xxxxxxxxxxxxxxx');
    expect(store.grant!.refreshToken).toBe('rotatedrefresh1xxxxxxxxxxxxxxx');
  });

  it('on API 401 refreshes once and retries once', async () => {
    let n = 0;
    const { tm, f, store } = setup({ 'GET https://id.twitch.tv/oauth2/validate': validOk(), 'POST https://id.twitch.tv/oauth2/token': () => refreshed(++n) });
    await tm.start();
    const seen: string[] = [];
    const res = await tm.withToken(async ({ accessToken }) => {
      seen.push(accessToken);
      return seen.length === 1 ? json({ message: 'Invalid OAuth token' }, 401) : json({ ok: true });
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([FAKE.access, 'rotatedaccess1xxxxxxxxxxxxxxx']);
    expect(f.calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(1);
    const body = new URLSearchParams(f.calls.find((c) => c.url.endsWith('/oauth2/token'))!.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe(FAKE.refresh);
    expect(store.writes).toBe(1);
  });

  it('does not loop when the retry is still 401', async () => {
    let n = 0;
    const { tm, f } = setup({ 'GET https://id.twitch.tv/oauth2/validate': validOk(), 'POST https://id.twitch.tv/oauth2/token': () => refreshed(++n) });
    await tm.start();
    let calls = 0;
    const res = await tm.withToken(async () => { calls++; return json({ message: 'Invalid OAuth token' }, 401); });
    expect(res.status).toBe(401);
    expect(calls).toBe(2);
    expect(f.calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(1);
  });

  it('does not refresh for a missing-scope 401', async () => {
    const { tm, f } = setup({ 'GET https://id.twitch.tv/oauth2/validate': validOk() });
    await tm.start();
    const res = await tm.withToken(async () => json({ status: 401, message: 'Missing scope: bits:read' }, 401));
    expect(res.status).toBe(401);
    expect(f.calls.some((c) => c.url.endsWith('/oauth2/token'))).toBe(false);
  });

  it('concurrent 401s trigger exactly one refresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let refreshes = 0;
    const { tm } = setup({
      'GET https://id.twitch.tv/oauth2/validate': validOk(),
      'POST https://id.twitch.tv/oauth2/token': async () => { refreshes++; await gate; return refreshed(refreshes); },
    });
    await tm.start();
    const call = () => tm.withToken(async ({ accessToken }) => (accessToken === FAKE.access ? json({ message: 'Invalid OAuth token' }, 401) : json({ token: accessToken })));
    const all = Promise.all([call(), call(), call(), call(), call()]);
    await tick(5);
    release();
    const results = await all;
    expect(refreshes).toBe(1);
    for (const r of results) expect(r.status).toBe(200);
  });

  it('adopts a token another process already rotated instead of spending the refresh token again', async () => {
    const store = new MemoryCredentialStore(grant());
    const { tm, f } = setup({ 'GET https://id.twitch.tv/oauth2/validate': validOk() }, store);
    await tm.start();
    store.grant = grant({ accessToken: 'otherprocessaccess0000000000', refreshToken: 'otherprocessrefresh0000000000' });
    const res = await tm.withToken(async ({ accessToken }) => (accessToken === FAKE.access ? json({ message: 'Invalid OAuth token' }, 401) : json({ token: accessToken })));
    expect(await res.json()).toEqual({ token: 'otherprocessaccess0000000000' });
    expect(f.calls.some((c) => c.url.endsWith('/oauth2/token'))).toBe(false);
  });

  it('enters reauthorization_required when refresh is rejected, and notifies listeners', async () => {
    const { tm, status } = setup({
      'GET https://id.twitch.tv/oauth2/validate': validOk(),
      'POST https://id.twitch.tv/oauth2/token': () => json({ status: 400, message: 'Invalid refresh token' }, 400),
    });
    await tm.start();
    const states: string[] = [];
    tm.onStateChange((s) => states.push(s));
    await expect(tm.withToken(async () => json({ message: 'Invalid OAuth token' }, 401))).rejects.toBeInstanceOf(ReauthorizationRequiredError);
    expect(tm.authState).toBe('reauthorization_required');
    expect(states).toContain('reauthorization_required');
    expect(status.snapshot().auth.state).toBe('reauthorization_required');
    await expect(tm.accessToken()).rejects.toBeInstanceOf(ReauthorizationRequiredError);
  });

  it('a validation network error keeps the current state', async () => {
    const { tm } = setup({ 'GET https://id.twitch.tv/oauth2/validate': () => { throw new TypeError('fetch failed'); } });
    expect(await tm.start()).toBe('valid');
  });

  it('rejects a stored token that validates for another user', async () => {
    const { tm } = setup({ 'GET https://id.twitch.tv/oauth2/validate': () => json({ client_id: FAKE.clientId, login: 'x', user_id: '9', scopes: [], expires_in: 100 }) });
    expect(await tm.start()).toBe('reauthorization_required');
  });

  it('forget revokes and clears the grant', async () => {
    const { tm, f, store } = setup({ 'GET https://id.twitch.tv/oauth2/validate': validOk(), 'POST https://id.twitch.tv/oauth2/revoke': () => new Response(null, { status: 200 }) });
    await tm.start();
    expect(await tm.forget({ revoke: true })).toEqual({ revoked: true });
    expect(new URLSearchParams(f.calls.find((c) => c.url.endsWith('/revoke'))!.body).get('token')).toBe(FAKE.access);
    expect(store.grant).toBeUndefined();
    expect(tm.authState).toBe('unauthorized');
  });

  it('never logs token material', async () => {
    const { tm, lines } = setup({
      'GET https://id.twitch.tv/oauth2/validate': () => json({ message: 'invalid' }, 401),
      'POST https://id.twitch.tv/oauth2/token': () => json({ status: 400, message: `bad token ${FAKE.refresh}` }, 400),
    });
    await tm.start();
    const all = lines.map((l) => l.message).join('\n');
    expect(all).toContain('reauthorization required');
    expect(all).not.toContain(FAKE.refresh);
    expect(all).not.toContain(FAKE.access);
  });
});
