/**
 * Plugin configuration. The DSH loader validates the `Config` export (a standard-schema object) against the
 * entry in cordis.patch.yml; `resolveConfig` gives the same normalized shape for code paths and tests that
 * receive raw objects. Secrets are never part of this config: only credential reference names are.
 */

import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_CALLBACK_HOST, DEFAULT_CALLBACK_PORT, DEFAULT_REDIRECT_URI, SECRET_REFS } from './defaults';

export interface ChatConfig {
  /** Subscribe to channel.chat.message. */
  read: boolean;
  /** Allow sending chat through Helix at all. */
  send: boolean;
  /** Hand viewer messages to the agent and send its reply automatically. */
  autoReply: boolean;
  /** Decode and run the agent, but never call the send API. */
  dryRun: boolean;
  minReplyIntervalMs: number;
  maxRepliesPerMinute: number;
  /** Max viewer messages waiting for the agent; older chat is dropped first. */
  maxQueue: number;
  /** How long one agent turn may take before the message is given up. */
  agentTimeoutMs: number;
}

export interface EventsConfig {
  follow: boolean;
  subscription: boolean;
  cheer: boolean;
  raid: boolean;
}

export interface TwitchConfig {
  enabled: boolean;
  /** Literal client ID; empty means resolve the `clientIdRef` credential reference. */
  clientId: string;
  clientIdRef: string;
  clientSecretRef: string;
  redirectUri: string;
  callbackHost: string;
  callbackPort: number;
  /** Optional guard: authorization is rejected unless the Twitch login matches. */
  expectedBroadcasterLogin: string;
  /** Connect EventSub on plugin start when a grant and a bound session exist. */
  autoConnect: boolean;
  /** Revoke the token at Twitch on disconnect --forget. */
  revokeOnForget: boolean;
  chat: ChatConfig;
  events: EventsConfig;
}

export const DEFAULT_CONFIG: TwitchConfig = {
  enabled: true,
  clientId: '',
  clientIdRef: SECRET_REFS.clientId,
  clientSecretRef: SECRET_REFS.clientSecret,
  redirectUri: DEFAULT_REDIRECT_URI,
  callbackHost: DEFAULT_CALLBACK_HOST,
  callbackPort: DEFAULT_CALLBACK_PORT,
  expectedBroadcasterLogin: '',
  autoConnect: false,
  revokeOnForget: true,
  chat: {
    read: true,
    send: true,
    autoReply: false,
    dryRun: true,
    minReplyIntervalMs: 3000,
    maxRepliesPerMinute: 15,
    maxQueue: 20,
    agentTimeoutMs: 90_000,
  },
  events: { follow: false, subscription: false, cheer: false, raid: false },
};

const d = DEFAULT_CONFIG;

export const Config = Schema.object({
  enabled: Schema.boolean().default(d.enabled),
  clientId: Schema.string().default(d.clientId).description('Twitch Client ID; leave empty to use the TWITCH_CLIENT_ID credential'),
  clientIdRef: Schema.string().default(d.clientIdRef),
  clientSecretRef: Schema.string().default(d.clientSecretRef).description('Credential reference holding the Client Secret'),
  redirectUri: Schema.string().default(d.redirectUri),
  callbackHost: Schema.string().default(d.callbackHost),
  callbackPort: Schema.natural().default(d.callbackPort),
  expectedBroadcasterLogin: Schema.string().default(d.expectedBroadcasterLogin),
  autoConnect: Schema.boolean().default(d.autoConnect),
  revokeOnForget: Schema.boolean().default(d.revokeOnForget),
  chat: Schema.object({
    read: Schema.boolean().default(d.chat.read),
    send: Schema.boolean().default(d.chat.send),
    autoReply: Schema.boolean().default(d.chat.autoReply),
    dryRun: Schema.boolean().default(d.chat.dryRun),
    minReplyIntervalMs: Schema.natural().default(d.chat.minReplyIntervalMs),
    maxRepliesPerMinute: Schema.natural().default(d.chat.maxRepliesPerMinute),
    maxQueue: Schema.natural().default(d.chat.maxQueue),
    agentTimeoutMs: Schema.natural().default(d.chat.agentTimeoutMs),
  }).default({}),
  events: Schema.object({
    follow: Schema.boolean().default(false),
    subscription: Schema.boolean().default(false),
    cheer: Schema.boolean().default(false),
    raid: Schema.boolean().default(false),
  }).default({}),
});

type Raw = { [K in keyof TwitchConfig]?: TwitchConfig[K] extends object ? Partial<TwitchConfig[K]> : TwitchConfig[K] };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export class ConfigError extends Error {}

/** Merge a raw config over the defaults and enforce the invariants the code relies on. */
export function resolveConfig(raw: Raw | undefined): TwitchConfig {
  const cfg: TwitchConfig = {
    ...DEFAULT_CONFIG,
    ...(raw ?? {}),
    chat: { ...DEFAULT_CONFIG.chat, ...(raw?.chat ?? {}) },
    events: { ...DEFAULT_CONFIG.events, ...(raw?.events ?? {}) },
  } as TwitchConfig;
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: TwitchConfig): void {
  if (!LOOPBACK_HOSTS.has(cfg.callbackHost)) {
    throw new ConfigError(`callbackHost must be a loopback address (127.0.0.1, ::1 or localhost), got "${cfg.callbackHost}"`);
  }
  if (!Number.isInteger(cfg.callbackPort) || cfg.callbackPort < 1 || cfg.callbackPort > 65535) {
    throw new ConfigError(`callbackPort must be 1-65535, got ${cfg.callbackPort}`);
  }
  let redirect: URL;
  try {
    redirect = new URL(cfg.redirectUri);
  } catch {
    throw new ConfigError(`redirectUri is not a URL: "${cfg.redirectUri}"`);
  }
  if (redirect.protocol !== 'http:' || !LOOPBACK_HOSTS.has(redirect.hostname.replace(/^\[|\]$/g, ''))) {
    throw new ConfigError('redirectUri must be an http:// loopback URL (it is only reached through the local browser or an SSH tunnel)');
  }
  if (cfg.chat.maxRepliesPerMinute < 1) throw new ConfigError('chat.maxRepliesPerMinute must be at least 1');
  if (cfg.chat.maxQueue < 1) throw new ConfigError('chat.maxQueue must be at least 1');
}

/** Path the callback server answers on: the path of the registered redirect URI. */
export function callbackPath(cfg: TwitchConfig): string {
  return new URL(cfg.redirectUri).pathname;
}
