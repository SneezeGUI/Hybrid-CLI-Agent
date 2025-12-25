/**
 * @fileoverview Central configuration entry point for the Hybrid CLI Agent.
 * Re-exports all configuration constants and provides a unified CONFIG object for easy access.
 */

import * as Models from './models.js';
import * as Pricing from './pricing.js';
import * as Timeouts from './timeouts.js';

// Re-export all named exports for direct access
export * from './models.js';
export * from './pricing.js';
export * from './timeouts.js';

/**
 * Unified configuration object containing commonly used settings from all config modules.
 * This provides a single access point for structural configuration.
 * 
 * @constant
 * @type {Object}
 */
export const CONFIG = {
  /**
   * Model definitions and configuration.
   */
  models: {
    gemini: Models.GEMINI_MODELS,
    claude: Models.CLAUDE_MODELS,
    openRouter: Models.OPENROUTER_MODELS,
    valid: Models.VALID_MODELS
  },

  /**
   * Pricing configurations (USD per 1M tokens).
   */
  pricing: {
    gemini: Pricing.GEMINI_PRICING,
    claude: Pricing.CLAUDE_PRICING,
    openRouter: Pricing.OPENROUTER_PRICING,
    default: Pricing.DEFAULT_PRICING
  },

  /**
   * Timeout values for various operations.
   */
  timeouts: Timeouts.TIMEOUTS,

  /**
   * Rate limiting configuration for external APIs.
   */
  rateLimits: Timeouts.RATE_LIMITS,

  /**
   * Caching system configuration.
   */
  cache: Timeouts.CACHE_CONFIG,

  /**
   * Conversation management configuration.
   */
  conversation: Timeouts.CONVERSATION_CONFIG,

  /**
   * CLI-specific timeouts for user-facing operations.
   */
  cli: Timeouts.CLI_TIMEOUTS,

  /**
   * Output size limits for MCP tool responses.
   */
  outputLimits: Timeouts.OUTPUT_LIMITS
};