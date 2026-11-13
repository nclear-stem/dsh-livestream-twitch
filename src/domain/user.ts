/** Twitch identities. `userId` is the stable key; login and display name are for display only. */

export interface TwitchIdentity {
  userId: string;
  login: string;
  displayName: string;
}

/** Memory isolation key for one viewer in one channel. Never merged with other platforms. */
export function viewerMemoryKey(channelId: string, userId: string): string {
  return `twitch:${channelId}:${userId}`;
}

export function sameUser(a: Pick<TwitchIdentity, 'userId'> | undefined, b: Pick<TwitchIdentity, 'userId'> | undefined): boolean {
  return !!a && !!b && a.userId === b.userId;
}
