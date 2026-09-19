/** Fixed-window per-token budget for MCP tool calls (per server process; a restart resets it). */
export class TokenRateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    readonly limit = 120,
    private windowMs = 60_000,
  ) {}

  take(tokenId: string, now = Date.now()): { ok: true } | { ok: false; retryInSeconds: number } {
    const w = this.windows.get(tokenId);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(tokenId, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return { ok: true };
    }
    if (w.count >= this.limit) return { ok: false, retryInSeconds: Math.ceil((w.start + this.windowMs - now) / 1000) };
    w.count++;
    return { ok: true };
  }

  private prune(now: number) {
    for (const [id, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(id);
  }
}
