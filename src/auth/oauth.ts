/**
 * OAuth 2.0 Authorization Code Grant (confidential client) against id.twitch.tv.
 *
 *   begin()  -> one-time state in a short-lived transaction, authorize URL for the browser
 *   callback -> state checked (exists, unexpired, unconsumed), error/code checked
 *   exchange -> POST /oauth2/token with the exact registered redirect_uri
 *   verify   -> /oauth2/validate (client_id, user_id, scopes), Helix /users (display name),
 *               expected login guard, bound-account guard (user_id, never login)
 *   persist  -> TokenManager.replaceGrant (atomic write through the credential store)
 */

import { randomBytes } from 'node:crypto';
import { OAUTH_TRANSACTION_TTL_MS, TWITCH_ENDPOINTS } from '../config/defaults';
import type { TwitchIdentity } from '../domain/user';
import { errorMessage, form, readJson, type HttpFetch } from '../runtime/http';
import { forgetSecret, registerSecret } from '../runtime/redact';
import type { StoredGrant } from '../storage/credentialStore';
import { assertNoForbiddenScopes, missingScopes, normalizeScopes } from './scopes';
import { validateToken } from './tokenValidator';

// ── state transactions ──

export interface OAuthTransaction {
  state: string;
  createdAt: number;
  expiresAt: number;
  scopes: string[];
  replaceAccount: boolean;
}

export type ConsumeResult = { ok: true; tx: OAuthTransaction } | { ok: false; reason: 'unknown_state' | 'expired' | 'already_used' };

export class OAuthTransactions {
  private readonly open = new Map<string, OAuthTransaction>();
  private readonly used = new Map<string, number>();

  constructor(private readonly ttlMs = OAUTH_TRANSACTION_TTL_MS, private readonly now: () => number = Date.now) {}

  create(scopes: string[], replaceAccount: boolean): OAuthTransaction {
    this.sweep();
    const state = randomBytes(32).toString('base64url');
    const t = this.now();
    const tx = { state, createdAt: t, expiresAt: t + this.ttlMs, scopes, replaceAccount };
    this.open.set(state, tx);
    registerSecret(state);
    return tx;
  }

  /** One-shot: a state is valid exactly once and only before it expires. */
  consume(state: string | null | undefined): ConsumeResult {
    this.sweep();
    if (!state) return { ok: false, reason: 'unknown_state' };
    if (this.used.has(state)) return { ok: false, reason: 'already_used' };
    const tx = this.open.get(state);
    if (!tx) return { ok: false, reason: 'unknown_state' };
    this.open.delete(state);
    this.used.set(state, this.now());
    if (this.now() > tx.expiresAt) return { ok: false, reason: 'expired' };
    return { ok: true, tx };
  }

  clear(): void {
    for (const s of this.open.keys()) forgetSecret(s);
    this.open.clear();
  }

  get pending(): number {
    return this.open.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [s, tx] of this.open) if (t > tx.expiresAt + this.ttlMs) this.open.delete(s);
    for (const [s, at] of this.used) if (t - at > this.ttlMs * 2) this.used.delete(s);
  }
}

// ── endpoint calls ──

export function buildAuthorizeUrl(p: { clientId: string; redirectUri: string; scopes: string[]; state: string; forceVerify?: boolean }): string {
  assertNoForbiddenScopes(p.scopes);
  const url = new URL(TWITCH_ENDPOINTS.authorize);
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', p.scopes.join(' '));
  url.searchParams.set('state', p.state);
  if (p.forceVerify) url.searchParams.set('force_verify', 'true');
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
}

export class OAuthHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function parseTokenResponse(body: unknown): TokenResponse {
  const b = body as Record<string, unknown> | undefined;
  if (!b || typeof b.access_token !== 'string' || typeof b.refresh_token !== 'string') throw new OAuthHttpError(502, 'token endpoint returned no access/refresh token');
  registerSecret(b.access_token);
  registerSecret(b.refresh_token);
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresIn: typeof b.expires_in === 'number' ? b.expires_in : 0, scopes: normalizeScopes(b.scope) };
}

async function postToken(fetch: HttpFetch, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TWITCH_ENDPOINTS.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params).toString(),
  });
  const body = await readJson(res);
  if (!res.ok) throw new OAuthHttpError(res.status, errorMessage(body, `token endpoint HTTP ${res.status}`));
  return parseTokenResponse(body);
}

export function exchangeCode(fetch: HttpFetch, p: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<TokenResponse> {
  registerSecret(p.code);
  return postToken(fetch, { client_id: p.clientId, client_secret: p.clientSecret, code: p.code, grant_type: 'authorization_code', redirect_uri: p.redirectUri });
}

export function refreshAccessToken(fetch: HttpFetch, p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<TokenResponse> {
  // URLSearchParams URL-encodes the refresh token, as Twitch requires.
  return postToken(fetch, { client_id: p.clientId, client_secret: p.clientSecret, grant_type: 'refresh_token', refresh_token: p.refreshToken });
}

export async function revokeToken(fetch: HttpFetch, p: { clientId: string; token: string }): Promise<boolean> {
  const res = await fetch(TWITCH_ENDPOINTS.revoke, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: p.clientId, token: p.token }).toString(),
  });
  await res.body?.cancel();
  return res.ok;
}

