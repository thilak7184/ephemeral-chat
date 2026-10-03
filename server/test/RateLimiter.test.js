import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/security/RateLimiter.js';

test('allows a bounded burst and rejects until the window rolls over', () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.consume('session').allowed, true);
  assert.equal(limiter.consume('session').allowed, true);
  const rejected = limiter.consume('session');
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterMs, 1000);
  now = 1001;
  assert.equal(limiter.consume('session').allowed, true);
});

test('prunes unused session buckets', () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 1, windowMs: 100, now: () => now });
  limiter.consume('temporary');
  now = 101;
  limiter.prune();
  assert.equal(limiter.buckets.size, 0);
});
