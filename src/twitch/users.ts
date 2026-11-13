/** Helix GET /users for the token's own user (public profile, used to confirm the channel at authorization). */

import { TWITCH_ENDPOINTS } from '../config/defaults';
import type { TwitchIdentity } from '../domain/user';
import { errorMessage, readJson, type HttpFetch } from '../runtime/http';

export async function fetchSelf(fetch: HttpFetch, auth: { clientId: string; accessToken: string }): Promise<TwitchIdentity> {
  const res = await fetch(`${TWITCH_ENDPOINTS.helix}/users`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'Client-Id': auth.clientId },
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`Helix /users failed: ${errorMessage(body, `HTTP ${res.status}`)}`);
  const user = (body as { data?: Array<Record<string, unknown>> } | undefined)?.data?.[0];
  if (!user || typeof user.id !== 'string') throw new Error('Helix /users returned no user');
  return {
    userId: user.id,
    login: typeof user.login === 'string' ? user.login : '',
    displayName: typeof user.display_name === 'string' ? user.display_name : String(user.login ?? ''),
  };
}
