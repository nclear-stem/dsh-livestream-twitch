import type { HttpFetch } from '../src/runtime/http';
import type { CordisLikeContext } from '../src/dsh/host';
import type { StoredGrant } from '../src/storage/credentialStore';
import { createLogger, type LogLevel } from '../src/runtime/redact';

export const FAKE = {
  clientId: 'fakeclientid000000000000000000',
  clientSecret: 'fakeclientsecret0000000000000000',
  access: 'fakeaccesstoken000000000000000a',
  refresh: 'fakerefreshtoken00000000000000000r',
};

export function grant(overrides: Partial<StoredGrant> = {}): StoredGrant {
  return {
    version: 1,
    clientId: FAKE.clientId,
    accessToken: FAKE.access,
    refreshToken: FAKE.refresh,
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:read:chat', 'user:write:chat'],
    identity: { userId: '1001', login: 'streamer', displayName: 'Streamer' },
    obtainedAt: Date.now(),
    ...overrides,
  };
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Route = (call: Call) => Response | Promise<Response>;

/** Fake fetch: routes by "METHOD url-prefix"; records every call. */
export function fakeFetch(routes: Record<string, Route>): HttpFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const call: Call = { url, method: init.method ?? 'GET', headers, body: init.body ? String(init.body) : '' };
    calls.push(call);
    const key = Object.keys(routes).filter((k) => { const [m, p] = k.split(' '); return m === call.method && url.startsWith(p!); })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unexpected request ${call.method} ${url}`);
    return routes[key]!(call);
  }) as HttpFetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function memoryLogger() {
  const lines: Array<{ level: LogLevel; message: string }> = [];
  return { lines, logger: createLogger((level, message) => lines.push({ level, message })) };
}

/** Minimal Cordis-like context: effects run immediately, disposers collected. */
export function fakeContext(services: Record<string, unknown> = {}) {
  const disposers: Array<() => void> = [];
  const ctx: CordisLikeContext = {
    effect(effect) {
      disposers.push(effect());
      return undefined;
    },
    get: (name: string) => services[name],
    ...('connection' in services ? { connection: services.connection } : {}),
  };
  return { ctx, dispose: () => { for (const d of disposers.splice(0).reverse()) d(); } };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Deterministic timers: `advance(ms)` runs due callbacks in order and lets promise chains settle between them. */
export class ManualTimers {
  t = 1_700_000_000_000;
  private seq = 0;
  private due = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.due.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.due.delete(h as number);
  };
  now = () => this.t;
  get pendingCount() {
    return this.due.size;
  }
  async flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
  async advance(ms: number) {
    const end = this.t + ms;
    await this.flush();
    for (;;) {
      const next = [...this.due.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.due.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await this.flush();
    }
    this.t = end;
    await this.flush();
  }
}

/** Fake EventSub socket: tests push frames with `server(frame)` and close with `drop(code)`. */
export class FakeSocket {
  closed: { code?: number; reason?: string } | null = null;
  private msg: Array<(d: string) => void> = [];
  private close_: Array<(code: number, reason: string) => void> = [];
  constructor(readonly url: string) {}
  onOpen() {}
  onMessage(cb: (d: string) => void) { this.msg.push(cb); }
  onClose(cb: (code: number, reason: string) => void) { this.close_.push(cb); }
  onError() {}
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const c of this.close_) c(code ?? 1000, reason ?? '');
  }
  server(frame: unknown) { for (const m of this.msg) m(typeof frame === 'string' ? frame : JSON.stringify(frame)); }
  drop(code = 1006, reason = '') {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const c of this.close_) c(code, reason);
  }
}

let frameSeq = 0;
export const frames = {
  welcome: (id: string, keepalive = 10) => ({ metadata: { message_id: `w-${++frameSeq}`, message_type: 'session_welcome', message_timestamp: 't' }, payload: { session: { id, status: 'connected', keepalive_timeout_seconds: keepalive, reconnect_url: null } } }),
  keepalive: () => ({ metadata: { message_id: `k-${++frameSeq}`, message_type: 'session_keepalive', message_timestamp: 't' }, payload: {} }),
  reconnect: (url: string) => ({ metadata: { message_id: `r-${++frameSeq}`, message_type: 'session_reconnect', message_timestamp: 't' }, payload: { session: { id: 'old', status: 'reconnecting', keepalive_timeout_seconds: null, reconnect_url: url } } }),
  revocation: (type: string, status: string) => ({ metadata: { message_id: `v-${++frameSeq}`, message_type: 'revocation', message_timestamp: 't', subscription_type: type, subscription_version: '1' }, payload: { subscription: { id: 's', type, version: '1', status } } }),
  notification: (type: string, event: Record<string, unknown>, messageId = `n-${++frameSeq}`) => ({
    metadata: { message_id: messageId, message_type: 'notification', message_timestamp: '2026-11-10T01:02:03.123456789Z', subscription_type: type, subscription_version: '1' },
    payload: { subscription: { id: 'sub', type, version: '1', status: 'enabled' }, event },
  }),
  chat: (from: { id: string; login: string }, text: string, messageId?: string, extra: Record<string, unknown> = {}) => frames.notification('channel.chat.message', {
    broadcaster_user_id: '1001', broadcaster_user_login: 'streamer', broadcaster_user_name: 'Streamer',
    chatter_user_id: from.id, chatter_user_login: from.login, chatter_user_name: from.login.toUpperCase(),
    message_id: `chat-${messageId ?? ++frameSeq}`, message: { text, fragments: [] }, badges: [], message_type: 'text', reply: null, ...extra,
  }, messageId),
};
