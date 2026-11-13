/**
 * Every EventSub subscription this plugin may create, with its version, scope and condition, in one place.
 * Checked against https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/ on 2026-11-10.
 *
 * Not used: channel.chat.notification. Subscriptions, gifts and resubs come from their dedicated types only,
 * so the same event is never processed twice through two subscriptions.
 */

import { SCOPES } from '../../auth/scopes';
import type { TwitchConfig } from '../../config/schema';
import type { TwitchIdentity } from '../../domain/user';
import type { SubscriptionStatus } from '../../runtime/status';
import { HelixError, type HelixClient } from '../helixClient';

export type EventKey = 'chat' | keyof TwitchConfig['events'];

export interface SubscriptionDefinition {
  type: string;
  version: string;
  /** Config switch that enables it. */
  key: EventKey;
  scopes: string[];
  /** Chat is essential: without it `connect` fails. Others are optional. */
  essential: boolean;
  condition(broadcaster: TwitchIdentity): Record<string, string>;
}

export const SUBSCRIPTIONS: readonly SubscriptionDefinition[] = [
  { type: 'channel.chat.message', version: '1', key: 'chat', scopes: [SCOPES.readChat], essential: true,
    // broadcaster reads its own chat: both IDs are the broadcaster
    condition: (b) => ({ broadcaster_user_id: b.userId, user_id: b.userId }) },
  { type: 'channel.follow', version: '2', key: 'follow', scopes: [SCOPES.readFollowers], essential: false,
    condition: (b) => ({ broadcaster_user_id: b.userId, moderator_user_id: b.userId }) },
  { type: 'channel.subscribe', version: '1', key: 'subscription', scopes: [SCOPES.readSubscriptions], essential: false,
    condition: (b) => ({ broadcaster_user_id: b.userId }) },
  { type: 'channel.subscription.gift', version: '1', key: 'subscription', scopes: [SCOPES.readSubscriptions], essential: false,
    condition: (b) => ({ broadcaster_user_id: b.userId }) },
  { type: 'channel.subscription.message', version: '1', key: 'subscription', scopes: [SCOPES.readSubscriptions], essential: false,
    condition: (b) => ({ broadcaster_user_id: b.userId }) },
  { type: 'channel.cheer', version: '1', key: 'cheer', scopes: [SCOPES.readBits], essential: false,
    condition: (b) => ({ broadcaster_user_id: b.userId }) },
  // raids into this channel; no authorization required
  { type: 'channel.raid', version: '1', key: 'raid', scopes: [], essential: false,
    condition: (b) => ({ to_broadcaster_user_id: b.userId }) },
];

export function definitionFor(type: string): SubscriptionDefinition | undefined {
  return SUBSCRIPTIONS.find((d) => d.type === type);
}

export interface SubscriptionPlan {
  enabled: SubscriptionDefinition[];
  disabled: Array<{ def: SubscriptionDefinition; reason: string }>;
}

/** Which subscriptions to create for this config and these granted scopes. Off-in-config ones are omitted. */
export function planSubscriptions(cfg: Pick<TwitchConfig, 'chat' | 'events'>, granted: readonly string[]): SubscriptionPlan {
  const have = new Set(granted);
  const plan: SubscriptionPlan = { enabled: [], disabled: [] };
  for (const def of SUBSCRIPTIONS) {
    const on = def.key === 'chat' ? cfg.chat.read : cfg.events[def.key];
    if (!on) continue;
    const missing = def.scopes.filter((s) => !have.has(s));
    if (missing.length) plan.disabled.push({ def, reason: `scope not granted: ${missing.join(' ')} (enable it and run /twitch auth again)` });
    else plan.enabled.push(def);
  }
  return plan;
}

export async function createSubscription(helix: HelixClient, def: SubscriptionDefinition, sessionId: string, broadcaster: TwitchIdentity): Promise<SubscriptionStatus> {
  try {
    await helix.request('POST', '/eventsub/subscriptions', {
      body: { type: def.type, version: def.version, condition: def.condition(broadcaster), transport: { method: 'websocket', session_id: sessionId } },
    });
    return { type: def.type, version: def.version, state: 'enabled' };
  } catch (err) {
    if (err instanceof HelixError && err.status === 409) return { type: def.type, version: def.version, state: 'enabled', reason: 'already existed' };
    const hint = err instanceof HelixError && (err.status === 401 || err.status === 403) ? ' (token missing a scope or no permission; run /twitch auth)' : '';
    return { type: def.type, version: def.version, state: 'failed', reason: `${(err as Error).message}${hint}` };
  }
}
