import { describe, expect, it } from 'vitest';
import type { EventSubState } from '../../src/runtime/status';
import { EventSubSession, type NotificationFrame, type RevocationFrame } from '../../src/twitch/eventsub/sessionManager';
import { ReconnectManager } from '../../src/twitch/eventsub/reconnectManager';
import { FakeSocket, frames, ManualTimers, memoryLogger } from '../helpers';

function harness(opts: { subscribe?: (id: string) => Promise<void> } = {}) {
  const timers = new ManualTimers();
  const sockets: FakeSocket[] = [];
  const subscribed: string[] = [];
  const notes: NotificationFrame[] = [];
  const revoked: RevocationFrame[] = [];
  const states: EventSubState[] = [];
  const dups: string[] = [];
  const { logger, lines } = memoryLogger();
  const session = new EventSubSession({
    socketFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    logger, timers,
    reconnect: new ReconnectManager(timers, { random: () => 0 }),
    handlers: {
      subscribe: opts.subscribe ?? (async (id) => { subscribed.push(id); }),
      notification: (f) => notes.push(f),
      revocation: (f) => revoked.push(f),
      state: (s) => states.push(s),
      duplicate: (id) => dups.push(id),
    },
  });
  return { session, timers, sockets, subscribed, notes, revoked, states, dups, lines };
}

const viewer = { id: '2002', login: 'viewer' };

