import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCallbackServer } from '../../src/auth/callbackServer';
import { resolveConfig } from '../../src/config/schema';
import { PluginRuntime } from '../../src/runtime/lifecycle';
import { Supervisor } from '../../src/runtime/supervisor';
import { MemoryCredentialStore } from '../../src/storage/credentialStore';
import { MemorySettingsStore } from '../../src/storage/settingsStore';
import { FAKE, fakeFetch, json, memoryLogger } from '../helpers';

const PORT = 17000 + Math.floor(Math.random() * 900);

describe('callback server', () => {
  it('refuses to bind a non-loopback address', async () => {
    await expect(startCallbackServer({ host: '0.0.0.0', port: PORT, path: '/cb', timeoutMs: 1000, onCallback: async () => ({ status: 200, title: '', message: '', done: true }) })).rejects.toThrow(/loopback/);
  });

  it('answers only the callback path and closes after a completed callback', async () => {
    const seen: string[] = [];
    let closed = '';
    const srv = await startCallbackServer({
      host: '127.0.0.1', port: PORT, path: '/oauth/twitch/callback', timeoutMs: 5000,
      onCallback: async (q) => { seen.push(q.get('code') ?? ''); return { status: 200, title: 'ok', message: 'done <b>', done: true }; },
      onClosed: (r) => { closed = r; },
    });
    const other = await fetch(`http://127.0.0.1:${PORT}/other`);
    expect(other.status).toBe(404);
    const res = await fetch(`http://127.0.0.1:${PORT}/oauth/twitch/callback?code=abc&state=s`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('done &#60;b&#62;');
    for (let i = 0; i < 50 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['abc']);
    expect(closed).toBe('done');
    await expect(fetch(`http://127.0.0.1:${PORT}/oauth/twitch/callback`)).rejects.toThrow();
    await srv.close();
  });
});

describe('end-to-end authorization through the supervisor', () => {
  it('auth -> browser callback -> stored grant -> status shows the account, never the token', async () => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'));
    const port = PORT + 1;
    const store = new MemoryCredentialStore(undefined, { TWITCH_CLIENT_SECRET: FAKE.clientSecret });
    const { logger } = memoryLogger();
    const runtime = new PluginRuntime({
      config: resolveConfig({ clientId: FAKE.clientId, callbackPort: port, redirectUri: `http://localhost:${port}/oauth/twitch/callback` }),
      store, settingsStore: new MemorySettingsStore(), logger,
    });
    const f = fakeFetch({
      'POST https://id.twitch.tv/oauth2/token': () => json({ access_token: 'e2eaccesstoken000000000000', refresh_token: 'e2erefreshtoken000000000000', expires_in: 10000, scope: ['user:read:chat', 'user:write:chat'] }),
      'GET https://id.twitch.tv/oauth2/validate': () => json({ client_id: FAKE.clientId, login: 'streamer', user_id: '1001', scopes: ['user:read:chat', 'user:write:chat'], expires_in: 10000 }),
      'GET https://api.twitch.tv/helix/users': () => json({ data: [{ id: '1001', login: 'streamer', display_name: 'Streamer' }] }),
    });
    const sup = new Supervisor(runtime, { fetch: f });
    await sup.boot();
    expect(sup.tokens.authState).toBe('unauthorized');
    const start = await sup.beginAuth();
    const state = new URL(start.url).searchParams.get('state')!;
    const res = await fetch(`http://127.0.0.1:${port}/oauth/twitch/callback?code=thecode123&state=${state}`);
    expect(res.status).toBe(200);
    expect(sup.tokens.authState).toBe('valid');
    expect(store.grant?.refreshToken).toBe('e2erefreshtoken000000000000');
    const snapshot = JSON.stringify(runtime.status.snapshot());
    expect(snapshot).toContain('"userId":"1001"');
    expect(snapshot).not.toContain('e2eaccesstoken');
    expect(snapshot).not.toContain('e2erefreshtoken');
    expect(snapshot).not.toContain('thecode123');
    await sup.shutdown();
  });

  it('reports a busy callback port with an actionable message', async () => {
    const port = PORT + 2;
    const blocker = await startCallbackServer({ host: '127.0.0.1', port, path: '/x', timeoutMs: 5000, onCallback: async () => ({ status: 200, title: '', message: '', done: false }) });
    const runtime = new PluginRuntime({
      config: resolveConfig({ clientId: FAKE.clientId, callbackPort: port }),
      store: new MemoryCredentialStore(undefined, { TWITCH_CLIENT_SECRET: FAKE.clientSecret }), settingsStore: new MemorySettingsStore(), logger: memoryLogger().logger,
    });
    await expect(new Supervisor(runtime).beginAuth()).rejects.toThrow(/is busy/);
    await blocker.close();
  });

  it('explains a missing client secret', async () => {
    const runtime = new PluginRuntime({ config: resolveConfig({ clientId: FAKE.clientId }), store: new MemoryCredentialStore(), settingsStore: new MemorySettingsStore(), logger: memoryLogger().logger });
    await expect(new Supervisor(runtime).beginAuth()).rejects.toThrow(/TWITCH_CLIENT_SECRET credential/);
  });
});
