import { describe, expect, it } from 'vitest';
import { AuthorizationFlow, buildAuthorizeUrl, OAuthTransactions, type AuthorizationDeps } from '../../src/auth/oauth';
import { requestedScopes } from '../../src/auth/scopes';
import { DEFAULT_CONFIG } from '../../src/config/schema';
import type { StoredGrant } from '../../src/storage/credentialStore';
import { fetchSelf } from '../../src/twitch/users';
import { FAKE, fakeFetch, json } from '../helpers';

const REDIRECT = 'http://localhost:17123/oauth/twitch/callback';

describe('OAuth state transactions', () => {
  it('generates distinct high-entropy states', () => {
    const tx = new OAuthTransactions();
    const a = tx.create([], false).state, b = tx.create([], false).state;
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url').length).toBe(32);
  });

  it('accepts a state exactly once', () => {
    const tx = new OAuthTransactions();
    const { state } = tx.create([], false);
    expect(tx.consume(state).ok).toBe(true);
    expect(tx.consume(state)).toEqual({ ok: false, reason: 'already_used' });
  });

  it('rejects unknown, missing and expired states', () => {
    let now = 1_000;
    const tx = new OAuthTransactions(60_000, () => now);
    expect(tx.consume('nope')).toEqual({ ok: false, reason: 'unknown_state' });
    expect(tx.consume(null)).toEqual({ ok: false, reason: 'unknown_state' });
    const { state } = tx.create([], false);
    now += 60_001;
    expect(tx.consume(state)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('authorize URL', () => {
  it('carries client_id, exact redirect_uri, code response, scopes and state', () => {
    const url = new URL(buildAuthorizeUrl({ clientId: FAKE.clientId, redirectUri: REDIRECT, scopes: ['user:read:chat', 'user:write:chat'], state: 's1' }));
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('user:read:chat user:write:chat');
    expect(url.searchParams.get('state')).toBe('s1');
  });

  it('never requests bot-account scopes', () => {
    expect(() => buildAuthorizeUrl({ clientId: 'x', redirectUri: REDIRECT, scopes: ['user:bot'], state: 's' })).toThrow(/bot-account/);
  });

  it('requests only chat scopes by default and adds event scopes incrementally', () => {
    expect(requestedScopes(DEFAULT_CONFIG)).toEqual(['user:read:chat', 'user:write:chat']);
    expect(requestedScopes({ ...DEFAULT_CONFIG, events: { follow: true, subscription: false, cheer: true, raid: true } }))
      .toEqual(['user:read:chat', 'user:write:chat', 'moderator:read:followers', 'bits:read']);
  });
});

function twitch(opts: { userId?: string; login?: string; scopes?: string[]; clientId?: string; tokenStatus?: number } = {}) {
  return fakeFetch({
    'POST https://id.twitch.tv/oauth2/token': () => opts.tokenStatus
      ? json({ status: opts.tokenStatus, message: 'Invalid authorization code' }, opts.tokenStatus)
      : json({ access_token: 'newaccesstoken0000000000000000', refresh_token: 'newrefreshtoken00000000000000000', expires_in: 14000, scope: opts.scopes ?? ['user:read:chat', 'user:write:chat'], token_type: 'bearer' }),
    'GET https://id.twitch.tv/oauth2/validate': () => json({ client_id: opts.clientId ?? FAKE.clientId, login: opts.login ?? 'streamer', user_id: opts.userId ?? '1001', scopes: opts.scopes ?? ['user:read:chat', 'user:write:chat'], expires_in: 14000 }),
    'GET https://api.twitch.tv/helix/users': () => json({ data: [{ id: opts.userId ?? '1001', login: opts.login ?? 'streamer', display_name: 'Streamer' }] }),
    'POST https://id.twitch.tv/oauth2/revoke': () => new Response(null, { status: 200 }),
  });
}

function flow(f: ReturnType<typeof twitch>, extra: Partial<AuthorizationDeps> = {}) {
  const saved: StoredGrant[] = [];
  const deps: AuthorizationDeps = {
    fetch: f,
    clientCredentials: async () => ({ clientId: FAKE.clientId, clientSecret: FAKE.clientSecret }),
    redirectUri: REDIRECT,
    expectedLogin: '',
    boundIdentity: async () => undefined,
    fetchSelf: (auth) => fetchSelf(f, auth),
    persist: async (g) => { saved.push(g); },
    ...extra,
  };
  return { flow: new AuthorizationFlow(deps), saved };
}

async function callback(fl: AuthorizationFlow, params: Record<string, string>, scopes = ['user:read:chat', 'user:write:chat'], replace = false) {
  const { state } = await fl.begin(scopes, { replaceAccount: replace });
  return fl.complete(new URLSearchParams({ state, ...params }));
}

describe('authorization flow', () => {
  it('exchanges the code with every required parameter and the exact redirect URI, then stores the grant', async () => {
    const f = twitch();
    const { flow: fl, saved } = flow(f);
    const result = await callback(fl, { code: 'authcode123456', scope: 'user:read:chat user:write:chat' });
    const exchange = f.calls.find((c) => c.url.endsWith('/oauth2/token'))!;
    const body = new URLSearchParams(exchange.body);
    expect(Object.fromEntries(body)).toEqual({ client_id: FAKE.clientId, client_secret: FAKE.clientSecret, code: 'authcode123456', grant_type: 'authorization_code', redirect_uri: REDIRECT });
    expect(f.calls.find((c) => c.url.endsWith('/validate'))!.headers.authorization).toBe('OAuth newaccesstoken0000000000000000');
    expect(result.identity).toEqual({ userId: '1001', login: 'streamer', displayName: 'Streamer' });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.refreshToken).toBe('newrefreshtoken00000000000000000');
    expect(saved[0]!.identity.userId).toBe('1001');
  });

  it('reports a Twitch error parameter and a missing code without calling the token endpoint', async () => {
    const f = twitch();
    const { flow: fl } = flow(f);
    await expect(callback(fl, { error: 'access_denied', error_description: 'The user denied you access' })).rejects.toThrow(/access_denied/);
    await expect(callback(fl, {})).rejects.toThrow(/no authorization code/);
    expect(f.calls).toHaveLength(0);
  });

  it('rejects a mismatched state before doing anything', async () => {
    const f = twitch();
    const { flow: fl } = flow(f);
    await fl.begin([]);
    await expect(fl.complete(new URLSearchParams({ state: 'forged', code: 'x' }))).rejects.toThrow(/does not match/);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a different account than the bound one (by user ID) and revokes the new token', async () => {
    const f = twitch({ userId: '2002', login: 'someoneelse' });
    const { flow: fl, saved } = flow(f, { boundIdentity: async () => ({ userId: '1001', login: 'streamer', displayName: 'Streamer' }) });
    await expect(callback(fl, { code: 'c' })).rejects.toThrow(/bound to streamer/);
    expect(saved).toHaveLength(0);
    expect(f.calls.some((c) => c.url.endsWith('/oauth2/revoke'))).toBe(true);
  });

  it('a bound account with the same user ID but a renamed login is accepted', async () => {
    const f = twitch({ userId: '1001', login: 'renamed' });
    const { flow: fl, saved } = flow(f, { boundIdentity: async () => ({ userId: '1001', login: 'streamer', displayName: 'Streamer' }) });
    await callback(fl, { code: 'c' });
    expect(saved[0]!.identity.login).toBe('renamed');
  });

  it('allows replacing the bound account only with --replace-account', async () => {
    const f = twitch({ userId: '2002', login: 'newchannel' });
    const { flow: fl, saved } = flow(f, { boundIdentity: async () => ({ userId: '1001', login: 'streamer', displayName: 'Streamer' }) });
    const r = await callback(fl, { code: 'c' }, undefined, true);
    expect(r.replaced).toBe(true);
    expect(saved[0]!.identity.userId).toBe('2002');
  });

  it('enforces expectedBroadcasterLogin', async () => {
    const { flow: fl, saved } = flow(twitch({ login: 'wrong' }), { expectedLogin: 'streamer' });
    await expect(callback(fl, { code: 'c' })).rejects.toThrow(/expectedBroadcasterLogin/);
    expect(saved).toHaveLength(0);
  });

  it('rejects a token issued to another client ID', async () => {
    const { flow: fl } = flow(twitch({ clientId: 'otherclient' }));
    await expect(callback(fl, { code: 'c' })).rejects.toThrow(/different Client ID/);
  });

  it('reports scopes the user did not grant instead of failing', async () => {
    const { flow: fl } = flow(twitch({ scopes: ['user:read:chat'] }));
    const r = await callback(fl, { code: 'c' });
    expect(r.missingScopes).toEqual(['user:write:chat']);
  });

  it('surfaces token endpoint errors without leaking the code or secret', async () => {
    const { flow: fl } = flow(twitch({ tokenStatus: 400 }));
    const err = await callback(fl, { code: 'supersecretcode99' }).catch((e: Error) => e);
    expect(String(err)).toMatch(/Invalid authorization code/);
    expect(String(err)).not.toContain('supersecretcode99');
    expect(String(err)).not.toContain(FAKE.clientSecret);
  });
});
