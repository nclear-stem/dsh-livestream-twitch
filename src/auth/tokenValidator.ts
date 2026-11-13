/** GET https://id.twitch.tv/oauth2/validate — required on start and hourly by Twitch. */

import { TWITCH_ENDPOINTS } from '../config/defaults';
import { errorMessage, readJson, type HttpFetch } from '../runtime/http';
import { normalizeScopes } from './scopes';

export interface ValidatedToken {
  clientId: string;
  login: string;
  userId: string;
  scopes: string[];
  expiresIn: number;
}

export type ValidationResult =
  | { ok: true; token: ValidatedToken }
  | { ok: false; status: number; message: string };

export async function validateToken(fetch: HttpFetch, accessToken: string): Promise<ValidationResult> {
  const res = await fetch(TWITCH_ENDPOINTS.validate, { method: 'GET', headers: { Authorization: `OAuth ${accessToken}` } });
  const body = await readJson(res);
  if (!res.ok) return { ok: false, status: res.status, message: errorMessage(body, `validate failed with HTTP ${res.status}`) };
  const b = body as Record<string, unknown> | undefined;
  if (!b || typeof b.client_id !== 'string') return { ok: false, status: 502, message: 'validate returned an unexpected body' };
  if (typeof b.user_id !== 'string' || !b.user_id) return { ok: false, status: 400, message: 'token is not a user access token' };
  return {
    ok: true,
    token: {
      clientId: b.client_id,
      login: typeof b.login === 'string' ? b.login : '',
      userId: b.user_id,
      scopes: normalizeScopes(b.scopes),
      expiresIn: typeof b.expires_in === 'number' ? b.expires_in : 0,
    },
  };
}
