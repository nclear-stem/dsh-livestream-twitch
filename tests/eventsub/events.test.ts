import { describe, expect, it } from 'vitest';
import type { AgentPort } from '../../src/agent/agentPort';
import { frames } from '../helpers';
import { connectedHarness } from '../harness';

const ALL_EVENTS = { follow: true, subscription: true, cheer: true, raid: true };
const ALL_SCOPES = ['user:read:chat', 'user:write:chat', 'moderator:read:followers', 'channel:read:subscriptions', 'bits:read'];

function withAgent(scopes: string[]) {
  const prompts: string[] = [];
  const port: AgentPort = { available: () => true, deliver: async (_s, text) => { prompts.push(text); return { text: 'thanks!', turnCompleted: true }; } };
  const h = connectedHarness({ events: ALL_EVENTS, chat: { autoReply: true, dryRun: false } }, scopes, {}, { agentPort: port, boundSessionId: 'session-abc' });
  return { ...h, prompts };
}

async function connect(h: ReturnType<typeof withAgent>) {
  await h.sup.boot();
  await h.sup.connect();
  h.sockets[0]!.server(frames.welcome('S'));
  await h.timers.flush();
}

describe('follow / subscription / bits / raid', () => {
  it('subscribes every enabled event with its registry version and condition', async () => {
    const h = withAgent(ALL_SCOPES);
    await connect(h);
    const bodies = h.f.calls.filter((c) => c.url.endsWith('/eventsub/subscriptions')).map((c) => JSON.parse(c.body) as { type: string; version: string; condition: unknown });
    expect(bodies.map((b) => `${b.type}@${b.version}`)).toEqual([
      'channel.chat.message@1', 'channel.follow@2', 'channel.subscribe@1', 'channel.subscription.gift@1', 'channel.subscription.message@1', 'channel.cheer@1', 'channel.raid@1',
    ]);
    expect(bodies.find((b) => b.type === 'channel.follow')!.condition).toEqual({ broadcaster_user_id: '1001', moderator_user_id: '1001' });
    expect(bodies.find((b) => b.type === 'channel.raid')!.condition).toEqual({ to_broadcaster_user_id: '1001' });
  });

  it('authorized events reach the agent through the same internal stream as chat', async () => {
    const h = withAgent(ALL_SCOPES);
    await connect(h);
    const base = { broadcaster_user_id: '1001', broadcaster_user_login: 'streamer', broadcaster_user_name: 'Streamer' };
    h.sockets[0]!.server(frames.notification('channel.cheer', { ...base, user_id: '5', user_login: 'fan', user_name: 'Fan', is_anonymous: false, bits: 250, message: 'Cheer250 great stream' }));
    h.sockets[0]!.server(frames.notification('channel.follow', { ...base, user_id: '6', user_login: 'newbie', user_name: 'Newbie', followed_at: '2026-11-10T00:00:00Z' }));
    h.sockets[0]!.server(frames.notification('channel.raid', { from_broadcaster_user_id: '7', from_broadcaster_user_login: 'friend', from_broadcaster_user_name: 'Friend', to_broadcaster_user_id: '1001', to_broadcaster_user_login: 'streamer', to_broadcaster_user_name: 'Streamer', viewers: 30 }));
    await h.timers.advance(30_000);
    expect(h.prompts).toHaveLength(3);
    expect(h.prompts[0]).toContain('Fan cheered 250 bits.');
    expect(h.prompts[0]).toContain('Cheer250 great stream');
    expect(h.prompts[0]).not.toMatch(/\$|USD|yuan/i);
    expect(h.prompts[1]).toContain('Newbie followed the channel.');
    expect(h.prompts[2]).toContain('raided the channel with 30 viewers');
    // event replies are not threaded to a chat message
    const sends = h.f.calls.filter((c) => c.url.endsWith('/chat/messages')).map((c) => JSON.parse(c.body));
    expect(sends).toHaveLength(3);
    expect(sends.every((b) => !('reply_parent_message_id' in b))).toBe(true);
  });

  it('without the extra scopes only those events are off; chat still works', async () => {
    const h = withAgent(['user:read:chat', 'user:write:chat']);
    await connect(h);
    const s = h.runtime.status.snapshot().eventsub;
    expect(s.state).toBe('connected');
    expect(s.subscriptions.filter((x) => x.state === 'enabled').map((x) => x.type)).toEqual(['channel.chat.message', 'channel.raid']);
    expect(s.subscriptions.filter((x) => x.state === 'disabled').map((x) => x.type)).toEqual(['channel.follow', 'channel.subscribe', 'channel.subscription.gift', 'channel.subscription.message', 'channel.cheer']);
    h.sockets[0]!.server(frames.chat({ id: '2002', login: 'viewer' }, 'still chatting'));
    await h.timers.advance(5_000);
    expect(h.prompts).toHaveLength(1);
  });
});
