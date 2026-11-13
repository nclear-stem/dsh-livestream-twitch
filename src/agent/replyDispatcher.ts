/**
 * Outgoing chat: one global serial queue in front of Helix Send Chat Message.
 *
 *  - dry-run: logged and counted, never sent
 *  - pacing: minimum interval between sends and a sliding 60 s cap
 *  - 429: wait until Ratelimit-Reset, retry (bounded); 502/503/504: backoff, retry (bounded)
 *  - anything else, and network errors whose outcome is unknown, are not retried, to avoid saying the
 *    same thing twice
 *  - a full queue drops the oldest waiting reply
 * Failures are returned as outcomes; nothing here throws into EventSub or the agent.
 */

import type { TwitchIdentity } from '../domain/user';
import type { Logger } from '../runtime/redact';
import type { StatusStore } from '../runtime/status';
import { sleep, type Timers } from '../runtime/timers';
import { clipChatMessage, type ChatSender } from '../twitch/chatClient';
import { HelixError } from '../twitch/helixClient';

export interface OutgoingReply {
  text: string;
  replyParentMessageId?: string;
  /** For logs: what this answers. */
  about: string;
}

export type SendOutcome =
  | { kind: 'sent'; messageId: string | null }
  | { kind: 'dry_run'; text: string }
  | { kind: 'dropped'; reason: string }
  | { kind: 'failed'; error: string; uncertain: boolean };

export interface ReplyDispatcherOptions {
  chat: ChatSender;
  broadcaster: () => TwitchIdentity | undefined;
  dryRun: () => boolean;
  sendEnabled: () => boolean;
  minIntervalMs: number;
  maxPerMinute: number;
  maxQueue?: number;
  maxRetries?: number;
  logger: Logger;
  status: StatusStore;
  timers: Timers;
}

interface Job {
  reply: OutgoingReply;
  resolve: (o: SendOutcome) => void;
}

const RETRYABLE = new Set([502, 503, 504]);

export class ReplyDispatcher {
  private readonly queue: Job[] = [];
  private running = false;
  private lastSentAt = -Infinity;
  private readonly window: number[] = [];
  private stopped = false;

  constructor(private readonly opts: ReplyDispatcherOptions) {}

  get pending(): number {
    return this.queue.length;
  }

  enqueue(reply: OutgoingReply): Promise<SendOutcome> {
    if (this.stopped) return Promise.resolve({ kind: 'dropped', reason: 'dispatcher stopped' });
    return new Promise((resolve) => {
      this.queue.push({ reply, resolve });
      const max = this.opts.maxQueue ?? 10;
      while (this.queue.length > max) {
        const old = this.queue.shift()!;
        this.opts.status.count('dropped');
        this.opts.logger.info(`reply dropped (outgoing queue full): ${old.reply.about}`);
        old.resolve({ kind: 'dropped', reason: 'outgoing queue full' });
      }
      void this.pump();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.queue.splice(0)) job.resolve({ kind: 'dropped', reason: 'dispatcher stopped' });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        job.resolve(await this.deliver(job.reply).catch((err: unknown) => ({ kind: 'failed', error: String((err as Error)?.message ?? err), uncertain: true } as const)));
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(reply: OutgoingReply): Promise<SendOutcome> {
    const text = clipChatMessage(reply.text);
    if (!text) return { kind: 'dropped', reason: 'empty reply' };
    const me = this.opts.broadcaster();
    if (this.opts.dryRun()) {
      this.opts.status.count('dryRunReplies');
      this.opts.logger.info(`[dry-run] would send to #${me?.login ?? '?'}${reply.replyParentMessageId ? ' (as reply)' : ''}: ${text}`);
      this.opts.status.note(`[dry-run] reply to ${reply.about}: ${text.slice(0, 120)}`);
      return { kind: 'dry_run', text };
    }
    if (!this.opts.sendEnabled()) return { kind: 'dropped', reason: 'chat.send is off' };
    if (!me) return { kind: 'failed', error: 'not authorized', uncertain: false };

    const maxRetries = this.opts.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      if (this.stopped) return { kind: 'dropped', reason: 'dispatcher stopped' };
      try {
        this.markSend();
        const result = await this.opts.chat.send({
          broadcasterId: me.userId, senderId: me.userId, message: text,
          ...(reply.replyParentMessageId ? { replyParentMessageId: reply.replyParentMessageId } : {}),
        });
        if (!result.isSent) {
          const reason = result.dropReason ? `${result.dropReason.code}: ${result.dropReason.message}` : 'not sent';
          this.opts.status.count('sendFailures');
          this.opts.logger.info(`Twitch dropped the reply to ${reply.about} (${reason})`);
          return { kind: 'dropped', reason: `Twitch dropped it (${reason})` };
        }
        this.opts.status.count('sent');
        this.opts.status.note(`sent reply to ${reply.about}: ${text.slice(0, 120)}`);
        return { kind: 'sent', messageId: result.messageId };
      } catch (err) {
        const status = err instanceof HelixError ? err.status : 0;
        const retryable = status === 429 || RETRYABLE.has(status);
        if (retryable && attempt < maxRetries) {
          const wait = status === 429 && err instanceof HelixError && err.retryAt
            ? Math.max(1000, err.retryAt - this.opts.timers.now())
            : 1000 * 2 ** attempt;
          this.opts.logger.warn(`send got HTTP ${status}; retrying in ${Math.round(wait / 1000)}s (${attempt + 1}/${maxRetries})`);
          await sleep(this.opts.timers, Math.min(wait, 60_000));
          continue;
        }
        this.opts.status.count('sendFailures');
        const message = (err as Error).message;
        this.opts.status.error(`reply to ${reply.about} failed: ${message}`);
        // no HTTP status = request may or may not have reached Twitch; do not resend
        return { kind: 'failed', error: message, uncertain: status === 0 || status >= 500 };
      }
    }
  }

  private markSend(): void {
    const t = this.opts.timers.now();
    this.lastSentAt = t;
    this.window.push(t);
  }

  /** Wait for both the minimum interval and the per-minute window. */
  private async pace(): Promise<void> {
    for (;;) {
      const t = this.opts.timers.now();
      while (this.window.length && t - this.window[0]! >= 60_000) this.window.shift();
      const byInterval = this.lastSentAt + this.opts.minIntervalMs - t;
      const byWindow = this.window.length >= this.opts.maxPerMinute ? this.window[0]! + 60_000 - t : 0;
      const wait = Math.max(byInterval, byWindow);
      if (wait <= 0) return;
      await sleep(this.opts.timers, wait);
    }
  }
}