describe('EventSub session', () => {
  it('subscribes with the session id from session_welcome', async () => {
    const h = harness();
    h.session.start();
    expect(h.sockets[0]!.url).toBe('wss://eventsub.wss.twitch.tv/ws');
    h.sockets[0]!.server(frames.welcome('S1'));
    await h.timers.flush();
    expect(h.subscribed).toEqual(['S1']);
    expect(h.states.at(-1)).toBe('connected');
  });

  it('keepalives keep the connection; silence past the keepalive timeout reconnects and resubscribes', async () => {
    const h = harness();
    h.session.start();
    h.sockets[0]!.server(frames.welcome('S1', 10));
    await h.timers.advance(9_000);
    h.sockets[0]!.server(frames.keepalive());
    await h.timers.advance(9_000);
    expect(h.sockets[0]!.closed).toBeNull();
    await h.timers.advance(7_000); // 16 s without traffic > 10 s + 5 s grace
    expect(h.sockets[0]!.closed).not.toBeNull();
    await h.timers.advance(2_000); // backoff
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.server(frames.welcome('S2'));
    await h.timers.flush();
    expect(h.subscribed).toEqual(['S1', 'S2']);
  });

  it('an ordinary close reconnects to the default URL with backoff and resubscribes', async () => {
    const h = harness();
    h.session.start();
    h.sockets[0]!.server(frames.welcome('S1'));
    await h.timers.flush();
    h.sockets[0]!.drop(4006, 'network error');
    expect(h.states).toContain('reconnecting');
    await h.timers.advance(1_000);
    expect(h.sockets[1]!.url).toBe('wss://eventsub.wss.twitch.tv/ws');
    h.sockets[1]!.server(frames.welcome('S2'));
    await h.timers.flush();
    expect(h.subscribed).toEqual(['S1', 'S2']);
  });

  it('session_reconnect migrates: opens reconnect_url, keeps the old socket until the new welcome, no resubscribe', async () => {
    const h = harness();
    h.session.start();
    h.sockets[0]!.server(frames.welcome('S1'));
    await h.timers.flush();
    h.sockets[0]!.server(frames.reconnect('wss://edge2.example/ws?x=1'));
    expect(h.sockets[1]!.url).toBe('wss://edge2.example/ws?x=1');
    // old socket still delivers until the new one is welcomed
    h.sockets[0]!.server(frames.chat(viewer, 'still here', 'm-1'));
    expect(h.notes).toHaveLength(1);
    expect(h.sockets[0]!.closed).toBeNull();
    h.sockets[1]!.server(frames.welcome('S1'));
    await h.timers.flush();
    expect(h.sockets[0]!.closed).not.toBeNull();
    expect(h.subscribed).toEqual(['S1']);
    expect(h.session.sessionId).toBe('S1');
    // the old socket's close is not treated as a lost connection
    await h.timers.advance(5_000);
    expect(h.sockets).toHaveLength(2);
  });

  it('a duplicate message_id (also across old and new sockets) is processed once', async () => {
    const h = harness();
    h.session.start();
    h.sockets[0]!.server(frames.welcome('S1'));
    await h.timers.flush();
    h.sockets[0]!.server(frames.chat(viewer, 'hi', 'same-id'));
    h.sockets[0]!.server(frames.chat(viewer, 'hi', 'same-id'));
    h.sockets[0]!.server(frames.reconnect('wss://edge2/ws'));
    h.sockets[1]!.server(frames.welcome('S1'));
    h.sockets[1]!.server(frames.chat(viewer, 'hi', 'same-id'));
    expect(h.notes).toHaveLength(1);
    expect(h.dups).toEqual(['same-id', 'same-id']);
  });

  it('revocation is handed to the handler', async () => {
    const h = harness();
    h.session.start();
    h.sockets[0]!.server(frames.welcome('S1'));
    h.sockets[0]!.server(frames.revocation('channel.chat.message', 'authorization_revoked'));
    expect(h.revoked[0]!.subscription.status).toBe('authorization_revoked');
  });

  it('malformed and unknown frames are ignored without crashing', async () => {
    const h = harness();
    h.session.start();
    h.sockets[0]!.server('not json');
    h.sockets[0]!.server({ metadata: { message_id: 'x' } });
    h.sockets[0]!.server({ metadata: { message_id: 'y', message_type: 'brand_new_type' }, payload: {} });
    h.sockets[0]!.server(frames.welcome('S1'));
    await h.timers.flush();
    expect(h.subscribed).toEqual(['S1']);
    expect(h.lines.some((l) => l.message.includes('malformed'))).toBe(true);
    expect(h.lines.some((l) => l.message.includes('brand_new_type'))).toBe(true);
  });

  it('a failed subscription closes the session and retries later instead of hanging', async () => {
    let n = 0;
    const h = harness({ subscribe: async () => { if (++n === 1) throw new Error('HTTP 503'); } });
    h.session.start();
    h.sockets[0]!.server(frames.welcome('S1'));
    await h.timers.flush();
    expect(h.sockets[0]!.closed).not.toBeNull();
    expect(h.states).toContain('failed');
    await h.timers.advance(1_000);
    h.sockets[1]!.server(frames.welcome('S2'));
    await h.timers.flush();
    expect(h.states.at(-1)).toBe('connected');
  });

  it('no welcome within the window reconnects', async () => {
    const h = harness();
    h.session.start();
    await h.timers.advance(15_000);
    expect(h.sockets[0]!.closed).not.toBeNull();
    await h.timers.advance(1_000);
    expect(h.sockets).toHaveLength(2);
  });

  it('stop closes everything and does not reconnect', async () => {
    const h = harness();
    h.session.start();
    h.sockets[0]!.server(frames.welcome('S1'));
    await h.timers.flush();
    h.session.stop();
    await h.timers.advance(120_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.states.at(-1)).toBe('stopped');
  });
});

describe('ReconnectManager', () => {
  it('backs off exponentially up to the cap and resets', () => {
    const t = new ManualTimers();
    const r = new ReconnectManager(t, { baseMs: 1000, maxMs: 8000, random: () => 1 });
    expect([r.nextDelay(), r.nextDelay(), r.nextDelay(), r.nextDelay(), r.nextDelay()]).toEqual([1000, 2000, 4000, 8000, 8000]);
    r.reset();
    expect(r.nextDelay()).toBe(1000);
  });
});
