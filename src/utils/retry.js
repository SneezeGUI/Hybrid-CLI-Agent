/**
 * Retry utilities with exponential backoff
 * Provides robust retry logic for transient failures
 * @module utils/retry
 */

import { RATE_LIMITS } from '../config/timeouts.js';

/**
 * Error types that should be retried
 * @type {Set<string>}
 */
export const RETRYABLE_ERROR_PATTERNS = new Set([
  'RATE_LIMIT',
  'TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  '429',
  '503',
  '502',
  '504',
]);

/**
 * Process exit codes that indicate transient failures
 * @type {Set<number>}
 */
export const RETRYABLE_EXIT_CODES = new Set([
  1,    // General failure (may be transient)
  137,  // Killed (SIGKILL - may be OOM or timeout)
  143,  // Terminated (SIGTERM)
]);

/**
 * Check if an error is retryable
 * @param {Error|string|number} error - Error to check
 * @returns {boolean} True if error is retryable
 */
export function isRetryable(error) {
  // Check exit codes
  if (typeof error === 'number') {
    return RETRYABLE_EXIT_CODES.has(error);
  }

  // Get error message
  const message = error instanceof Error ? error.message : String(error);
  const upperMessage = message.toUpperCase();

  // Check against retryable patterns
  for (const pattern of RETRYABLE_ERROR_PATTERNS) {
    if (upperMessage.includes(pattern)) {
      return true;
    }
  }

  // Check error code property
  if (error instanceof Error && error.code) {
    if (RETRYABLE_ERROR_PATTERNS.has(error.code)) {
      return true;
    }
  }

  // Check status code for HTTP errors
  if (error instanceof Error && error.status) {
    const statusStr = String(error.status);
    if (RETRYABLE_ERROR_PATTERNS.has(statusStr)) {
      return true;
    }
  }

  return false;
}

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {number} baseDelayMs - Base delay in milliseconds
 * @param {number} maxDelayMs - Maximum delay in milliseconds
 * @param {boolean} [addJitter=true] - Add random jitter to prevent thundering herd
 * @returns {number} Delay in milliseconds
 */
export function calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs, addJitter = true) {
  // Exponential backoff: baseDelay * 2^attempt
  let delay = baseDelayMs * Math.pow(2, attempt);

  // Cap at maximum
  delay = Math.min(delay, maxDelayMs);

  // Add jitter (0-25% of delay)
  if (addJitter) {
    const jitter = delay * 0.25 * Math.random();
    delay += jitter;
  }

  return Math.round(delay);
}

/**
 * Retry options
 * @typedef {Object} RetryOptions
 * @property {number} [maxRetries=3] - Maximum number of retry attempts
 * @property {number} [baseDelayMs=1000] - Base delay between retries
 * @property {number} [maxDelayMs=60000] - Maximum delay between retries
 * @property {boolean} [addJitter=true] - Add random jitter to delays
 * @property {Function} [shouldRetry] - Custom function to determine if error is retryable
 * @property {Function} [onRetry] - Callback called before each retry
 */

/**
 * Execute a function with exponential backoff retry
 * @param {Function} fn - Async function to execute
 * @param {RetryOptions} [options={}] - Retry options
 * @returns {Promise<*>} Result of the function
 * @throws {Error} Last error if all retries fail
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = RATE_LIMITS.cooldownMs / 60, // ~1 second default
    maxDelayMs = RATE_LIMITS.cooldownMs,       // ~60 seconds max
    addJitter = true,
    shouldRetry = isRetryable,
    onRetry = null,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const canRetry = attempt < maxRetries && shouldRetry(error);

      if (!canRetry) {
        throw error;
      }

      // Calculate delay
      const delay = calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs, addJitter);

      // Call onRetry callback if provided
      if (onRetry) {
        try {
          await onRetry({
            attempt: attempt + 1,
            maxRetries,
            error,
            delayMs: delay,
            willRetry: true,
          });
        } catch (callbackError) {
          // Ignore callback errors
          console.error('[Retry] onRetry callback error:', callbackError.message);
        }
      }

      // Wait before retrying
      await sleep(delay);
    }
  }

  // This shouldn't be reached, but throw last error just in case
  throw lastError;
}

/**
 * Create a retry wrapper for a function
 * @param {Function} fn - Function to wrap
 * @param {RetryOptions} [options={}] - Default retry options
 * @returns {Function} Wrapped function with retry behavior
 */
export function createRetryWrapper(fn, options = {}) {
  return async function retryWrapper(...args) {
    return withRetry(() => fn(...args), options);
  };
}

/**
 * Rate limit tracker for specific resources
 */
export class RateLimitTracker {
  /**
   * @param {Object} [options={}]
   * @param {number} [options.cooldownMs=60000] - Cooldown period after rate limit
   * @param {number} [options.maxFailures=3] - Max consecutive failures before marking unavailable
   */
  constructor(options = {}) {
    this.cooldownMs = options.cooldownMs || RATE_LIMITS.cooldownMs;
    this.maxFailures = options.maxFailures || RATE_LIMITS.maxFailures;
    this.resources = new Map();
  }

  /**
   * Record a rate limit hit for a resource
   * @param {string} resourceId - Resource identifier (e.g., model name)
   */
  recordRateLimit(resourceId) {
    const existing = this.resources.get(resourceId) || { failures: 0, lastHit: 0 };
    this.resources.set(resourceId, {
      failures: existing.failures + 1,
      lastHit: Date.now(),
      unavailableUntil: Date.now() + this.cooldownMs,
    });
  }

  /**
   * Record a successful request for a resource
   * @param {string} resourceId - Resource identifier
   */
  recordSuccess(resourceId) {
    const existing = this.resources.get(resourceId);
    if (existing) {
      // Reset failure count on success, but keep tracking
      this.resources.set(resourceId, {
        ...existing,
        failures: 0,
      });
    }
  }

  /**
   * Check if a resource is available (not rate limited)
   * @param {string} resourceId - Resource identifier
   * @returns {boolean} True if resource is available
   */
  isAvailable(resourceId) {
    const info = this.resources.get(resourceId);
    if (!info) return true;

    // Check if cooldown has passed
    if (Date.now() > info.unavailableUntil) {
      return true;
    }

    // Cooldown hasn't passed, resource is unavailable
    return false;
  }

  /**
   * Get time until resource is available again
   * @param {string} resourceId - Resource identifier
   * @returns {number} Milliseconds until available (0 if already available)
   */
  getWaitTime(resourceId) {
    const info = this.resources.get(resourceId);
    if (!info) return 0;

    const waitTime = info.unavailableUntil - Date.now();
    return Math.max(0, waitTime);
  }

  /**
   * Clear rate limit info for a resource
   * @param {string} resourceId - Resource identifier
   */
  clear(resourceId) {
    this.resources.delete(resourceId);
  }

  /**
   * Clear all rate limit info
   */
  clearAll() {
    this.resources.clear();
  }
}

// Singleton rate limit tracker
let globalRateLimitTracker = null;

/**
 * Get the global rate limit tracker
 * @param {Object} [options] - Options for creating tracker (only used on first call)
 * @returns {RateLimitTracker}
 */
export function getRateLimitTracker(options) {
  if (!globalRateLimitTracker) {
    globalRateLimitTracker = new RateLimitTracker(options);
  }
  return globalRateLimitTracker;
}

/**
 * Reset the global rate limit tracker (mainly for testing)
 */
export function resetRateLimitTracker() {
  if (globalRateLimitTracker) {
    globalRateLimitTracker.clearAll();
    globalRateLimitTracker = null;
  }
}

export default {
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
};
