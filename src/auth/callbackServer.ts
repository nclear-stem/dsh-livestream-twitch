/**
 * Loopback-only OAuth callback server. Lives only while an authorization is pending: started by `auth`,
 * closed after the first valid callback, after a fatal callback, or when the transaction TTL elapses.
 * Never binds 0.0.0.0. Remote hosts are reached through `ssh -N -L 17123:127.0.0.1:17123`.
 */

import { createServer, type Server } from 'node:http';

export interface CallbackOutcome {
  status: number;
  title: string;
  message: string;
  /** Close the server after answering. */
  done: boolean;
}

export interface CallbackServerOptions {
  host: string;
  port: number;
  path: string;
  onCallback: (query: URLSearchParams) => Promise<CallbackOutcome>;
  timeoutMs: number;
  onClosed?: (reason: 'done' | 'timeout' | 'stopped') => void;
}

export interface CallbackServerHandle {
  readonly address: string;
  close(reason?: 'done' | 'timeout' | 'stopped'): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(o: CallbackOutcome): string {
  return `<!doctype html><meta charset="utf-8"><title>${escape(o.title)}</title>`
    + `<body style="font-family:system-ui;max-width:36em;margin:4em auto"><h1>${escape(o.title)}</h1><p>${escape(o.message)}</p></body>`;
}

export async function startCallbackServer(opts: CallbackServerOptions): Promise<CallbackServerHandle> {
  if (!LOOPBACK.has(opts.host)) throw new Error(`callback server only binds loopback addresses, not ${opts.host}`);
  let closed = false;
  let busy = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const reply = (o: CallbackOutcome) => {
      res.writeHead(o.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(page(o));
    };
    if (req.method !== 'GET' || url.pathname !== opts.path) {
      reply({ status: 404, title: 'Not found', message: 'This port only serves the Twitch OAuth callback.', done: false });
      return;
    }
    if (busy) {
      reply({ status: 409, title: 'Busy', message: 'An authorization callback is already being processed.', done: false });
      return;
    }
    busy = true;
    opts.onCallback(url.searchParams)
      .catch((err: unknown): CallbackOutcome => ({ status: 500, title: 'Authorization failed', message: err instanceof Error ? err.message : 'unexpected error', done: false }))
      .then((outcome) => {
        busy = false;
        reply(outcome);
        if (outcome.done) {
          const close = () => void handle.close('done');
          if (res.writableFinished) close(); else res.once('finish', close);
        }
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const timer = setTimeout(() => void handle.close('timeout'), opts.timeoutMs);
  timer.unref?.();
  const handle: CallbackServerHandle = {
    address: `http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${opts.port}${opts.path}`,
    async close(reason = 'stopped') {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      const closing = new Promise<void>((r) => server.close(() => r()));
      // Browsers keep the connection alive; drop it so close() settles promptly.
      server.closeAllConnections?.();
      await closing;
      opts.onClosed?.(reason);
    },
  };
  return handle;
}
