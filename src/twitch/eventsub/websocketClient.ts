/**
 * Socket boundary for EventSub. Production uses Node's built-in WebSocket (Node 22+), which answers
 * server pings with pongs automatically; the client never sends data frames (Twitch closes with 4001 if it
 * does). Tests supply a fake implementing SocketLike.
 */

export interface SocketLike {
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (message: string) => void): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

interface MinimalWebSocket {
  addEventListener(type: string, cb: (ev: { data?: unknown; code?: number; reason?: string; message?: string }) => void): void;
  close(code?: number, reason?: string): void;
}

export const globalWebSocketFactory: SocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => MinimalWebSocket }).WebSocket;
  if (!Ctor) throw new Error('this Node.js has no built-in WebSocket; Node 22 or newer is required');
  const ws = new Ctor(url);
  return {
    onOpen: (cb) => ws.addEventListener('open', () => cb()),
    onMessage: (cb) => ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') cb(ev.data);
      else if (ev.data instanceof ArrayBuffer) cb(new TextDecoder().decode(ev.data));
    }),
    onClose: (cb) => ws.addEventListener('close', (ev) => cb(ev.code ?? 1006, ev.reason ?? '')),
    onError: (cb) => ws.addEventListener('error', (ev) => cb(ev.message ?? 'websocket error')),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        ws.close();
      }
    },
  };
};
