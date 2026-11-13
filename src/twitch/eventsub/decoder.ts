/**
 * EventSub WebSocket frame parsing and per-type event decoding. Everything from the wire is `unknown` until a
 * field is checked here; malformed input yields an `invalid` result, never an exception.
 */

import type { DecodedEvent, TwitchBadge, TwitchChatMessageEvent, TwitchPlatformEvent } from '../../domain/events';
import type { TwitchIdentity } from '../../domain/user';

export interface FrameMetadata {
  messageId: string;
  messageType: string;
  messageTimestamp: string;
  subscriptionType?: string;
  subscriptionVersion?: string;
}

export type Frame =
  | { type: 'session_welcome' | 'session_reconnect'; meta: FrameMetadata; session: { id: string; keepaliveTimeoutSeconds: number | null; reconnectUrl: string | null } }
  | { type: 'session_keepalive'; meta: FrameMetadata }
  | { type: 'notification'; meta: FrameMetadata; subscription: { id: string; type: string; version: string }; event: Record<string, unknown> }
  | { type: 'revocation'; meta: FrameMetadata; subscription: { id: string; type: string; version: string; status: string } }
  | { type: 'unknown'; meta: FrameMetadata }
  | { type: 'invalid'; reason: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export function parseFrame(raw: string): Frame {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { type: 'invalid', reason: 'not JSON' };
  }
  const m = obj(obj(data)?.metadata);
  const payload = obj(obj(data)?.payload) ?? {};
  const messageId = str(m?.message_id), messageType = str(m?.message_type);
  if (!m || !messageId || !messageType) return { type: 'invalid', reason: 'missing metadata.message_id or message_type' };
  const meta: FrameMetadata = {
    messageId, messageType, messageTimestamp: str(m.message_timestamp) ?? '',
    ...(str(m.subscription_type) ? { subscriptionType: str(m.subscription_type)! } : {}),
    ...(str(m.subscription_version) ? { subscriptionVersion: str(m.subscription_version)! } : {}),
  };
  switch (messageType) {
    case 'session_welcome':
    case 'session_reconnect': {
      const s = obj(payload.session);
      const id = str(s?.id);
      if (!s || !id) return { type: 'invalid', reason: `${messageType} without session.id` };
      const keepalive = typeof s.keepalive_timeout_seconds === 'number' ? s.keepalive_timeout_seconds : null;
      const reconnectUrl = str(s.reconnect_url) ?? null;
      if (messageType === 'session_reconnect' && !reconnectUrl) return { type: 'invalid', reason: 'session_reconnect without reconnect_url' };
      return { type: messageType, meta, session: { id, keepaliveTimeoutSeconds: keepalive, reconnectUrl } };
    }
    case 'session_keepalive':
      return { type: 'session_keepalive', meta };
    case 'notification': {
      const sub = obj(payload.subscription), event = obj(payload.event);
      const type = str(sub?.type), id = str(sub?.id);
      if (!sub || !type || !id || !event) return { type: 'invalid', reason: 'notification without subscription.type or event' };
      return { type: 'notification', meta, subscription: { id, type, version: str(sub.version) ?? '' }, event };
    }
    case 'revocation': {
      const sub = obj(payload.subscription);
      const type = str(sub?.type), id = str(sub?.id);
      if (!sub || !type || !id) return { type: 'invalid', reason: 'revocation without subscription' };
      return { type: 'revocation', meta, subscription: { id, type, version: str(sub.version) ?? '', status: str(sub.status) ?? 'unknown' } };
    }
    default:
      return { type: 'unknown', meta };
  }
}

export type DecodeResult = DecodedEvent | { kind: 'invalid'; reason: string } | { kind: 'unsupported'; type: string };

const MAX_TEXT = 1000;
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

function identity(e: Record<string, unknown>, prefix: string): TwitchIdentity | undefined {
  const userId = str(e[`${prefix}_id`]);
  if (!userId) return undefined;
  const login = str(e[`${prefix}_login`]) ?? '';
  return { userId, login, displayName: str(e[`${prefix}_name`]) || login };
}

function badges(raw: unknown): TwitchBadge[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((b) => {
    const o = obj(b);
    const setId = str(o?.set_id), id = str(o?.id);
    return setId && id !== undefined ? [{ setId, id, info: str(o?.info) ?? '' }] : [];
  });
}

export function decodeChatMessage(messageId: string, timestamp: string, e: Record<string, unknown>): DecodeResult {
  const channelId = str(e.broadcaster_user_id);
  const sender = identity(e, 'chatter_user');
  const chatMessageId = str(e.message_id);
  const text = str(obj(e.message)?.text);
  if (!channelId || !sender || !chatMessageId || text === undefined) return { kind: 'invalid', reason: 'channel.chat.message missing broadcaster, chatter, message_id or text' };
  const parent = str(obj(e.reply)?.parent_message_id);
  const source = str(e.source_broadcaster_user_id);
  const chat: TwitchChatMessageEvent = {
    id: messageId, chatMessageId, channelId, sender, text: clip(text), sentAt: timestamp, badges: badges(e.badges),
    ...(parent ? { replyParentMessageId: parent } : {}),
    ...(source && source !== channelId ? { sourceChannelId: source } : {}),
    rawEvent: e,
  };
  return { kind: 'chat', chat };
}

