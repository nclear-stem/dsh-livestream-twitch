/**
 * TokenManager: the only holder of the live user access token. Every Helix call and every EventSub
 * subscription goes through `withToken`.
 *
 * - Validates on start and every hour (Twitch requirement), not just by looking at expiresAt.
 * - A 401 triggers one controlled refresh and one retry of the original request (no loops). A 401 that is
 *   about a missing scope is returned as-is: refreshing cannot add a scope.
 * - Refresh is single-flight in-process, and runs inside the credential store's serialized
 *   read-modify-write, so the rotated refresh token is persisted (atomically with the new access token)
 *   before any caller sees success. If another process already rotated the token, its result is adopted
 *   instead of spending the refresh token twice.
 * - A rejected refresh or a revoked token moves to `reauthorization_required` and notifies listeners
 *   (the supervisor stops EventSub).
 */

import { TWITCH_LIMITS } from '../config/defaults';
import type { TwitchIdentity } from '../domain/user';
import type { HttpFetch } from '../runtime/http';
import type { Logger } from '../runtime/redact';
import { forgetSecret, registerSecret } from '../runtime/redact';
import type { AuthState, StatusStore } from '../runtime/status';
import type { CredentialStore, StoredGrant } from '../storage/credentialStore';
import { OAuthHttpError, refreshAccessToken, revokeToken } from './oauth';
import { validateToken } from './tokenValidator';

export class ReauthorizationRequiredError extends Error {
  constructor(message = 'Twitch authorization is missing or was revoked; run /twitch auth') {
    super(message);
  }
}

export interface Scheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface TokenManagerDeps {
  store: CredentialStore;
  fetch: HttpFetch;
  clientCredentials: () => Promise<{ clientId: string; clientSecret: string }>;
  logger: Logger;
  status: StatusStore;
  scheduler?: Scheduler;
  now?: () => number;
  validateEveryMs?: number;
}

type StateListener = (state: AuthState) => void;

export class TokenManager {
  private grant: StoredGrant | undefined;
  private state: AuthState = 'unauthorized';
  private refreshing: Promise<StoredGrant> | null = null;
  private timer: unknown = null;
  private readonly listeners = new Set<StateListener>();
  private readonly scheduler: Scheduler;
  private readonly now: () => number;

  constructor(private readonly deps: TokenManagerDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
    this.now = deps.now ?? Date.now;
  }

  get authState(): AuthState {
    return this.state;
  }

  get identity(): TwitchIdentity | undefined {
    return this.grant?.identity;
  }

  get scopes(): string[] {
    return this.grant?.scopes ?? [];
  }

