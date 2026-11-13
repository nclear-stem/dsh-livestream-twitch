/** Helix (api.twitch.tv/helix) requests through the TokenManager's 401-refresh-retry wrapper. */

import type { TokenManager } from '../auth/tokenManager';
import { TWITCH_ENDPOINTS } from '../config/defaults';
import { errorMessage, readJson, type HttpFetch } from '../runtime/http';

export class HelixError extends Error {
  constructor(readonly status: number, message: string, readonly retryAt?: number) {
    super(message);
  }
}

export type TokenSource = Pick<TokenManager, 'withToken'>;

export interface HelixResponse<T> {
  status: number;
  body: T;
}

export class HelixClient {
  constructor(private readonly tokens: TokenSource, private readonly fetch: HttpFetch, private readonly now: () => number = Date.now) {}

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<HelixResponse<T>> {
    const url = new URL(`${TWITCH_ENDPOINTS.helix}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const res = await this.tokens.withToken(({ accessToken, clientId }) => this.fetch(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }));
    const body = await readJson(res);
    if (!res.ok) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const retryAt = res.status === 429 ? (Number.isFinite(reset) && reset > 0 ? reset * 1000 : this.now() + 1000) : undefined;
      throw new HelixError(res.status, `Helix ${method} ${path}: ${errorMessage(body, `HTTP ${res.status}`)}`, retryAt);
    }
    return { status: res.status, body: body as T };
  }
}
