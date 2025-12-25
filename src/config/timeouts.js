/**
 * Centralized configuration for timeouts, limits, and timing-related settings
 * for the Hybrid CLI Agent MCP Server.
 * 
 * This ensures consistency across file operations, API calls, and cache management.
 * @module config/timeouts
 */

/**
 * Standard timeout durations in milliseconds.
 * Used for various operation types to ensure the system remains responsive
 * but allows enough time for complex tasks.
 * 
 * @constant
 * @type {Object.<string, number>}
 */
export const TIMEOUTS = {
  /** 30 seconds - simple commands or quick file reads */
  QUICK: 30000,
  /** 1 minute - standard operations */
  DEFAULT: 60000,
  /** 2 minutes - heavy analysis or multiple file operations */
  LONG: 120000,
  /** 5 minutes - very large operations, builds, or deep architectural analysis */
  EXTENDED: 300000,
  /** 5 seconds - time to wait before force killing a process after SIGTERM */
  FORCE_KILL: 5000,
  /** 60 seconds - OpenRouter API specific timeout */
  OPENROUTER: 60000
};

/**
 * Rate limiting configuration for external APIs (e.g., OpenRouter).
 * 
 * @constant
 * @type {Object}
 * @property {number} cooldownMs - Duration to wait after hitting a rate limit (1 minute)
 * @property {number} maxFailures - Consecutive failures before marking a model/provider as unavailable
 */
export const RATE_LIMITS = {
  cooldownMs: 60000,
  maxFailures: 3
};

/**
 * Configuration for the response caching system.
 * Controls memory usage and persistence frequency.
 * 
 * @constant
 * @type {Object}
 * @property {number} maxEntries - Maximum number of items in the LRU cache
 * @property {number} defaultTTL - Default time-to-live for cache entries (30 minutes)
 * @property {number} maxTTL - Maximum allowable TTL (24 hours)
 * @property {number} cleanupInterval - How often to run expired item cleanup (5 minutes)
 * @property {number} persistDebounceMs - Debounce time for saving cache to disk (5 seconds)
 */
export const CACHE_CONFIG = {
  maxEntries: 1000,
  defaultTTL: 1800000,
  maxTTL: 86400000,
  cleanupInterval: 300000,
  persistDebounceMs: 5000
};

/**
 * Configuration for conversation management and history.
 *
 * @constant
 * @type {Object}
 * @property {number} maxMessages - Maximum messages to retain in active memory
 * @property {number} maxTotalTokens - Soft limit for total context size
 * @property {number} expirationMs - Time before a stale conversation is archived (24 hours)
 */
export const CONVERSATION_CONFIG = {
  maxMessages: 100,
  maxTotalTokens: 1000000,
  expirationMs: 86400000
};

/**
 * CLI-specific timeouts for user-facing operations.
 * These are typically shorter than background operation timeouts
 * to provide responsive user feedback.
 *
 * @constant
 * @type {Object}
 * @property {number} AUTH_TEST - Timeout for authentication tests (15 seconds)
 * @property {number} AUTH_SPAWN - Timeout for spawning auth processes (30 seconds)
 * @property {number} COMMAND - Default timeout for CLI commands (60 seconds)
 * @property {number} SPINNER_UPDATE - Interval for spinner status updates (100ms)
 */
export const CLI_TIMEOUTS = {
  AUTH_TEST: 15000,
  AUTH_SPAWN: 30000,
  COMMAND: 60000,
  SPINNER_UPDATE: 100
};

/**
 * Output size limits for MCP tool responses.
 * Claude Code has limits on tool result sizes. These thresholds help
 * manage large outputs by truncating or summarizing when needed.
 *
 * Token estimation: ~4 characters per token (conservative)
 * Claude Code limits:
 *   - MCP tool results: ~20-25K tokens
 *   - Read tool: 25K tokens
 *
 * @constant
 * @type {Object}
 * @property {number} CHARS_PER_TOKEN - Estimated characters per token (conservative)
 * @property {number} MCP_TOKEN_LIMIT - MCP result token limit (~20K tokens)
 * @property {number} READ_TOKEN_LIMIT - Claude Read tool token limit (25K tokens)
 * @property {number} MCP_SOFT_LIMIT - Soft limit before summarization kicks in (~80KB = ~20K tokens)
 * @property {number} MCP_HARD_LIMIT - Hard limit for MCP responses (~160KB = ~40K tokens)
 * @property {number} SUMMARY_TARGET - Target size for auto-summarized output (~40KB = ~10K tokens)
 * @property {number} SUMMARY_FILE_TARGET - Target size for summary file that fits in Read (~80KB = ~20K tokens)
 * @property {number} TRUNCATE_TAIL_LINES - Lines to keep from end when truncating
 */
export const OUTPUT_LIMITS = {
  CHARS_PER_TOKEN: 4,
  MCP_TOKEN_LIMIT: 20000,
  READ_TOKEN_LIMIT: 25000,
  MCP_SOFT_LIMIT: 80000,      // ~20K tokens - triggers summarization
  MCP_HARD_LIMIT: 160000,     // ~40K tokens - max MCP response
  SUMMARY_TARGET: 40000,      // ~10K tokens - target for truncated output
  SUMMARY_FILE_TARGET: 80000, // ~20K tokens - summary file that fits in Read tool
  TRUNCATE_TAIL_LINES: 50
};

/**
 * Retrieves a timeout value by type safely.
 * Defaults to TIMEOUTS.DEFAULT if the type is invalid.
 * 
 * @param {string} type - The key from TIMEOUTS (e.g., 'QUICK', 'LONG').
 * @returns {number} The timeout in milliseconds.
 */
export function getTimeout(type) {
  if (type && TIMEOUTS[type]) {
    return TIMEOUTS[type];
  }
  return TIMEOUTS.DEFAULT;
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * Useful for logging and error messages.
 * 
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} Human-readable duration (e.g., "5s", "2m", "300ms").
 */
export function formatTimeout(ms) {
  if (!Number.isFinite(ms)) return 'unknown';

  if (ms >= 60000) {
    const minutes = Math.round((ms / 60000) * 10) / 10;
    return `${minutes}m`;
  }
  
  if (ms >= 1000) {
    const seconds = Math.round((ms / 1000) * 10) / 10;
    return `${seconds}s`;
  }

  return `${ms}ms`;
}