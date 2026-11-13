import { describe, expect, it } from 'vitest';
import { ReplyDispatcher } from '../../src/agent/replyDispatcher';
import { StatusStore } from '../../src/runtime/status';
import { clipChatMessage, HelixChatClient, type SendChatRequest, type SendChatResult } from '../../src/twitch/chatClient';
import { HelixClient, HelixError } from '../../src/twitch/helixClient';
import { fakeFetch, json, ManualTimers, memoryLogger } from '../helpers';

const ME = { userId: '1001', login: 'streamer', displayName: 'Streamer' };

function dispatcher(send: (r: SendChatRequest) => Promise<SendChatResult>, opts: { dryRun?: boolean; minIntervalMs?: number; maxPerMinute?: number; maxQueue?: number } = {}) {
  const timers = new ManualTimers();
  const status = new StatusStore();
  const sent: SendChatRequest[] = [];
  const d = new ReplyDispatcher({
    chat: { send: async (r) => { sent.push(r); return send(r); } },
    broadcaster: () => ME, dryRun: () => opts.dryRun ?? false, sendEnabled: () => true,
    minIntervalMs: opts.minIntervalMs ?? 0, maxPerMinute: opts.maxPerMinute ?? 100, maxQueue: opts.maxQueue ?? 10,
    logger: memoryLogger().logger, status, timers,
  });
  return { d, timers, status, sent };
}

const ok = async (): Promise<SendChatResult> => ({ messageId: 'm', isSent: true });

describe('Helix send chat', () => {
  it('posts broadcaster_id = sender_id = broadcaster, with reply parent, through the token wrapper', async () => {
    const f = fakeFetch({ 'POST https://api.twitch.tv/helix/chat/messages': () => json({ data: [{ message_id: 'abc', is_sent: true }] }) });
    const helix = new HelixClient({ withToken: (call) => call({ accessToken: 'tok', clientId: 'cid' }) }, f);
    const r = await new HelixChatClient(helix).send({ broadcasterId: '1001', senderId: '1001', message: 'hi', replyParentMessageId: 'p1' });
    expect(r).toEqual({ messageId: 'abc', isSent: true });
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ broadcaster_id: '1001', sender_id: '1001', message: 'hi', reply_parent_message_id: 'p1' });
    expect(f.calls[0]!.headers.authorization).toBe('Bearer tok');
    expect(f.calls[0]!.headers['client-id']).toBe('cid');
  });

  it('turns 429 into a HelixError carrying Ratelimit-Reset', async () => {
    const f = fakeFetch({ 'POST https://api.twitch.tv/helix/chat/messages': () => json({ message: 'Too Many Requests' }, 429, { 'Ratelimit-Reset': '1700000060' }) });
    const helix = new HelixClient({ withToken: (call) => call({ accessToken: 't', clientId: 'c' }) }, f);
    const err = await helix.request('POST', '/chat/messages', { body: {} }).catch((e: HelixError) => e);
    expect(err).toBeInstanceOf(HelixError);
    expect((err as HelixError).retryAt).toBe(1_700_000_060_000);
  });

  it('clips to 500 characters without splitting emoji', () => {
    const out = clipChatMessage('😀'.repeat(600));
    expect([...out]).toHaveLength(500);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('ReplyDispatcher', () => {
  it('dry-run never calls the send API', async () => {
    const { d, sent, status } = dispatcher(ok, { dryRun: true });
    expect(await d.enqueue({ text: 'hello', about: 'x' })).toEqual({ kind: 'dry_run', text: 'hello' });
    expect(sent).toHaveLength(0);
    expect(status.snapshot().bridge.dryRunReplies).toBe(1);
  });

  it('sends with the broadcaster as both broadcaster and sender, and the reply parent', async () => {
    const { d, sent } = dispatcher(ok);
    await d.enqueue({ text: 'hi', replyParentMessageId: 'p', about: 'x' });
    expect(sent[0]).toEqual({ broadcasterId: '1001', senderId: '1001', message: 'hi', replyParentMessageId: 'p' });
  });

  it('keeps the minimum interval between sends', async () => {
    const { d, timers, sent } = dispatcher(ok, { minIntervalMs: 3000 });
    const a = d.enqueue({ text: 'a', about: 'a' }), b = d.enqueue({ text: 'b', about: 'b' });
    await timers.flush();
    expect(sent).toHaveLength(1);
    await timers.advance(2999);
    expect(sent).toHaveLength(1);
    await timers.advance(1);
    await Promise.all([a, b]);
    expect(sent.map((s) => s.message)).toEqual(['a', 'b']);
  });

  it('caps sends per minute', async () => {
    const { d, timers, sent } = dispatcher(ok, { maxPerMinute: 2, maxQueue: 5 });
    for (const t of ['1', '2', '3']) void d.enqueue({ text: t, about: t });
    await timers.advance(59_000);
    expect(sent).toHaveLength(2);
    await timers.advance(1_000);
    expect(sent).toHaveLength(3);
  });

  it('waits for Ratelimit-Reset on 429 and retries a bounded number of times', async () => {
    let n = 0;
    const { d, timers, sent } = dispatcher(async () => {
      n++;
      throw new HelixError(429, 'Too Many Requests', timers.now() + 5000);
    });
    const p = d.enqueue({ text: 'x', about: 'x' });
    await timers.advance(60_000);
    const out = await p;
    expect(out.kind).toBe('failed');
    expect(sent).toHaveLength(3); // 1 + 2 retries
    expect(n).toBe(3);
  });

  it('retries 503 with backoff but not 400/422, and never a network error of unknown outcome', async () => {
    let n = 0;
    const flaky = dispatcher(async () => { if (++n < 2) throw new HelixError(503, 'unavailable'); return { messageId: 'ok', isSent: true }; });
    const p = flaky.d.enqueue({ text: 'x', about: 'x' });
    await flaky.timers.advance(5_000);
    expect(await p).toEqual({ kind: 'sent', messageId: 'ok' });

    const bad = dispatcher(async () => { throw new HelixError(422, 'message too large'); });
    expect(await bad.d.enqueue({ text: 'x', about: 'x' })).toMatchObject({ kind: 'failed', uncertain: false });
    expect(bad.sent).toHaveLength(1);

    const net = dispatcher(async () => { throw new TypeError('fetch failed'); });
    expect(await net.d.enqueue({ text: 'x', about: 'x' })).toMatchObject({ kind: 'failed', uncertain: true });
    expect(net.sent).toHaveLength(1);
  });

  it('reports a message Twitch dropped (automod etc.) without retrying', async () => {
    const { d, sent } = dispatcher(async () => ({ messageId: '', isSent: false, dropReason: { code: 'msg_rejected', message: 'automod' } }));
    expect(await d.enqueue({ text: 'x', about: 'x' })).toMatchObject({ kind: 'dropped' });
    expect(sent).toHaveLength(1);
  });

  it('drops the oldest waiting reply when the queue is full', async () => {
    const { d, timers } = dispatcher(ok, { minIntervalMs: 10_000, maxQueue: 2 });
    const results = ['a', 'b', 'c', 'd'].map((t) => d.enqueue({ text: t, about: t }));
    await timers.advance(60_000);
    const out = await Promise.all(results);
    expect(out.map((o) => o.kind)).toEqual(['sent', 'dropped', 'sent', 'sent']);
  });
});
