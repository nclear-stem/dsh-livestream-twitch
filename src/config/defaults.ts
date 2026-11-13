/** Defaults and fixed Twitch endpoints. Endpoint URLs live here so tests and docs refer to one place. */

export const PLUGIN_NAME = 'dsh-livestream-twitch';

export const TWITCH_ENDPOINTS = {
  authorize: 'https://id.twitch.tv/oauth2/authorize',
  token: 'https://id.twitch.tv/oauth2/token',
  validate: 'https://id.twitch.tv/oauth2/validate',
  revoke: 'https://id.twitch.tv/oauth2/revoke',
  helix: 'https://api.twitch.tv/helix',
  eventsubWs: 'wss://eventsub.wss.twitch.tv/ws',
} as const;

export const DEFAULT_CALLBACK_PORT = 17123;
export const DEFAULT_CALLBACK_HOST = '127.0.0.1';
export const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_CALLBACK_PORT}/oauth/twitch/callback`;

/** Credential reference names (environment-variable grammar) resolved through the DSH credential service. */
export const SECRET_REFS = {
  clientId: 'TWITCH_CLIENT_ID',
  clientSecret: 'TWITCH_CLIENT_SECRET',
} as const;

/** Address of the token grant record in the DSH credential store: `<plugin scope>/<id>`. */
export const GRANT_RECORD_KEY = `${PLUGIN_NAME}/broadcaster`;

/** Twitch limits as documented at implementation time (2026-11). */
export const TWITCH_LIMITS = {
  chatMessageMaxChars: 500,
  /** EventSub WebSocket: a subscription must be created within this window after welcome. */
  welcomeSubscribeWindowMs: 10_000,
  /** Twitch requires token validation on start and hourly. */
  validateEveryMs: 60 * 60 * 1000,
} as const;

export const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;
