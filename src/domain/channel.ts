import type { TwitchIdentity } from './user';

/**
 * The one channel this plugin serves. In this project broadcaster = chat sender = agent sender,
 * so the channel is fully described by the authorized identity.
 */
export interface TwitchChannel {
  broadcaster: TwitchIdentity;
}

export function channelOf(identity: TwitchIdentity): TwitchChannel {
  return { broadcaster: identity };
}
