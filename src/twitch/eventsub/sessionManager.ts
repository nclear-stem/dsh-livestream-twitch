/**
 * One EventSub WebSocket session, following https://dev.twitch.tv/docs/eventsub/handling-websocket-events/:
 *
 *  - connect -> session_welcome -> `subscribe(sessionId)` (must happen within ~10 s of welcome)
 *  - keepalive watchdog: no notification/keepalive for keepalive_timeout_seconds (+ grace) = connection lost
 *  - session_reconnect: open reconnect_url as-is while the old socket keeps delivering; when the new socket
 *    says welcome, close the old one. Subscriptions carry over, so no resubscribe.
 *  - ordinary close / error / watchdog: backoff, fresh connection to the default URL, resubscribe
 *    (events in the gap are not replayed by Twitch).
 *  - notifications are deduplicated by metadata.message_id across old and new sockets.
 */

import { TWITCH_ENDPOINTS, TWITCH_LIMITS } from '../../config/defaults';
import type { Logger } from '../../runtime/redact';
import type { EventSubState } from '../../runtime/status';
import type { Timers } from '../../runtime/timers';
import { TtlDedupe } from './dedupe';
import { parseFrame, type Frame } from './decoder';
import { ReconnectManager } from './reconnectManager';
import type { SocketFactory, SocketLike } from './websocketClient';

export type NotificationFrame = Extract<Frame, { type: 'notification' }>;
export type RevocationFrame = Extract<Frame, { type: 'revocation' }>;

export interface EventSubHandlers {
  /** Create subscriptions on a fresh session. Throwing makes the session fail and retry later. */
  subscribe(sessionId: string): Promise<void>;
  notification(frame: NotificationFrame): void;
  revocation(frame: RevocationFrame): void;
  state(state: EventSubState, detail: { sessionId: string | null; reconnects: number; lastKeepaliveAt?: number }): void;
  duplicate?(messageId: string): void;
}

export interface EventSubOptions {
  socketFactory: SocketFactory;
  handlers: EventSubHandlers;
  logger: Logger;
  timers: Timers;
  url?: string;
  /** Extra time beyond keepalive_timeout_seconds before declaring the socket dead. */
  keepaliveGraceMs?: number;
  reconnect?: ReconnectManager;
  dedupe?: TtlDedupe;
}

/** Close codes after which retrying cannot help without a fix (4001: we sent data; never expected). */
const DESCRIBE_CLOSE: Record<number, string> = {
  4000: 'internal server error', 4001: 'client sent inbound traffic', 4002: 'failed ping-pong', 4003: 'connection unused (no subscription in time)',
  4004: 'reconnect grace time expired', 4005: 'network timeout', 4006: 'network error', 4007: 'invalid reconnect URL',
};

interface Conn {
  socket: SocketLike;
  url: string;
  migrating: boolean;
  sessionId: string | null;
  keepaliveMs: number;
  watchdog: unknown;
  welcomeTimer: unknown;
  closed: boolean;
}

export class EventSubSession {
  private active: Conn | null = null;
  private pending: Conn | null = null;
  private running = false;
  private reconnects = 0;
  private readonly reconnect: ReconnectManager;
  private readonly dedupe: TtlDedupe;
  private readonly url: string;

  constructor(private readonly opts: EventSubOptions) {
    this.reconnect = opts.reconnect ?? new ReconnectManager(opts.timers);
    this.dedupe = opts.dedupe ?? new TtlDedupe(15 * 60_000, 10_000, () => opts.timers.now());
    this.url = opts.url ?? TWITCH_ENDPOINTS.eventsubWs;
  }

  get sessionId(): string | null {
    return this.active?.sessionId ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state('connecting');
    this.open(this.url, false);
  }

  stop(): void {
    this.running = false;
    this.reconnect.cancel();
    for (const c of [this.pending, this.active]) if (c) this.dispose(c, 1000, 'client stop');
    this.active = this.pending = null;
    this.state('stopped');
  }

  private state(s: EventSubState, lastKeepaliveAt?: number): void {
    this.opts.handlers.state(s, { sessionId: this.sessionId, reconnects: this.reconnects, ...(lastKeepaliveAt ? { lastKeepaliveAt } : {}) });
  }

  private open(url: string, migrating: boolean): void {
    let socket: SocketLike;
    try {
      socket = this.opts.socketFactory(url);
    } catch (err) {
      this.opts.logger.warn(`EventSub connect failed: ${(err as Error).message}`);
      this.retry();
      return;
    }
    const conn: Conn = { socket, url, migrating, sessionId: null, keepaliveMs: 10_000, watchdog: null, welcomeTimer: null, closed: false };
    if (migrating) this.pending = conn; else this.active = conn;
    conn.welcomeTimer = this.opts.timers.setTimeout(() => this.lost(conn, 'no welcome message'), TWITCH_LIMITS.welcomeSubscribeWindowMs + 5000);
    socket.onMessage((data) => this.onFrame(conn, data));
    socket.onClose((code, reason) => this.onClose(conn, code, reason));
    socket.onError((message) => this.opts.logger.warn(`EventSub socket error: ${message}`));
  }

