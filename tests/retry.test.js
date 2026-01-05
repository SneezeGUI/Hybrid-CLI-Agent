/**
 * Tests for retry utility
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import {
  isRetryable,
  sleep,
  calculateBackoffDelay,
  withRetry,
  createRetryWrapper,
  RateLimitTracker,
  getRateLimitTracker,
  resetRateLimitTracker,
  RETRYABLE_ERROR_PATTERNS,
  RETRYABLE_EXIT_CODES,
} from '../src/utils/retry.js';

describe('isRetryable', () => {
  it('should identify retryable exit codes', () => {
    assert.strictEqual(isRetryable(1), true);
    assert.strictEqual(isRetryable(137), true);
    assert.strictEqual(isRetryable(143), true);
    assert.strictEqual(isRetryable(0), false);
    assert.strictEqual(isRetryable(2), false);
  });

  it('should identify retryable error messages', () => {
    assert.strictEqual(isRetryable(new Error('RATE_LIMIT exceeded')), true);
    assert.strictEqual(isRetryable(new Error('Connection TIMEOUT')), true);
    assert.strictEqual(isRetryable(new Error('ECONNRESET')), true);
    assert.strictEqual(isRetryable(new Error('429 Too Many Requests')), true);
    assert.strictEqual(isRetryable(new Error('503 Service Unavailable')), true);
    assert.strictEqual(isRetryable(new Error('Unknown error')), false);
  });

  it('should check error code property', () => {
    const error = new Error('Connection failed');
    error.code = 'ETIMEDOUT';
    assert.strictEqual(isRetryable(error), true);
  });

  it('should check status property', () => {
    const error = new Error('Request failed');
    error.status = 429;
    assert.strictEqual(isRetryable(error), true);
  });

  it('should handle string errors', () => {
    assert.strictEqual(isRetryable('RATE_LIMIT'), true);
    assert.strictEqual(isRetryable('some random error'), false);
  });
});

describe('sleep', () => {
  it('should delay execution', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 45, `Expected at least 45ms, got ${elapsed}ms`);
  });
});

describe('calculateBackoffDelay', () => {
  it('should calculate exponential delay', () => {
    const baseDelay = 1000;
    const maxDelay = 60000;

    // Without jitter for predictable testing
    assert.strictEqual(calculateBackoffDelay(0, baseDelay, maxDelay, false), 1000);
    assert.strictEqual(calculateBackoffDelay(1, baseDelay, maxDelay, false), 2000);
    assert.strictEqual(calculateBackoffDelay(2, baseDelay, maxDelay, false), 4000);
    assert.strictEqual(calculateBackoffDelay(3, baseDelay, maxDelay, false), 8000);
  });

  it('should cap at max delay', () => {
    const baseDelay = 1000;
    const maxDelay = 5000;

    assert.strictEqual(calculateBackoffDelay(10, baseDelay, maxDelay, false), 5000);
  });

  it('should add jitter when enabled', () => {
    const baseDelay = 1000;
    const maxDelay = 60000;

    // With jitter, delay should be between base and base * 1.25
    const delay = calculateBackoffDelay(0, baseDelay, maxDelay, true);
    assert.ok(delay >= 1000 && delay <= 1250, `Expected 1000-1250, got ${delay}`);
  });
});

describe('withRetry', () => {
  it('should return result on success', async () => {
    const fn = async () => 'success';
    const result = await withRetry(fn);
    assert.strictEqual(result, 'success');
  });

  it('should retry on retryable error', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('RATE_LIMIT');
      }
      return 'success';
    };

    const result = await withRetry(fn, { baseDelayMs: 10 });
    assert.strictEqual(result, 'success');
    assert.strictEqual(attempts, 3);
  });

  it('should not retry on non-retryable error', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('Invalid input');
    };

    await assert.rejects(
      async () => withRetry(fn, { baseDelayMs: 10 }),
      /Invalid input/
    );
    assert.strictEqual(attempts, 1);
  });

  it('should throw after max retries', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('RATE_LIMIT');
    };

    await assert.rejects(
      async () => withRetry(fn, { maxRetries: 2, baseDelayMs: 10 }),
      /RATE_LIMIT/
    );
    assert.strictEqual(attempts, 3); // Initial + 2 retries
  });

  it('should call onRetry callback', async () => {
    let retryInfo = null;
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('TIMEOUT');
      }
      return 'success';
    };

    await withRetry(fn, {
      baseDelayMs: 10,
      onRetry: (info) => { retryInfo = info; },
    });

    assert.ok(retryInfo);
    assert.strictEqual(retryInfo.attempt, 1);
    assert.strictEqual(retryInfo.willRetry, true);
  });

  it('should use custom shouldRetry function', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('Custom error');
    };

    const customShouldRetry = (error) => error.message === 'Custom error';

    await assert.rejects(
      async () => withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 10,
        shouldRetry: customShouldRetry,
      }),
      /Custom error/
    );
    assert.strictEqual(attempts, 3);
  });
});

describe('createRetryWrapper', () => {
  it('should create a retry-enabled function', async () => {
    let attempts = 0;
    const originalFn = async (x) => {
      attempts++;
      if (attempts < 2) {
        throw new Error('TIMEOUT');
      }
      return x * 2;
    };

    const wrappedFn = createRetryWrapper(originalFn, { baseDelayMs: 10 });
    const result = await wrappedFn(5);

    assert.strictEqual(result, 10);
    assert.strictEqual(attempts, 2);
  });
});

describe('RateLimitTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new RateLimitTracker({ cooldownMs: 100, maxFailures: 2 });
  });

  it('should track rate limits', () => {
    assert.strictEqual(tracker.isAvailable('model-a'), true);

    tracker.recordRateLimit('model-a');
    assert.strictEqual(tracker.isAvailable('model-a'), false);
  });

  it('should respect cooldown period', async () => {
    tracker.recordRateLimit('model-a');
    assert.strictEqual(tracker.isAvailable('model-a'), false);

    // Wait for cooldown
    await sleep(150);
    assert.strictEqual(tracker.isAvailable('model-a'), true);
  });

  it('should return wait time', () => {
    tracker.recordRateLimit('model-a');
    const waitTime = tracker.getWaitTime('model-a');

    assert.ok(waitTime > 0 && waitTime <= 100, `Expected 0-100, got ${waitTime}`);
  });

  it('should reset failures on success', () => {
    tracker.recordRateLimit('model-a');
    tracker.recordSuccess('model-a');

    const info = tracker.resources.get('model-a');
    assert.strictEqual(info.failures, 0);
  });

  it('should clear rate limit info', () => {
    tracker.recordRateLimit('model-a');
    tracker.clear('model-a');

    assert.strictEqual(tracker.isAvailable('model-a'), true);
  });

  it('should clear all rate limit info', () => {
    tracker.recordRateLimit('model-a');
    tracker.recordRateLimit('model-b');
    tracker.clearAll();

    assert.strictEqual(tracker.resources.size, 0);
  });
});

describe('Global Rate Limit Tracker', () => {
  afterEach(() => {
    resetRateLimitTracker();
  });

  it('should return singleton instance', () => {
    const tracker1 = getRateLimitTracker();
    const tracker2 = getRateLimitTracker();

    assert.strictEqual(tracker1, tracker2);
  });

  it('should reset singleton', () => {
    const tracker1 = getRateLimitTracker();
    tracker1.recordRateLimit('test');

    resetRateLimitTracker();

    const tracker2 = getRateLimitTracker();
    assert.notStrictEqual(tracker1, tracker2);
    assert.strictEqual(tracker2.resources.size, 0);
  });
});

describe('RETRYABLE constants', () => {
  it('should export RETRYABLE_ERROR_PATTERNS', () => {
    assert.ok(RETRYABLE_ERROR_PATTERNS instanceof Set);
    assert.ok(RETRYABLE_ERROR_PATTERNS.has('RATE_LIMIT'));
    assert.ok(RETRYABLE_ERROR_PATTERNS.has('429'));
  });

  it('should export RETRYABLE_EXIT_CODES', () => {
    assert.ok(RETRYABLE_EXIT_CODES instanceof Set);
    assert.ok(RETRYABLE_EXIT_CODES.has(1));
    assert.ok(RETRYABLE_EXIT_CODES.has(137));
  });
});
