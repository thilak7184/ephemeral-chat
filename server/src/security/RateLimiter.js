export class RateLimiter {
  constructor({ limit = 10, windowMs = 5000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map();
  }

  consume(key) {
    const timestamp = this.now();
    const bucket = this.buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((entry) => timestamp - entry < this.windowMs);
    if (bucket.timestamps.length >= this.limit) {
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        retryAfterMs: Math.max(1, this.windowMs - (timestamp - bucket.timestamps[0])),
      };
    }
    bucket.timestamps.push(timestamp);
    this.buckets.set(key, bucket);
    return { allowed: true, remaining: this.limit - bucket.timestamps.length };
  }

  delete(key) {
    this.buckets.delete(key);
  }

  prune() {
    const timestamp = this.now();
    for (const [key, bucket] of this.buckets) {
      bucket.timestamps = bucket.timestamps.filter((entry) => timestamp - entry < this.windowMs);
      if (bucket.timestamps.length === 0) this.buckets.delete(key);
    }
  }
}
