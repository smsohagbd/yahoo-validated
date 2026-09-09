export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    let bucket = this.hits.get(key);
    if (!bucket || now >= bucket.reset) {
      bucket = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > this.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((bucket.reset - now) / 1000)),
      };
    }
    return {
      allowed: true,
      remaining: this.max - bucket.count,
      retryAfter: 0,
    };
  }

  sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.hits) {
      if (now >= bucket.reset) this.hits.delete(key);
    }
  }
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
