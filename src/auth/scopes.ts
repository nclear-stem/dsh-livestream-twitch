/**
 * OAuth scopes. Only what the enabled features need is requested (incremental authorization):
 * chat read/send for the MVP; event scopes only when that event is switched on in config.
 * Deliberately absent: user:bot / channel:bot (that is the two-account cloud chatbot model, not this project).
 */

export const SCOPES = {
  readChat: 'user:read:chat',
  writeChat: 'user:write:chat',
  readFollowers: 'moderator:read:followers',
  readSubscriptions: 'channel:read:subscriptions',
  readBits: 'bits:read',
} as const;

export type TwitchScope = (typeof SCOPES)[keyof typeof SCOPES];

export const FORBIDDEN_SCOPES = ['user:bot', 'channel:bot'] as const;

export function missingScopes(required: readonly string[], granted: readonly string[]): string[] {
  const have = new Set(granted);
  return [...new Set(required)].filter((s) => !have.has(s));
}

export function normalizeScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

export function assertNoForbiddenScopes(scopes: readonly string[]): void {
  const bad = scopes.filter((s) => (FORBIDDEN_SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new Error(`refusing to request bot-account scopes: ${bad.join(', ')}`);
}

/** Scope each optional event needs (raid needs none). Kept in sync with subscriptionRegistry by a test. */
export const EVENT_SCOPES: Record<'follow' | 'subscription' | 'cheer' | 'raid', TwitchScope | null> = {
  follow: SCOPES.readFollowers,
  subscription: SCOPES.readSubscriptions,
  cheer: SCOPES.readBits,
  raid: null,
};

/** Scopes to request for the current config: chat first, then only the switched-on events. */
export function requestedScopes(cfg: { chat: { read: boolean; send: boolean }; events: Record<keyof typeof EVENT_SCOPES, boolean> }): string[] {
  const out: string[] = [];
  if (cfg.chat.read) out.push(SCOPES.readChat);
  if (cfg.chat.send) out.push(SCOPES.writeChat);
  for (const key of Object.keys(EVENT_SCOPES) as Array<keyof typeof EVENT_SCOPES>) {
    const scope = EVENT_SCOPES[key];
    if (cfg.events[key] && scope && !out.includes(scope)) out.push(scope);
  }
  return out;
}