function platform(base: Omit<TwitchPlatformEvent, 'platform'>): DecodeResult {
  return { kind: 'platform', event: { platform: 'twitch', ...base } };
}

type PlatformDecoder = (messageId: string, timestamp: string, e: Record<string, unknown>) => DecodeResult;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const PLATFORM_DECODERS: Record<string, PlatformDecoder> = {
  'channel.follow': (id, ts, e) => {
    const channelId = str(e.broadcaster_user_id), user = identity(e, 'user');
    if (!channelId || !user) return { kind: 'invalid', reason: 'channel.follow missing user or broadcaster' };
    return platform({ id, type: 'follow', channelId, occurredAt: str(e.followed_at) ?? ts, user, nativeType: 'channel.follow', data: {} });
  },
  'channel.subscribe': (id, ts, e) => {
    const channelId = str(e.broadcaster_user_id), user = identity(e, 'user');
    if (!channelId || !user) return { kind: 'invalid', reason: 'channel.subscribe missing user or broadcaster' };
    return platform({ id, type: 'subscription', channelId, occurredAt: ts, user, nativeType: 'channel.subscribe', data: { tier: str(e.tier) ?? '', isGift: e.is_gift === true } });
  },
  'channel.subscription.gift': (id, ts, e) => {
    const channelId = str(e.broadcaster_user_id), total = num(e.total);
    if (!channelId || total === undefined) return { kind: 'invalid', reason: 'channel.subscription.gift missing broadcaster or total' };
    const anonymous = e.is_anonymous === true;
    const user = anonymous ? undefined : identity(e, 'user');
    return platform({
      id, type: 'gift_subscription', channelId, occurredAt: ts, ...(user ? { user } : {}), amount: { value: total, unit: 'subs' }, nativeType: 'channel.subscription.gift',
      data: { tier: str(e.tier) ?? '', anonymous, cumulativeTotal: num(e.cumulative_total) ?? null },
    });
  },
  'channel.subscription.message': (id, ts, e) => {
    const channelId = str(e.broadcaster_user_id), user = identity(e, 'user');
    if (!channelId || !user) return { kind: 'invalid', reason: 'channel.subscription.message missing user or broadcaster' };
    const months = num(e.cumulative_months) ?? 0;
    const text = str(obj(e.message)?.text);
    return platform({
      id, type: 'resubscription', channelId, occurredAt: ts, user, ...(text ? { message: clip(text) } : {}), amount: { value: months, unit: 'months' }, nativeType: 'channel.subscription.message',
      data: { tier: str(e.tier) ?? '', streakMonths: num(e.streak_months) ?? null, durationMonths: num(e.duration_months) ?? null },
    });
  },
  'channel.cheer': (id, ts, e) => {
    const channelId = str(e.broadcaster_user_id), bits = num(e.bits);
    if (!channelId || bits === undefined) return { kind: 'invalid', reason: 'channel.cheer missing broadcaster or bits' };
    const anonymous = e.is_anonymous === true;
    const user = anonymous ? undefined : identity(e, 'user');
    const text = str(e.message);
    return platform({ id, type: 'cheer', channelId, occurredAt: ts, ...(user ? { user } : {}), ...(text ? { message: clip(text) } : {}), amount: { value: bits, unit: 'bits' }, nativeType: 'channel.cheer', data: { anonymous } });
  },
  'channel.raid': (id, ts, e) => {
    const channelId = str(e.to_broadcaster_user_id), from = identity(e, 'from_broadcaster_user'), viewers = num(e.viewers);
    if (!channelId || !from || viewers === undefined) return { kind: 'invalid', reason: 'channel.raid missing to/from broadcaster or viewers' };
    return platform({ id, type: 'raid', channelId, occurredAt: ts, user: from, amount: { value: viewers, unit: 'viewers' }, nativeType: 'channel.raid', data: {} });
  },
};

export function decodeNotification(frame: Extract<Frame, { type: 'notification' }>): DecodeResult {
  const { messageId, messageTimestamp } = frame.meta;
  if (frame.subscription.type === 'channel.chat.message') return decodeChatMessage(messageId, messageTimestamp, frame.event);
  const decoder = PLATFORM_DECODERS[frame.subscription.type];
  return decoder ? decoder(messageId, messageTimestamp, frame.event) : { kind: 'unsupported', type: frame.subscription.type };
}