// ── the whole flow ──

export class AuthorizationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface AuthorizationDeps {
  fetch: HttpFetch;
  clientCredentials: () => Promise<{ clientId: string; clientSecret: string }>;
  redirectUri: string;
  expectedLogin: string;
  /** Account currently bound, if any (from the stored grant). */
  boundIdentity: () => Promise<TwitchIdentity | undefined>;
  fetchSelf: (auth: { clientId: string; accessToken: string }) => Promise<TwitchIdentity>;
  persist: (grant: StoredGrant) => Promise<void>;
  now?: () => number;
}

export interface AuthorizationResult {
  identity: TwitchIdentity;
  scopes: string[];
  missingScopes: string[];
  expiresAt: number;
  replaced: boolean;
}

export class AuthorizationFlow {
  readonly transactions: OAuthTransactions;
  constructor(private readonly deps: AuthorizationDeps, transactions?: OAuthTransactions) {
    this.transactions = transactions ?? new OAuthTransactions(OAUTH_TRANSACTION_TTL_MS, deps.now);
  }

  async begin(scopes: string[], opts: { replaceAccount?: boolean; forceVerify?: boolean } = {}): Promise<{ url: string; state: string }> {
    const { clientId } = await this.deps.clientCredentials();
    const tx = this.transactions.create(scopes, !!opts.replaceAccount);
    return { url: buildAuthorizeUrl({ clientId, redirectUri: this.deps.redirectUri, scopes, state: tx.state, forceVerify: opts.forceVerify ?? !!opts.replaceAccount }), state: tx.state };
  }

  /** Handle the redirect's query string. Throws AuthorizationError with a user-facing message. */
  async complete(query: URLSearchParams): Promise<AuthorizationResult> {
    const consumed = this.transactions.consume(query.get('state'));
    if (!consumed.ok) {
      const why = { unknown_state: 'the state parameter does not match any authorization in progress', expired: 'this authorization attempt expired; run auth again', already_used: 'this authorization link was already used' }[consumed.reason];
      throw new AuthorizationError(consumed.reason, why);
    }
    const tx = consumed.tx;
    const error = query.get('error');
    if (error) throw new AuthorizationError('denied', `Twitch returned ${error}: ${query.get('error_description') ?? 'authorization was not granted'}`);
    const code = query.get('code');
    if (!code) throw new AuthorizationError('missing_code', 'the callback had no authorization code');

    const { clientId, clientSecret } = await this.deps.clientCredentials();
    const token = await exchangeCode(this.deps.fetch, { clientId, clientSecret, code, redirectUri: this.deps.redirectUri });
    const discard = async (why: AuthorizationError) => {
      await revokeToken(this.deps.fetch, { clientId, token: token.accessToken }).catch(() => false);
      return why;
    };

    const validated = await validateToken(this.deps.fetch, token.accessToken);
    if (!validated.ok) throw await discard(new AuthorizationError('invalid_token', `the new token did not validate: ${validated.message}`));
    if (validated.token.clientId !== clientId) throw await discard(new AuthorizationError('client_mismatch', 'the token belongs to a different Client ID'));

    const self = await this.deps.fetchSelf({ clientId, accessToken: token.accessToken });
    if (self.userId !== validated.token.userId) throw await discard(new AuthorizationError('identity_mismatch', 'Helix /users and /validate disagree about the user'));
    const identity: TwitchIdentity = { userId: validated.token.userId, login: validated.token.login || self.login, displayName: self.displayName || self.login };

    const expected = this.deps.expectedLogin.trim().toLowerCase();
    if (expected && identity.login.toLowerCase() !== expected) {
      throw await discard(new AuthorizationError('unexpected_account', `signed in as ${identity.login}, but expectedBroadcasterLogin is ${expected}; sign in with the broadcaster account`));
    }
    const bound = await this.deps.boundIdentity();
    if (bound && bound.userId !== identity.userId && !tx.replaceAccount) {
      throw await discard(new AuthorizationError('account_bound', `this plugin is bound to ${bound.login} (user ID ${bound.userId}); refusing ${identity.login} (user ID ${identity.userId}). Disconnect first, or run auth --replace-account`));
    }

    const scopes = validated.token.scopes.length ? validated.token.scopes : token.scopes;
    const now = (this.deps.now ?? Date.now)();
    const expiresAt = now + (validated.token.expiresIn || token.expiresIn) * 1000;
    await this.deps.persist({ version: 1, clientId, accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt, scopes, identity, obtainedAt: now });
    return { identity, scopes, missingScopes: missingScopes(tx.scopes, scopes), expiresAt, replaced: !!bound && bound.userId !== identity.userId };
  }
}