  private arm(conn: Conn): void {
    if (conn.watchdog !== null) this.opts.timers.clearTimeout(conn.watchdog);
    conn.watchdog = this.opts.timers.setTimeout(() => this.lost(conn, 'keepalive timeout'), conn.keepaliveMs + (this.opts.keepaliveGraceMs ?? 5000));
  }

  private onFrame(conn: Conn, raw: string): void {
    if (conn.closed) return;
    const frame = parseFrame(raw);
    switch (frame.type) {
      case 'invalid':
        this.opts.logger.warn(`EventSub: ignored malformed frame (${frame.reason})`);
        return;
      case 'unknown':
        this.opts.logger.info(`EventSub: ignored unknown message_type ${frame.meta.messageType}`);
        return;
      case 'session_welcome':
        void this.onWelcome(conn, frame);
        return;
      case 'session_keepalive':
        this.arm(conn);
        if (conn === this.active) this.state('connected', this.opts.timers.now());
        return;
      case 'session_reconnect':
        this.opts.logger.info('EventSub: server asked to reconnect; migrating to the new URL');
        this.arm(conn);
        if (this.pending) this.dispose(this.pending, 1000, 'superseded');
        this.state('reconnecting');
        this.open(frame.session.reconnectUrl!, true);
        return;
      case 'notification':
        this.arm(conn);
        if (this.dedupe.seen(frame.meta.messageId)) {
          this.opts.handlers.duplicate?.(frame.meta.messageId);
          return;
        }
        this.safely(() => this.opts.handlers.notification(frame));
        return;
      case 'revocation':
        this.arm(conn);
        if (this.dedupe.seen(frame.meta.messageId)) return;
        this.safely(() => this.opts.handlers.revocation(frame));
        return;
    }
  }

  private async onWelcome(conn: Conn, frame: Extract<Frame, { type: 'session_welcome' | 'session_reconnect' }>): Promise<void> {
    if (conn.welcomeTimer !== null) this.opts.timers.clearTimeout(conn.welcomeTimer);
    conn.welcomeTimer = null;
    const sessionId = frame.session.id;
    conn.sessionId = sessionId;
    conn.keepaliveMs = (frame.session.keepaliveTimeoutSeconds ?? 10) * 1000;
    this.arm(conn);
    if (conn.migrating) {
      // new socket is live: retire the old one; subscriptions moved with the session
      const old = this.active;
      this.active = conn;
      this.pending = null;
      conn.migrating = false;
      if (old && old !== conn) this.dispose(old, 1000, 'migrated');
      this.reconnects++;
      this.state('connected', this.opts.timers.now());
      return;
    }
    this.state('subscribing');
    try {
      await this.opts.handlers.subscribe(sessionId);
      if (conn.closed || conn !== this.active) return;
      this.reconnect.reset();
      this.state('connected', this.opts.timers.now());
    } catch (err) {
      this.opts.logger.warn(`EventSub subscribe failed: ${(err as Error).message}`);
      if (conn === this.active && !conn.closed) this.lost(conn, 'subscription failed', true);
    }
  }

  private onClose(conn: Conn, code: number, reason: string): void {
    if (conn.closed) return;
    const why = `${code}${DESCRIBE_CLOSE[code] ? ` ${DESCRIBE_CLOSE[code]}` : ''}${reason ? `: ${reason}` : ''}`;
    if (conn === this.pending) {
      // migration target failed; the old socket may still be alive until Twitch closes it (4004)
      this.opts.logger.warn(`EventSub reconnect socket closed (${why})`);
      this.dispose(conn, 1000, '');
      this.pending = null;
      this.recoverIfOrphaned();
      return;
    }
    this.lost(conn, `closed ${why}`);
  }

  /** The migration target died and the old socket is already gone: start over. */
  private recoverIfOrphaned(): void {
    if (this.running && !this.active && !this.pending) {
      this.state('reconnecting');
      this.retry();
    }
  }

  /** The active connection is gone: fresh connection after backoff, with resubscribe. */
  private lost(conn: Conn, why: string, failed = false): void {
    if (conn.closed) return;
    const wasActive = conn === this.active;
    this.dispose(conn, 4000, why);
    if (conn === this.pending) {
      this.pending = null;
      this.recoverIfOrphaned();
      return;
    }
    if (!wasActive || !this.running) return;
    this.active = null;
    if (this.pending) {
      // a migration is in flight; let it take over
      return;
    }
    this.opts.logger.warn(`EventSub connection lost (${why}); reconnecting`);
    this.state(failed ? 'failed' : 'reconnecting');
    this.retry();
  }

  private retry(): void {
    if (!this.running) return;
    this.reconnects++;
    const delay = this.reconnect.schedule(() => {
      if (!this.running) return;
      this.state('connecting');
      this.open(this.url, false);
    });
    this.opts.logger.info(`EventSub: next connection attempt in ${Math.round(delay / 1000)}s`);
  }

  private dispose(conn: Conn, code: number, reason: string): void {
    if (conn.closed) return;
    conn.closed = true;
    for (const t of [conn.watchdog, conn.welcomeTimer]) if (t !== null) this.opts.timers.clearTimeout(t);
    try {
      conn.socket.close(code === 4000 ? 1000 : code, reason.slice(0, 100));
    } catch { /* already closed */ }
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.logger.warn(`EventSub handler failed: ${(err as Error).message}`);
    }
  }
}
