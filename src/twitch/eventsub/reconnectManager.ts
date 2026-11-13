/** Exponential backoff with full jitter for ordinary disconnects (not for session_reconnect migration). */

import type { Timers } from '../../runtime/timers';

export class ReconnectManager {
  private attempt = 0;
  private handle: unknown = null;

  constructor(
    private readonly timers: Timers,
    private readonly opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
  ) {}

  get attempts(): number {
    return this.attempt;
  }

  nextDelay(): number {
    const base = this.opts.baseMs ?? 1000;
    const max = this.opts.maxMs ?? 60_000;
    const ceiling = Math.min(max, base * 2 ** this.attempt);
    this.attempt++;
    // first retry is quick; later ones spread out
    return Math.round(ceiling / 2 + (this.opts.random ?? Math.random)() * (ceiling / 2));
  }

  schedule(fn: () => void): number {
    this.cancel();
    const delay = this.nextDelay();
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      fn();
    }, delay);
    return delay;
  }

  cancel(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  reset(): void {
    this.attempt = 0;
  }
}
