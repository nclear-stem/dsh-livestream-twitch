/** TTL + size bounded set of seen ids (EventSub message_id). Twitch may redeliver a notification. */

export class TtlDedupe {
  private readonly seenAt = new Map<string, number>();

  constructor(private readonly ttlMs = 15 * 60_000, private readonly max = 10_000, private readonly now: () => number = Date.now) {}

  /** True if `id` was already seen within the TTL; otherwise records it and returns false. */
  seen(id: string): boolean {
    const t = this.now();
    const at = this.seenAt.get(id);
    if (at !== undefined && t - at < this.ttlMs) return true;
    this.seenAt.delete(id);
    this.seenAt.set(id, t);
    this.prune(t);
    return false;
  }

  get size(): number {
    return this.seenAt.size;
  }

  private prune(t: number): void {
    for (const [id, at] of this.seenAt) {
      if (this.seenAt.size <= this.max && t - at < this.ttlMs) break;
      this.seenAt.delete(id);
    }
  }
}
