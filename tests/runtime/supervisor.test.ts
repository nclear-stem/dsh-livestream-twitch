import { describe, expect, it } from 'vitest';
import type { DecodedEvent } from '../../src/domain/events';
import { FAKE, frames, json } from '../helpers';
import { connectedHarness } from '../harness';

describe('supervisor: EventSub chat receive', () => {
  it('connect subscribes channel.chat.message v1 with the broadcaster as broadcaster and reader', async () => {
    const h = connectedHarness();
    await h.sup.boot();
    await h.sup.connect();
    h.sockets[0]!.server(frames.welcome('SESSION'));
    await h.timers.flush();
    const sub = h.f.calls.find((c) => c.url.endsWith('/eventsub/subscriptions'))!;
    expect(JSON.parse(sub.body)).toEqual({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '1001', user_id: '1001' }, transport: { method: 'websocket', session_id: 'SESSION' } });
    expect(sub.headers.authorization).toBe(`Bearer ${FAKE.access}`);
    expect(h.runtime.status.snapshot().eventsub).toMatchObject({ state: 'connected', subscriptions: [{ type: 'channel.chat.message', state: 'enabled' }] });
  });

  it('delivers decoded chat to the sink and ignores events for another channel', async () => {
    const h = connectedHarness();
    const got: DecodedEvent[] = [];
    h.sup.setEventSink((e) => got.push(e));
    await h.sup.boot();
    await h.sup.connect();
    h.sockets[0]!.server(frames.welcome('S'));
    await h.timers.flush();
    h.sockets[0]!.server(frames.chat({ id: '2002', login: 'viewer' }, 'hello'));
    const other = frames.chat({ id: '2002', login: 'viewer' }, 'elsewhere');
    (other.payload.event as Record<string, unknown>).broadcaster_user_id = '9999';
    h.sockets[0]!.server(other);
    expect(got).toHaveLength(1);
    expect(got[0]!.kind === 'chat' && got[0]!.chat.text).toBe('hello');
  });

  it('refuses to connect without authorization or without the chat scope', async () => {
    const none = connectedHarness();
    none.store.grant = undefined;
    await none.sup.boot();
    await expect(none.sup.connect()).rejects.toThrow(/run \/twitch auth/);
    const noScope = connectedHarness({}, ['user:write:chat']);
    await noScope.sup.boot();
    await expect(noScope.sup.connect()).rejects.toThrow(/user:read:chat/);
  });

  it('optional event subscription failure leaves chat running', async () => {
    const h = connectedHarness({ events: { follow: true, subscription: false, cheer: false, raid: false } }, ['user:read:chat', 'user:write:chat', 'moderator:read:followers'], {
      'POST https://api.twitch.tv/helix/eventsub/subscriptions': (c) => (JSON.parse(c.body).type === 'channel.follow' ? json({ message: 'subscription missing proper authorization' }, 403) : json({}, 202)),
    });
    await h.sup.boot();
    await h.sup.connect();
    h.sockets[0]!.server(frames.welcome('S'));
    await h.timers.flush();
    const s = h.runtime.status.snapshot().eventsub;
    expect(s.state).toBe('connected');
    expect(s.subscriptions.find((x) => x.type === 'channel.follow')?.state).toBe('failed');
  });

  it('stops EventSub when the authorization is revoked', async () => {
    const h = connectedHarness({}, undefined, {
      'GET https://id.twitch.tv/oauth2/validate': (() => { let n = 0; return () => (++n === 1 ? json({ client_id: FAKE.clientId, login: 'streamer', user_id: '1001', scopes: ['user:read:chat', 'user:write:chat'], expires_in: 9 }) : json({ status: 401, message: 'invalid access token' }, 401)); })(),
      'POST https://id.twitch.tv/oauth2/token': () => json({ status: 400, message: 'Invalid refresh token' }, 400),
    });
    await h.sup.boot();
    await h.sup.connect();
    h.sockets[0]!.server(frames.welcome('S'));
    await h.timers.flush();
    h.sockets[0]!.server(frames.revocation('channel.chat.message', 'authorization_revoked'));
    await h.timers.flush();
    expect(h.sup.tokens.authState).toBe('reauthorization_required');
    expect(h.sockets[0]!.closed).not.toBeNull();
    expect(h.runtime.status.snapshot().eventsub.state).toBe('stopped');
  });
});
