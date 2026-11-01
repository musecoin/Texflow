/**
 * In-process sliding-window rate limiter. Sufficient for a single API instance; for
 * horizontal scaling the same interface is backed by Redis (Phase 4).
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private limit: number; private windowMs: number;
  constructor(limit: number, windowMs = 60_000) { this.limit = limit; this.windowMs = windowMs; }
  /** returns seconds to wait, or 0 if allowed */
  check(key: string, now = Date.now()): number {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) { this.hits.set(key, arr); return Math.ceil((this.windowMs - (now - arr[0])) / 1000); }
    arr.push(now); this.hits.set(key, arr);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] > this.windowMs) this.hits.delete(k);
    return 0;
  }
  reset() { this.hits.clear(); }
}