  get clientId(): string | undefined {
    return this.grant?.clientId;
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load the stored grant, validate it, and start the hourly validation. */
  async start(): Promise<AuthState> {
    this.grant = await this.deps.store.readGrant();
    if (!this.grant) {
      this.setState('unauthorized');
    } else {
      this.publishGrant();
      await this.validateNow();
    }
    this.schedule();
    return this.state;
  }

  stop(): void {
    if (this.timer !== null) this.scheduler.clearInterval(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.stop();
    this.timer = this.scheduler.setInterval(() => {
      if (this.grant && this.state !== 'reauthorization_required') {
        void this.validateNow().catch((err) => this.deps.logger.warn(`hourly validation failed: ${(err as Error).message}`));
      }
    }, this.deps.validateEveryMs ?? TWITCH_LIMITS.validateEveryMs);
  }

  /** /oauth2/validate the current token; on 401 refresh once. Network errors keep the current state. */
  async validateNow(): Promise<AuthState> {
    const grant = this.grant;
    if (!grant) return this.setState('unauthorized');
    if (this.state !== 'valid') this.setState('validating');
    const result = await validateToken(this.deps.fetch, grant.accessToken).catch((err: unknown) => {
      this.deps.logger.warn(`token validation request failed: ${(err as Error).message}`);
      return null;
    });
    if (!result) {
      if (this.state === 'validating') this.setState('valid');
      return this.state;
    }
    if (result.ok) {
      if (result.token.clientId !== grant.clientId || result.token.userId !== grant.identity.userId) {
        return this.requireReauth('stored token belongs to a different client or user');
      }
      this.grant = { ...grant, scopes: result.token.scopes, expiresAt: this.now() + result.token.expiresIn * 1000 };
      this.deps.status.auth({ lastValidatedAt: this.now() });
      this.publishGrant();
      return this.setState('valid');
    }
    if (result.status === 401) {
      try {
        await this.refresh(grant.accessToken);
        this.deps.status.auth({ lastValidatedAt: this.now() });
        return this.state;
      } catch {
        return this.state;
      }
    }
    this.deps.logger.warn(`token validation returned HTTP ${result.status}: ${result.message}`);
    return this.state;
  }

  async accessToken(): Promise<string> {
    if (!this.grant || this.state === 'reauthorization_required' || this.state === 'unauthorized') throw new ReauthorizationRequiredError();
    return this.grant.accessToken;
  }

  /**
   * Run an authenticated request. On 401: one refresh (shared by concurrent callers), one retry.
   * A second 401 is returned to the caller unchanged.
   */
  async withToken(call: (auth: { accessToken: string; clientId: string }) => Promise<Response>): Promise<Response> {
    const token = await this.accessToken();
    const clientId = this.grant!.clientId;
    const first = await call({ accessToken: token, clientId });
    if (first.status !== 401) return first;
    if (await isScopeError(first)) return first;
    await first.body?.cancel().catch(() => undefined);
    const fresh = await this.refresh(token);
    return call({ accessToken: fresh.accessToken, clientId: fresh.clientId });
  }

  /** Single-flight refresh. `staleToken` is the token the caller saw fail. */
  refresh(staleToken: string): Promise<StoredGrant> {
    if (this.grant && this.grant.accessToken !== staleToken && this.state === 'valid') return Promise.resolve(this.grant);
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(staleToken).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(staleToken: string): Promise<StoredGrant> {
    const { clientId, clientSecret } = await this.deps.clientCredentials();
    const ctl: { outcome: 'refreshed' | 'adopted' } = { outcome: 'refreshed' };
    try {
      const saved = await this.deps.store.modifyGrant(async (current) => {
        if (!current) throw new ReauthorizationRequiredError('no stored Twitch grant');
        if (current.accessToken !== staleToken) {
          ctl.outcome = 'adopted';
          return undefined;
        }
        const token = await refreshAccessToken(this.deps.fetch, { clientId: current.clientId || clientId, clientSecret, refreshToken: current.refreshToken });
        return {
          ...current,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          scopes: token.scopes.length ? token.scopes : current.scopes,
          expiresAt: this.now() + token.expiresIn * 1000,
          obtainedAt: this.now(),
        };
      });
      if (!saved) throw new ReauthorizationRequiredError('no stored Twitch grant');
      if (this.grant && this.grant.accessToken !== saved.accessToken) forgetSecret(this.grant.accessToken);
      this.grant = saved;
      this.publishGrant();
      this.setState('valid');
      this.deps.logger.info(ctl.outcome === 'adopted' ? 'adopted a token refreshed by another process' : 'access token refreshed');
      return saved;
    } catch (err) {
      if (err instanceof ReauthorizationRequiredError || (err instanceof OAuthHttpError && (err.status === 400 || err.status === 401 || err.status === 403))) {
        this.requireReauth(`refresh rejected: ${err.message}`);
        throw new ReauthorizationRequiredError();
      }
      // network / 5xx: keep state, let the caller fail this request
      this.deps.logger.warn(`token refresh failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Store a grant from a completed authorization (account guard already applied by the flow). */
  async replaceGrant(grant: StoredGrant): Promise<void> {
    const previous = this.grant;
    await this.deps.store.modifyGrant(async () => grant);
    if (previous && previous.accessToken !== grant.accessToken) forgetSecret(previous.accessToken);
    this.grant = grant;
    this.publishGrant();
    this.deps.status.auth({ lastValidatedAt: this.now() });
    this.setState('valid');
  }

  /** Disconnect --forget: revoke at Twitch (best effort), clear the local grant and binding. */
  async forget(opts: { revoke: boolean }): Promise<{ revoked: boolean }> {
    const grant = this.grant ?? (await this.deps.store.readGrant());
    let revoked = false;
    if (grant && opts.revoke) {
      revoked = await revokeToken(this.deps.fetch, { clientId: grant.clientId, token: grant.accessToken }).catch(() => false);
    }
    await this.deps.store.deleteGrant();
    if (grant) {
      forgetSecret(grant.accessToken);
      forgetSecret(grant.refreshToken);
    }
    this.grant = undefined;
    this.deps.status.auth({ identity: null, scopes: [], expiresAt: null, lastValidatedAt: null });
    this.setState('unauthorized');
    return { revoked };
  }

  private requireReauth(reason: string): AuthState {
    this.deps.logger.warn(`reauthorization required: ${reason}`);
    this.deps.status.error(`Twitch reauthorization required (${reason})`);
    return this.setState('reauthorization_required');
  }

  private publishGrant(): void {
    const g = this.grant;
    if (g) {
      registerSecret(g.accessToken);
      registerSecret(g.refreshToken);
    }
    this.deps.status.auth({ identity: g ? { ...g.identity } : null, scopes: g ? [...g.scopes] : [], expiresAt: g?.expiresAt ?? null });
  }

  private setState(state: AuthState): AuthState {
    const changed = state !== this.state;
    this.state = state;
    this.deps.status.auth({ state });
    if (changed) for (const l of this.listeners) l(state);
    return state;
  }
}

async function isScopeError(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { message?: unknown };
    return typeof body.message === 'string' && /scope/i.test(body.message);
  } catch {
    return false;
  }
}
