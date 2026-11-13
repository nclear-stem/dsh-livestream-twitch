import { describe, expect, it } from 'vitest';
import { EVENT_SCOPES, SCOPES } from '../../src/auth/scopes';
import { DEFAULT_CONFIG } from '../../src/config/schema';
import { decodeNotification, parseFrame, PLATFORM_DECODERS } from '../../src/twitch/eventsub/decoder';
import { planSubscriptions, SUBSCRIPTIONS } from '../../src/twitch/eventsub/subscriptionRegistry';
import { frames } from '../helpers';

function decode(frame: unknown) {
  const f = parseFrame(JSON.stringify(frame));
  if (f.type !== 'notification') throw new Error(`not a notification: ${f.type}`);
  return decodeNotification(f);
}

describe('chat decoding', () => {
  it('normalizes channel.chat.message', () => {
    const d = decode(frames.chat({ id: '2002', login: 'viewer' }, 'Hello chat', 'meta-1', {
      badges: [{ set_id: 'subscriber', id: '12', info: '16' }, { bad: true }],
      reply: { parent_message_id: 'parent-1', parent_user_id: '3' },
    }));
    expect(d.kind).toBe('chat');
    if (d.kind !== 'chat') return;
    expect(d.chat).toMatchObject({
      id: 'meta-1', chatMessageId: 'chat-meta-1', channelId: '1001', text: 'Hello chat',
      sender: { userId: '2002', login: 'viewer', displayName: 'VIEWER' },
      badges: [{ setId: 'subscriber', id: '12', info: '16' }], replyParentMessageId: 'parent-1',
    });
    expect(d.chat.sentAt).toBe('2026-11-10T01:02:03.123456789Z');
  });

  it('marks shared-chat messages from another channel', () => {
    const d = decode(frames.chat({ id: '2', login: 'v' }, 'x', 'm', { source_broadcaster_user_id: '777' }));
    expect(d.kind === 'chat' && d.chat.sourceChannelId).toBe('777');
  });

  it('reports a chat event missing required fields as invalid', () => {
    const f = frames.chat({ id: '2', login: 'v' }, 'x');
    delete (f.payload.event as Record<string, unknown>).chatter_user_id;
    expect(decode(f).kind).toBe('invalid');
  });

  it('reports unsupported types', () => {
    expect(decode(frames.notification('channel.poll.begin', {}))).toEqual({ kind: 'unsupported', type: 'channel.poll.begin' });
  });
});

describe('platform event decoding', () => {
  const base = { broadcaster_user_id: '1001', broadcaster_user_login: 'streamer', broadcaster_user_name: 'Streamer' };
  const user = { user_id: '5', user_login: 'fan', user_name: 'Fan' };

  it('follow', () => {
    const d = decode(frames.notification('channel.follow', { ...base, ...user, followed_at: '2026-01-01T00:00:00Z' }));
    expect(d).toMatchObject({ kind: 'platform', event: { type: 'follow', user: { userId: '5' }, occurredAt: '2026-01-01T00:00:00Z' } });
  });

  it('cheer keeps bits as bits and hides anonymous cheerers', () => {
    const named = decode(frames.notification('channel.cheer', { ...base, ...user, is_anonymous: false, bits: 100, message: 'Cheer100 hi' }));
    expect(named).toMatchObject({ event: { type: 'cheer', amount: { value: 100, unit: 'bits' }, message: 'Cheer100 hi' } });
    const anon = decode(frames.notification('channel.cheer', { ...base, user_id: null, is_anonymous: true, bits: 5 }));
    expect(anon.kind === 'platform' && anon.event.user).toBeUndefined();
  });

  it('subscription, gift and resub', () => {
    expect(decode(frames.notification('channel.subscribe', { ...base, ...user, tier: '1000', is_gift: false }))).toMatchObject({ event: { type: 'subscription', data: { tier: '1000' } } });
    expect(decode(frames.notification('channel.subscription.gift', { ...base, ...user, total: 5, tier: '1000', is_anonymous: false, cumulative_total: 20 }))).toMatchObject({ event: { type: 'gift_subscription', amount: { value: 5, unit: 'subs' } } });
    expect(decode(frames.notification('channel.subscription.message', { ...base, ...user, tier: '2000', message: { text: 'year two!' }, cumulative_months: 13, streak_months: 3 }))).toMatchObject({ event: { type: 'resubscription', amount: { value: 13, unit: 'months' }, message: 'year two!' } });
  });

  it('raid into this channel', () => {
    const d = decode(frames.notification('channel.raid', { from_broadcaster_user_id: '9', from_broadcaster_user_login: 'other', from_broadcaster_user_name: 'Other', to_broadcaster_user_id: '1001', to_broadcaster_user_login: 'streamer', to_broadcaster_user_name: 'Streamer', viewers: 42 }));
    expect(d).toMatchObject({ event: { type: 'raid', channelId: '1001', user: { login: 'other' }, amount: { value: 42, unit: 'viewers' } } });
  });
});

describe('subscription registry', () => {
  it('has a decoder for every registered type and pins versions in one place', () => {
    for (const def of SUBSCRIPTIONS) {
      if (def.type !== 'channel.chat.message') expect(PLATFORM_DECODERS[def.type], def.type).toBeTypeOf('function');
    }
    expect(SUBSCRIPTIONS.find((d) => d.type === 'channel.chat.message')?.version).toBe('1');
    expect(SUBSCRIPTIONS.find((d) => d.type === 'channel.follow')?.version).toBe('2');
    expect(SUBSCRIPTIONS.some((d) => d.type === 'channel.chat.notification')).toBe(false);
  });

  it('agrees with the scopes requested at authorization', () => {
    for (const def of SUBSCRIPTIONS) {
      if (def.key === 'chat') expect(def.scopes).toEqual([SCOPES.readChat]);
      else expect(def.scopes).toEqual(EVENT_SCOPES[def.key] ? [EVENT_SCOPES[def.key]] : []);
    }
  });

  it('chat condition uses the broadcaster as both broadcaster and reader', () => {
    const def = SUBSCRIPTIONS.find((d) => d.type === 'channel.chat.message')!;
    expect(def.condition({ userId: '1001', login: 's', displayName: 'S' })).toEqual({ broadcaster_user_id: '1001', user_id: '1001' });
  });

  it('disables only the events whose scope was not granted', () => {
    const cfg = { ...DEFAULT_CONFIG, events: { follow: true, subscription: true, cheer: true, raid: true } };
    const plan = planSubscriptions(cfg, ['user:read:chat', 'user:write:chat', 'bits:read']);
    expect(plan.enabled.map((d) => d.type)).toEqual(['channel.chat.message', 'channel.cheer', 'channel.raid']);
    expect(plan.disabled.map((d) => d.def.type)).toEqual(['channel.follow', 'channel.subscribe', 'channel.subscription.gift', 'channel.subscription.message']);
    expect(plan.disabled[0]!.reason).toMatch(/moderator:read:followers/);
  });

  it('default config subscribes to chat only', () => {
    expect(planSubscriptions(DEFAULT_CONFIG, ['user:read:chat']).enabled.map((d) => d.type)).toEqual(['channel.chat.message']);
  });
});
