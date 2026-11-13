/** Platform-neutral-shaped but Twitch-only internal events. No Bilibili fields (yuan, guard levels, medals). */

import type { TwitchIdentity } from './user';

export interface TwitchBadge {
  setId: string;
  id: string;
  info: string;
}

export interface TwitchChatMessageEvent {
  /** EventSub metadata.message_id, used for idempotent dedupe. */
  id: string;
  /** Chat message UUID (event.message_id); the target for reply_parent_message_id. */
  chatMessageId: string;
  channelId: string;
  sender: TwitchIdentity;
  text: string;
  sentAt: string;
  badges: TwitchBadge[];
  replyParentMessageId?: string;
  /** Set when the message arrived from another channel of a shared chat session. */
  sourceChannelId?: string;
  /** Internal diagnostics only; never handed to the model. */
  rawEvent?: unknown;
}

export type TwitchPlatformEventType = 'chat' | 'follow' | 'subscription' | 'gift_subscription' | 'resubscription' | 'cheer' | 'raid';

export interface TwitchPlatformEvent {
  id: string;
  platform: 'twitch';
  type: TwitchPlatformEventType;
  channelId: string;
  occurredAt: string;
  user?: TwitchIdentity;
  message?: string;
  amount?: { value: number; unit: 'bits' | 'months' | 'subs' | 'viewers' };
  /** EventSub subscription type, e.g. `channel.cheer`. */
  nativeType: string;
  /** Validated, trimmed fields specific to the type. Safe to show the agent. */
  data: Record<string, string | number | boolean | null>;
}

export type DecodedEvent =
  | { kind: 'chat'; chat: TwitchChatMessageEvent }
  | { kind: 'platform'; event: TwitchPlatformEvent };
