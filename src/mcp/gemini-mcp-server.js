#!/usr/bin/env node
/**
 * Hybrid Agent MCP Server
 *
 * Exposes Hybrid Agent tools for Claude Code to use.
 * This enables the "Context Arbitrage" pattern:
 * - Claude (expensive) never sees raw massive files
 * - Gemini (free with Pro subscription) does the heavy lifting
 * - Claude only sees distilled summaries
 *
 * Authentication Methods:
 * 1. OAuth (gemini auth login) - RECOMMENDED for Pro/Ultra subscribers
 *    Benefits: 60 RPM, 1000 RPD FREE
 *
 * 2. API Key (GEMINI_API_KEY env var)
 *    Get key: https://makersuite.google.com/app/apikey
 *
 * 3. Vertex AI (VERTEX_API_KEY env var)
 *    Benefits: Access to Gemini 3 Pro without restrictions
 *
 * Configuration:
 * - Environment variables can be set in system env or a .env file
 * - .env file is loaded from the server's working directory
 *
 * Install: claude mcp add gemini-worker -- node /path/to/gemini-mcp-server.js
 */

import { readFile, readdir, stat } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { glob } from 'glob';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getResponseCache } from '../services/response-cache.js';
import { applyEnvFile } from '../utils/env.js';
import { getContextFileCache } from '../utils/file-cache.js';
import { analyzeStderr, createTypedError } from './tool-handlers/base.js';

// Get project root from script location (works for system-wide MCP use)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..'); // src/mcp -> project root

// Load .env files before AUTH_CONFIG is initialized
// Checks: GEMINI_WORKER_ROOT env var > project root > cwd > ~/.env.gemini
applyEnvFile(process.cwd(), { silent: false, projectRoot: PROJECT_ROOT });
import {
  sanitizePath,
  sanitizeGlobPatterns,
  TIMEOUTS,
  safeSpawn,
  isAgentModeEnabled,
} from '../utils/security.js';
import {
  GEMINI_MODELS,
  GEMINI_PRICING,
  RATE_LIMITS,
  AUTH_DEFAULTS,
} from '../config/index.js';

// ============================================================================ 
// Authentication Configuration with Fallback Chain
// ============================================================================ 

/**
 * Auth priority (highest to lowest):
 * 1. OAuth (Pro/Ultra subscription) - FREE, highest rate limits for subscribers
 * 2. Gemini API Key - Pay per use
 * 3. Vertex AI Key - Enterprise, higher limits
 *
 * The system will try OAuth first, falling back to API keys if OAuth fails.
 */
const AUTH_CONFIG = {
  // Primary method (what we try first)
  method: 'oauth', // Always try OAuth first
  // Available credentials for fallback
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  vertexKey: process.env.VERTEX_API_KEY,
  vertexProject: process.env.VERTEX_PROJECT,
  vertexLocation: process.env.VERTEX_LOCATION || AUTH_DEFAULTS.vertexLocation,
  // Fallback chain
  fallbackChain: buildFallbackChain(),
  // Current active method (may change after fallback)
  activeMethod: null,
  // Track auth failures for fallback
  authFailures: {},
};

/**
 * Build the authentication fallback chain
 * Priority: OAuth > Gemini API Key > Vertex API Key
 */
function buildFallbackChain() {
  const chain = [];

  // Priority 1: OAuth (Pro/Ultra subscription)
  chain.push({
    method: 'oauth',
    name: 'OAuth (Pro/Ultra)',
    available: true, // Always available to try
    env: {},
  });

  // Priority 2: Gemini API Key
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (apiKey) {
    chain.push({
      method: 'api-key',
      name: 'Gemini API Key',
      available: true,
      env: { GEMINI_API_KEY: apiKey },
    });
  }

  // Priority 3: Vertex AI
  if (process.env.VERTEX_API_KEY) {
    chain.push({
      method: 'vertex',
      name: 'Vertex AI',
      available: true,
      env: {
        VERTEX_API_KEY: process.env.VERTEX_API_KEY,
        VERTEX_PROJECT: process.env.VERTEX_PROJECT,
        VERTEX_LOCATION: process.env.VERTEX_LOCATION || AUTH_DEFAULTS.vertexLocation,
      },
    });
  }

  return chain;
}

/**
 * Get the next available auth method in the fallback chain
 * @param {string} currentMethod - The method that just failed
 * @returns {Object|null} - Next auth config or null if no more fallbacks
 */
function getNextAuthFallback(currentMethod) {
  const chain = AUTH_CONFIG.fallbackChain;
  const currentIndex = chain.findIndex(c => c.method === currentMethod);

  // Find next available method
  for (let i = currentIndex + 1; i < chain.length; i++) {
    if (chain[i].available && !AUTH_CONFIG.authFailures[chain[i].method]) {
      return chain[i];
    }
  }

  return null;
}

/**
 * Record an auth failure for a method
 */
function recordAuthFailure(method, error) {
  AUTH_CONFIG.authFailures[method] = {
    error: error.message || String(error),
    timestamp: Date.now(),
  };
  console.error(`[gemini-worker] Auth failed for ${method}: ${error.message || error}`);
}

/**
 * Get the currently active auth method
 */
function getActiveAuthMethod() {
  if (AUTH_CONFIG.activeMethod) return AUTH_CONFIG.activeMethod;

  // Find first non-failed method in chain
  for (const auth of AUTH_CONFIG.fallbackChain) {
    if (!AUTH_CONFIG.authFailures[auth.method]) {
      return auth.method;
    }
  }

  return 'oauth'; // Default fallback
}

/**
 * Reset auth failures after a timeout to allow retrying
 * Failed methods are reset after 5 minutes
 */
const AUTH_FAILURE_TIMEOUT = RATE_LIMITS.authFailureTimeoutMs; // 5 minutes

function resetExpiredAuthFailures() {
  const now = Date.now();
  for (const [method, failure] of Object.entries(AUTH_CONFIG.authFailures)) {
    if (now - failure.timestamp > AUTH_FAILURE_TIMEOUT) {
      delete AUTH_CONFIG.authFailures[method];
      console.error(`[gemini-worker] Auth failure for ${method} expired, will retry`);
    }
  }
}

// ============================================================================ 
// Model Selection System
// ============================================================================ 

/**
 * Model capabilities and characteristics
 * Imported from centralized config (src/config/models.js)
 *
 * Gemini 3 Pro is available to:
 * - Pro/Ultra subscribers (OAuth) - with rate limits
 * - API key users - with rate limits
 * - Vertex AI users - higher limits
 */
const MODEL_CAPABILITIES = GEMINI_MODELS;

/**
 * Task type classifications for smart model routing
 */
const TASK_TYPES = {
  // Complex tasks - prefer most capable model
  complex: {
    tools: [
      'gemini_agent_task',
    ],
    promptIndicators: [
      /implement|architect|design|refactor|optimize/i,
      /security|vulnerability|exploit/i,
      /complex|sophisticated|advanced/i,
      /multi-step|end-to-end|comprehensive/i,
      /\b(class|interface|module|component|system)\s+design/i,
    ],
    preferredTier: 1,
  },
  // Standard tasks - balanced model
  standard: {
    tools: [
      'gemini_config_show',
      'gemini_auth_status',
    ],
    promptIndicators: [
      /analyze|review|explain|compare/i,
      /what|how|why|where/i,
      /find|search|look for/i,
    ],
    preferredTier: 2,
  },
  // Simple tasks - fast model
  simple: {
    tools: [
      'gemini_health_check',
      'hybrid_metrics',
      'gemini_agent_list',
      'gemini_agent_clear',
    ],
    promptIndicators: [
      /summarize|overview|brief/i,
      /quick|simple|basic/i,
      /list|enumerate/i,
    ],
    preferredTier: 3,
  },
};

/**
 * Rate limit tracking per model
 * Uses RATE_LIMITS from centralized config (src/config/timeouts.js)
 */
const rateLimitTracker = {
  failures: {},      // { model: { count, lastFailure } }
  cooldownMs: RATE_LIMITS.cooldownMs,
  maxFailures: RATE_LIMITS.maxFailures,

  recordFailure(model) {
    if (!this.failures[model]) {
      this.failures[model] = { count: 0, lastFailure: 0 };
    }
    this.failures[model].count++;
    this.failures[model].lastFailure = Date.now();
  },

  recordSuccess(model) {
    if (this.failures[model]) {
      this.failures[model].count = Math.max(0, this.failures[model].count - 1);
    }
  },

  isAvailable(model) {
    const tracker = this.failures[model];
    if (!tracker || tracker.count < this.maxFailures) return true;

    // Check if cooldown has passed
    if (Date.now() - tracker.lastFailure > this.cooldownMs) {
      tracker.count = 0;  // Reset after cooldown
      return true;
    }
    return false;
  },

  reset(model) {
    delete this.failures[model];
  },
};

// ============================================================================ 
// Token Usage Tracking (for cost estimation and metrics)
// ============================================================================ 

/**
 * Pricing per 1M tokens (API pricing - OAuth users get FREE tier)
 * Imported from centralized config (src/config/pricing.js)
 */
const MODEL_PRICING = GEMINI_PRICING;

/**
 * Token usage tracker with cost estimation
 * Populated automatically when using JSON output format
 */
const tokenTracker = {
  totalInput: 0,
  totalOutput: 0,
  totalCost: 0,
  requestCount: 0,
  byModel: {},

  /**
   * Record token usage from a request
   * @param {string} model - Model used
   * @param {number} inputTokens - Input tokens consumed
   * @param {number} outputTokens - Output tokens generated
   */
  record(model, inputTokens, outputTokens) {
    this.totalInput += inputTokens;
    this.totalOutput += outputTokens;
    this.requestCount++;

    // Calculate cost (0 if OAuth)
    const pricing = MODEL_PRICING[model] || MODEL_PRICING['gemini-2.5-pro'];
    const isFree = getActiveAuthMethod() === 'oauth';
    const cost = isFree ? 0 :
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;
    this.totalCost += cost;

    // Track per-model stats
    if (!this.byModel[model]) {
      this.byModel[model] = { input: 0, output: 0, requests: 0, cost: 0 };
    }
    this.byModel[model].input += inputTokens;
    this.byModel[model].output += outputTokens;
    this.byModel[model].requests++;
    this.byModel[model].cost += cost;
  },

  /**
   * Get usage statistics
   */
  getStats() {
    const isFree = getActiveAuthMethod() === 'oauth';
    return {
      totalInput: this.totalInput,
      totalOutput: this.totalOutput,
      totalTokens: this.totalInput + this.totalOutput,
      totalCost: this.totalCost,
      requestCount: this.requestCount,
      isFree,
      costNote: isFree ? 'FREE (OAuth/Pro subscription)' : `$${this.totalCost.toFixed(4)}`,
      byModel: { ...this.byModel },
    };
  },

  /**
   * Reset statistics
   */
  reset() {
    this.totalInput = 0;
    this.totalOutput = 0;
    this.totalCost = 0;
    this.requestCount = 0;
    this.byModel = {};
  },
};

/**
 * Extract token stats from Gemini JSON response
 * @param {Object} stats - The stats object from JSON response
 * @returns {{ input: number, output: number }}
 */
function extractTokenStats(stats) {
  if (!stats || !stats.models) return { input: 0, output: 0 };

  let totalInput = 0;
  let totalOutput = 0;

  for (const modelStats of Object.values(stats.models)) {
    if (modelStats.tokens) {
      totalInput += modelStats.tokens.input || modelStats.tokens.prompt || 0;
      totalOutput += modelStats.tokens.candidates || modelStats.tokens.output || 0;
    }
  }

  return { input: totalInput, output: totalOutput };
}

/**
 * Get list of models supported by Gemini CLI
 * Note: Gemini 3 models require -preview suffix (gemini-3-pro-preview, gemini-3-flash-preview)
 */
function getSupportedModels() {
  return ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3-pro-preview'];
}

/**
 * Classify task complexity based on tool name and prompt
 * @param {string} toolName - The MCP tool being called
 * @param {string} prompt - The prompt/content being sent
 * @returns {'complex' | 'standard' | 'simple'}
 */
function classifyTaskComplexity(toolName, prompt = '') {
  // Check tool-based classification first
  for (const [taskType, config] of Object.entries(TASK_TYPES)) {
    if (config.tools.includes(toolName)) {
      return taskType;
    }
  }

  // Fall back to prompt-based classification
  if (prompt) {
    // Check complex indicators first (highest priority)
    for (const pattern of TASK_TYPES.complex.promptIndicators) {
      if (pattern.test(prompt)) return 'complex';
    }
    // Check simple indicators (lower priority)
    for (const pattern of TASK_TYPES.simple.promptIndicators) {
      if (pattern.test(prompt)) return 'simple';
    }
  }

  // Default to standard
  return 'standard';
}

/**
 * Smart model selection based on task complexity and availability
 * @param {Object} options
 * @param {string} options.toolName - Name of the tool being called
 * @param {string} options.prompt - The prompt content
 * @param {string} options.explicitModel - User-specified model (overrides smart selection)
 * @param {boolean} options.preferFast - Prefer faster models over capable
 * @returns {string} - Selected model name
 */
function getSmartModel(options = {}) {
  const {
    toolName = '',
    prompt = '',
    explicitModel = null,
    preferFast = false,
  } = options;

  // If user explicitly requested a model, respect that
  if (explicitModel) {
    const supported = getSupportedModels();
    if (supported.includes(explicitModel) && rateLimitTracker.isAvailable(explicitModel)) {
      return explicitModel;
    }
    // Fall through to smart selection if explicit model unavailable
  }

  // Classify task complexity
  const taskType = classifyTaskComplexity(toolName, prompt);
  const preferredTier = preferFast ? 3 : TASK_TYPES[taskType]?.preferredTier || 2;

  // Build ordered list of candidates based on preference
  const supportedModels = getSupportedModels();
  const candidates = Object.entries(MODEL_CAPABILITIES)
    .filter(([model]) => supportedModels.includes(model))
    .sort((a, b) => {
      // Sort by distance from preferred tier
      const distA = Math.abs(a[1].tier - preferredTier);
      const distB = Math.abs(b[1].tier - preferredTier);
      if (distA !== distB) return distA - distB;
      // Prefer more capable model as tiebreaker
      return a[1].tier - b[1].tier;
    })
    .map(([model]) => model);

  // Select first available model
  for (const model of candidates) {
    if (rateLimitTracker.isAvailable(model)) {
      return model;
    }
  }

  // Fallback to most reliable model
  return 'gemini-2.5-pro';
}

/**
 * Legacy function for backwards compatibility
 * Returns the best default model for general use
 */
function getDefaultModel() {
  // For complex tasks, prefer Gemini 3 Pro Preview if available (rate limit permitting)
  // Note: Gemini 3 models require -preview suffix
  if (rateLimitTracker.isAvailable('gemini-3-pro-preview')) {
    return 'gemini-3-pro-preview';
  }
  return 'gemini-2.5-pro';
}

/**
 * Safely extract response text from runGeminiCli result
 * Handles edge cases where response might be undefined or not a string
 * @param {Object|string} result - Result from runGeminiCli
 * @returns {string} - Safe response text
 */
function safeGetResponse(result) {
  // If result is a string (legacy format), return it directly
  if (typeof result === 'string') {
    return result;
  }

  // If result is an object with response property
  if (result && typeof result.response === 'string') {
    return result.response;
  }

  // If result.response exists but isn't a string, convert it
  if (result && result.response !== undefined && result.response !== null) {
    return String(result.response);
  }

  // Debug info for undefined responses
  const debugInfo = result
    ? `[Debug: result type=${typeof result}, keys=${Object.keys(result).join(',')}]`
    : '[Debug: result is null/undefined]';

  console.error(`[gemini-worker] Warning: undefined response. ${debugInfo}`);
  return `Error: No response received from Gemini. ${debugInfo}`;
}

/**
 * Build environment variables based on active auth method from fallback chain
 * @param {string} overrideMethod - Optional method to use instead of active method
 */
function buildEnv(overrideMethod = null) {
  const env = { ...process.env };
  const activeMethod = overrideMethod || getActiveAuthMethod();

  // Find the auth config for the active method
  const authConfig = AUTH_CONFIG.fallbackChain.find(c => c.method === activeMethod);

  if (authConfig && authConfig.env) {
    // Apply environment variables from the auth config
    Object.assign(env, authConfig.env);
  }

  // Legacy fallback for direct config
  if (activeMethod === 'api-key' && AUTH_CONFIG.apiKey) {
    env.GEMINI_API_KEY = AUTH_CONFIG.apiKey;
  }

  if (activeMethod === 'vertex') {
    if (AUTH_CONFIG.vertexKey) env.VERTEX_API_KEY = AUTH_CONFIG.vertexKey;
    if (AUTH_CONFIG.vertexProject) env.VERTEX_PROJECT = AUTH_CONFIG.vertexProject;
    if (AUTH_CONFIG.vertexLocation) env.VERTEX_LOCATION = AUTH_CONFIG.vertexLocation;
  }

  return env;
}

// ============================================================================ 
// Gemini CLI Wrapper
// ============================================================================ 

/**
 * Execute Gemini CLI and return the response
 * Uses local OAuth for FREE tier access (60 RPM, 1000 RPD)
 * Includes automatic rate limit tracking and fallback
 */
async function runGeminiCli(prompt, options = {}) {
  // Reset expired auth failures before each request
  resetExpiredAuthFailures();

  const {
    model: requestedModel = null,
    toolName = '',  // For smart model selection
    workDir = process.cwd(),
    useCache = true,  // Enable caching by default
    cacheTTL = null,  // Use default TTL if not specified
    timeout = TIMEOUTS.LONG,  // Default 2 minute timeout
    // Disable extensions to prevent Gemini from trying to use tools like write_file
    // Extensions provide tools (file operations, code execution, etc.)
    // Set to true to enable extensions if you have them properly configured
    enableExtensions = process.env.GEMINI_AGENT_MODE === 'true',
    preferFast = false,  // Prefer faster models for simple tasks
    retryOnRateLimit = true,  // Automatically retry with fallback model
  } = options;

  // Smart model selection based on task complexity
  const model = getSmartModel({
    toolName,
    prompt,
    explicitModel: requestedModel,
    preferFast,
  });

  // Check cache first (if enabled)
  if (useCache) {
    const cache = getResponseCache();
    const cached = cache.get(prompt, { model });
    if (cached) {
      rateLimitTracker.recordSuccess(model);  // Cached response = model working
      // Return structured response matching non-cached format
      return {
        response: cached + '\n_[cached response]_',
        model,
        authMethod: getActiveAuthMethod(),
        tokens: { input: 0, output: 0 },  // No tokens for cached response
        cached: true,
      };
    }
  }

  const executeRequest = async (selectedModel, authMethod = null, _isRetry = false) => {
    return new Promise((resolve, reject) => {
      // Use stdin to pass prompt (avoids command line length limits on Windows)
      // Use JSON output format for structured responses with token tracking
      const args = ['--model', selectedModel, '--output-format', 'json'];

      // When extensions are disabled, pass a non-existent extension to prevent tool usage
      // This forces Gemini to return pure text without trying to use tools
      if (!enableExtensions) {
        args.push('--extensions', 'none');
      }

      // SECURITY: Use safeSpawn to prevent command injection (no shell: true)
      const proc = safeSpawn(spawn, 'gemini', args, {
        cwd: workDir,
        env: buildEnv(authMethod),
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      const currentAuthMethod = authMethod || getActiveAuthMethod();

      // Set up timeout
      const timeoutId = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
        rateLimitTracker.recordFailure(selectedModel);
        reject(new Error(`Gemini CLI timed out after ${timeout / 1000}s`));
      }, timeout);

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        if (killed) return;

        if (code === 0) {
          // Success - update active method if this was a fallback
          if (authMethod && authMethod !== AUTH_CONFIG.activeMethod) {
            AUTH_CONFIG.activeMethod = authMethod;
            console.error(`[gemini-worker] Auth method set to: ${authMethod}`);
          }
          rateLimitTracker.recordSuccess(selectedModel);

          // Parse JSON response for structured output
          let response = stdout.trim();
          let tokens = { input: 0, output: 0 };

          try {
            // Try to extract JSON blob even if there's warning text before/after it
            // This handles cases where CLI outputs warnings before the JSON response
            let jsonText = stdout;
            const jsonMatch = stdout.match(/\{[\s\S]*}/);
            if (jsonMatch) {
              jsonText = jsonMatch[0];
            }

            const jsonResponse = JSON.parse(jsonText);
            response = jsonResponse.response || stdout.trim();
            tokens = extractTokenStats(jsonResponse.stats);

            // Track token usage
            if (tokens.input > 0 || tokens.output > 0) {
              tokenTracker.record(selectedModel, tokens.input, tokens.output);
            }
          } catch (parseError) {
            // Fallback to raw text if JSON parsing fails (backward compatibility)
            console.error(`[gemini-worker] JSON parse warning: ${parseError.message}`);
          }

          resolve({ response, model: selectedModel, authMethod: currentAuthMethod, tokens });
        } else {
          const analysis = analyzeStderr(stderr);

          if (analysis.isRateLimit || analysis.isModelError) {
            if (analysis.isModelError) {
              console.error(`[gemini-worker] Model error for ${selectedModel}, will try fallback`);
            }
            rateLimitTracker.recordFailure(selectedModel);
            reject({
              isRateLimit: analysis.isRateLimit,
              isModelError: analysis.isModelError,
              model: selectedModel,
              error: stderr,
              analysis
            });
          } else if (analysis.isAuthError) {
            reject({
              isAuthError: true,
              authMethod: currentAuthMethod,
              error: stderr,
              analysis
            });
          } else {
            reject(createTypedError(analysis, stderr.trim() || 'Unknown CLI error', {
              model: selectedModel,
              authMethod: currentAuthMethod,
              provider: 'gemini'
            }));
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        if (killed) return;
        reject(new Error(`Failed to spawn Gemini CLI: ${err.message}. Is it installed? npm i -g @google/gemini-cli`));
      });

      // Write prompt to stdin and close it to signal end of input
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  };

  try {
    const result = await executeRequest(model);

    // Store in cache (if enabled)
    if (useCache) {
      const cache = getResponseCache();
      cache.set(prompt, result.response, { model: result.model, ttl: cacheTTL });
    }

    // Add model info if different from requested
    const modelNote = result.model !== requestedModel && requestedModel
      ? `\n_[used ${result.model}]_`
      : '';

    // Return structured response
    return {
      response: result.response + modelNote,
      model: result.model,
      authMethod: result.authMethod,
      tokens: result.tokens,
    };
  } catch (error) {
    // Handle authentication errors with fallback chain
    if (error.isAuthError) {
      const failedMethod = error.authMethod;
      recordAuthFailure(failedMethod, error.error || 'Authentication failed');

      // Try next auth method in fallback chain
      const nextAuth = getNextAuthFallback(failedMethod);
      if (nextAuth) {
        console.error(`[gemini-worker] Auth failed for ${failedMethod}, trying ${nextAuth.name}...`);
        try {
          const retryResult = await executeRequest(model, nextAuth.method, true);

          // Store in cache
          if (useCache) {
            const cache = getResponseCache();
            cache.set(prompt, retryResult.response, { model: retryResult.model, ttl: cacheTTL });
          }

          return {
            response: retryResult.response + `\n_[auth: ${nextAuth.name}]_`,
            model: retryResult.model,
            authMethod: nextAuth.method,
            tokens: retryResult.tokens,
          };
        } catch (retryError) {
          // If retry also fails with auth error, try the next fallback
          if (retryError.isAuthError) {
            recordAuthFailure(nextAuth.method, retryError.error || 'Authentication failed');
            const nextNextAuth = getNextAuthFallback(nextAuth.method);
            if (nextNextAuth) {
              console.error(`[gemini-worker] Auth failed for ${nextAuth.method}, trying ${nextNextAuth.name}...`);
              const finalResult = await executeRequest(model, nextNextAuth.method, true);

              if (useCache) {
                const cache = getResponseCache();
                cache.set(prompt, finalResult.response, { model: finalResult.model, ttl: cacheTTL });
              }

              return {
                response: finalResult.response + `\n_[auth: ${nextNextAuth.name}]_`,
                model: finalResult.model,
                authMethod: nextNextAuth.method,
                tokens: finalResult.tokens,
              };
            }
          }
          throw retryError;
        }
      }

      // No more fallbacks available
      const availableMethods = AUTH_CONFIG.fallbackChain
        .filter(c => !AUTH_CONFIG.authFailures[c.method])
        .map(c => c.name)
        .join(', ');
      throw new Error(`Gemini authentication failed. Tried: ${failedMethod}. ` +
        `Available methods: ${availableMethods || 'none'}. ` +
        `Run 'gemini auth login' for OAuth or set GEMINI_API_KEY/VERTEX_API_KEY.`);
    }

    // Handle rate limit with fallback
    if (error.isRateLimit && retryOnRateLimit) {
      // Try to get a fallback model
      const fallbackModel = getSmartModel({
        toolName,
        prompt,
        explicitModel: null,  // Let smart selection pick a different model
        preferFast: true,     // Prefer faster/more available models
      });

      if (fallbackModel !== model && rateLimitTracker.isAvailable(fallbackModel)) {
        console.error(`Rate limit hit on ${model}, falling back to ${fallbackModel}`);
        const retryResult = await executeRequest(fallbackModel, null, true);

        // Store in cache with fallback model
        if (useCache) {
          const cache = getResponseCache();
          cache.set(prompt, retryResult.response, { model: fallbackModel, ttl: cacheTTL });
        }

        return {
          response: retryResult.response + `\n_[fallback: ${fallbackModel}]_`,
          model: fallbackModel,
          authMethod: retryResult.authMethod,
          tokens: retryResult.tokens,
        };
      }
    }

    // Re-throw if we can't handle it
    throw error.error ? new Error(error.error) : error;
  }
}

/**
 * Read files from glob patterns with memory protection and optional caching
 * @param {string[]} patterns - Glob patterns
 * @param {string} baseDir - Base directory
 * @param {Object} options - Options
 * @param {number} options.maxFileSize - Max bytes per file (default 500KB)
 * @param {number} options.maxTotalSize - Max total bytes (default 5MB)
 * @param {number} options.maxFiles - Max number of files (default 100)
 * @param {boolean} options.useCache - Use file content cache (default true)
 */
async function readFilesFromPatterns(patterns, baseDir = process.cwd(), options = {}) {
  const {
    maxFileSize = 500 * 1024,    // 500KB per file
    maxTotalSize = 5 * 1024 * 1024, // 5MB total
    maxFiles = 100,
    useCache = true,
  } = options;

  const results = [];
  let totalSize = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  // Get file cache if caching is enabled
  const fileCache = useCache ? getContextFileCache() : null;

  for (const pattern of patterns) {
    if (results.length >= maxFiles) {
      console.error(`[readFilesFromPatterns] Max files limit reached (${maxFiles})`);
      break;
    }

    try {
      const matches = await glob(pattern, {
        cwd: baseDir,
        absolute: true,
        nodir: true,
      });

      for (const filepath of matches) {
        if (results.length >= maxFiles) break;
        if (totalSize >= maxTotalSize) {
          console.error(`[readFilesFromPatterns] Max total size reached (${maxTotalSize} bytes)`);
          break;
        }

        try {
          // Check file size before reading
          const stats = await stat(filepath);

          if (stats.size > maxFileSize) {
            // Skip very large files with warning
            const relativePath = filepath.replace(baseDir, '').replace(/^[\/\\]/, '');
            results.push({
              path: relativePath,
              content: `[File too large: ${(stats.size / 1024).toFixed(1)}KB > ${(maxFileSize / 1024).toFixed(1)}KB limit]`,
              skipped: true,
            });
            continue;
          }

          // Use cache if available, otherwise read directly
          let content;
          let fromCache = false;

          if (fileCache) {
            const cached = await fileCache.getFile(filepath);
            if (cached) {
              content = cached.content;
              fromCache = cached.fromCache;
              if (fromCache) {
                cacheHits++;
              } else {
                cacheMisses++;
              }
            }
          }

          // Fallback to direct read if cache is disabled or getFile returned null
          if (content === undefined) {
            content = await readFile(filepath, 'utf-8');
            cacheMisses++;
          }

          const relativePath = filepath.replace(baseDir, '').replace(/^[\/\\]/, '');

          // Check if this would exceed total size
          if (totalSize + content.length > maxTotalSize) {
            // Truncate to fit
            const available = maxTotalSize - totalSize;
            const truncated = content.slice(0, available) + '\n... [truncated due to total size limit]';
            results.push({ path: relativePath, content: truncated, truncated: true });
            totalSize = maxTotalSize;
            break;
          }

          results.push({ path: relativePath, content, fromCache });
          totalSize += content.length;
        } catch (e) {
          // Report unreadable files instead of silently skipping
          const relativePath = filepath.replace(baseDir, '').replace(/^[\/\\]/, '');
          results.push({
            path: relativePath,
            content: `[ERROR: Could not read file - ${e.code || e.message}]`,
            error: true,
          });
        }
      }
    } catch (e) {
      // Report invalid patterns instead of silently skipping
      results.push({
        path: pattern,
        content: `[ERROR: Invalid pattern or glob error - ${e.message}]`,
        error: true,
      });
    }
  }

  // Log cache stats if caching was used
  if (fileCache && (cacheHits > 0 || cacheMisses > 0)) {
    const hitRate = cacheHits + cacheMisses > 0
      ? Math.round((cacheHits / (cacheHits + cacheMisses)) * 100)
      : 0;
    console.error(`[readFilesFromPatterns] Cache: ${cacheHits} hits, ${cacheMisses} misses (${hitRate}% hit rate)`);
  }

  return results;
}

// ============================================================================ 
// MCP Server Setup
// ============================================================================ 

const server = new Server(
  {
    name: 'hybrid-agent',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ============================================================================ 
// Tool Definitions (8 Tools)
// ============================================================================ 

const ALL_TOOLS = [
  // === Core Tools (4) ===
  {
    name: 'gemini_auth_status',
    description: `Check Gemini authentication status and available features.
Returns info about which auth method is being used and what models are available.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'hybrid_metrics',
    description: `Get comprehensive metrics for the hybrid agent.
Shows costs, usage, and performance stats for both Gemini and OpenRouter.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'gemini_config_show',
    description: `Show current configuration and environment settings.
USE THIS to verify your setup is correct and see active settings.
Sensitive values (API keys) are masked for security.`,
    inputSchema: {
      type: 'object',
      properties: {
        show_env: {
          type: 'boolean',
          description: 'Include environment variables in output',
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: 'gemini_health_check',
    description: `Check Gemini CLI health and connectivity.
USE THIS to verify the system is working correctly, measure latency, and check model availability.
Returns overall health status, authentication status, and cache statistics.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // === Agent Tools (3) ===
  {
    name: 'gemini_agent_task',
    description: `**AUTONOMOUS AGENT** - Delegate complete tasks to Gemini's agent mode.

USE THIS FOR:
- Multi-step implementation tasks requiring file creation/modification
- Tasks that need shell commands (npm test, git, build)
- Complex refactoring across multiple files
- Iterative development (write -> test -> fix -> repeat)

CAPABILITIES:
- Native file system access (read/write/create)
- Shell command execution (npm, git, node, etc.)
- Session persistence for long-running tasks
- Automatic retry and recovery

SAFETY:
- Iteration limits prevent infinite loops
- Timeout protection
- All file mutations tracked for review

REQUIRES: GEMINI_AGENT_MODE=true in environment

WORKFLOW:
1. Start task with task_description
2. Monitor progress via structured output
3. Resume interrupted sessions with session_id
4. Review results with \`git diff
`,
    inputSchema: {
      type: 'object',
      properties: {
        task_description: {
          type: 'string',
          description: 'Detailed description of the task to accomplish',
        },
        working_directory: {
          type: 'string',
          description: 'Directory to execute in (defaults to cwd)',
        },
        session_id: {
          type: 'string',
          description: 'Resume a previous session (from prior gemini_agent_task call)',
        },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files Gemini should reference',
        },
        max_iterations: {
          type: 'integer',
          default: 50,
          description: 'Maximum tool calls before stopping (safety limit)',
        },
        timeout_minutes: {
          type: 'integer',
          default: 10,
          description: 'Maximum execution time in minutes',
        },
        stall_timeout_seconds: {
          type: 'integer',
          default: 300,
          description: 'Time in seconds without activity before stall timeout (5 min default)',
        },
        verbose: {
          type: 'boolean',
          default: false,
          description: 'Return larger output (up to 100k chars) in MCP response',
        },
        max_retries: {
          type: 'integer',
          default: 0,
          description: 'Number of auto-retries for transient failures',
        },
        background: {
          type: 'boolean',
          default: false,
          description: 'Run task in background - returns immediately with session_id for polling via gemini_agent_list',
        },
        model: {
          type: 'string',
          enum: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview'],
          description: 'Model to use (auto-selected if not specified)',
        },
      },
      required: ['task_description'],
    },
  },
  {
    name: 'gemini_agent_list',
    description: `List active agent sessions.
USE THIS to see running or completed agent tasks and their status.`,
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'running', 'pending_review', 'completed', 'rejected', 'failed'],
          description: 'Filter by session status',
        },
      },
    },
  },
  {
    name: 'gemini_agent_clear',
    description: `Clear/delete an agent session.
USE THIS to clean up completed or failed sessions.`,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'ID of the session to delete',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'gemini_agent_approve',
    description: `**REQUIRED** - Approve or reject changes from a Gemini agent task.

USE THIS AFTER any gemini_agent_task that returns PENDING_REVIEW status.

This tool enforces Claude review of all file modifications made by Gemini.

WORKFLOW:
1. gemini_agent_task returns PENDING_REVIEW with file changes
2. Review the changes carefully
3. Call gemini_agent_approve to approve or reject

OPTIONS:
- approved: true → Changes are finalized
- approved: false → Session marked rejected
- fixes: Apply inline corrections before approving`,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID from the pending review',
        },
        approved: {
          type: 'boolean',
          description: 'Whether to approve the changes',
        },
        fixes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: 'Path to file to fix' },
              search: { type: 'string', description: 'Text to find' },
              replace: { type: 'string', description: 'Replacement text' },
            },
            required: ['file', 'search', 'replace'],
          },
          description: 'Optional inline fixes to apply before finalizing',
        },
        feedback: {
          type: 'string',
          description: 'Feedback if rejecting (explains why)',
        },
      },
      required: ['session_id', 'approved'],
    },
  },
];

// ============================================================================ 
// Conditional Tool Registration
// ============================================================================ 

// If agent mode is enabled, we use all tools.
// If not, we still show auth/config/health/metrics but agent tools will fail or be hidden.
// Since we are removing all legacy tools, effectively all remaining tools should be available
// or we can restrict agent tools if mode is disabled.
const TOOLS = ALL_TOOLS;

// Log active mode
if (isAgentModeEnabled()) {
  console.error('[gemini-worker] Agent Mode ENABLED - all 8 tools active');
} else {
  console.error('[gemini-worker] Agent Mode DISABLED - agent tools will require enablement');
}

// ============================================================================ 
// Tool Handlers
// ============================================================================ 

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'gemini_auth_status': {
        // Check authentication status
        const authInfo = await new Promise((resolve) => {
          // SECURITY: Use safeSpawn to prevent command injection
          const proc = safeSpawn(spawn, 'gemini', ['auth', 'status'], { env: buildEnv() });
          let output = '';
          proc.stdout.on('data', (d) => { output += d.toString(); });
          proc.stderr.on('data', (d) => { output += d.toString(); });
          proc.on('close', (code) => {
            resolve({
              authenticated: code === 0,
              output: output.trim(),
            });
          });
          proc.on('error', () => resolve({ authenticated: false, output: 'CLI not found' }));
        });

        // Get fallback chain info
        const activeMethod = getActiveAuthMethod();
        const fallbackChain = AUTH_CONFIG.fallbackChain;
        const failedMethods = Object.keys(AUTH_CONFIG.authFailures);

        const status = {
          activeMethod,
          primaryMethod: AUTH_CONFIG.method,
          authenticated: authInfo.authenticated,
          defaultModel: getDefaultModel(),
          availableModels: getSupportedModels(),
          isFree: activeMethod === 'oauth',
          details: authInfo.output,
          tips: [],
        };

        // Build fallback chain display
        const chainDisplay = fallbackChain.map((auth, i) => {
          const isActive = auth.method === activeMethod;
          const isFailed = AUTH_CONFIG.authFailures[auth.method];
          const marker = isActive ? '>>> ' : isFailed ? '[X] ' : '    ';
          const suffix = isActive ? ' (active)' : isFailed ? ' (failed)' : '';
          return `${marker}${i + 1}. ${auth.name}${suffix}`;
        }).join('\n');

        if (!authInfo.authenticated && activeMethod === 'oauth') {
          status.tips.push('Run "gemini auth login" to authenticate with your Google account');
          status.tips.push('Pro/Ultra subscribers get 60 RPM and 1000 RPD FREE');
        }
        if (activeMethod === 'api-key') {
          status.tips.push('Using API key - consider OAuth for higher rate limits');
        }
        if (activeMethod === 'vertex') {
          status.tips.push('Using Vertex AI - higher rate limits available');
        }
        if (failedMethods.length > 0) {
          status.tips.push(`Failed auth methods will be retried after 5 minutes`);
        }

        return {
          content: [{
            type: 'text',
            text: `Gemini Authentication Status:
- Active Method: ${status.activeMethod}
- OAuth Status: ${status.authenticated ? 'Authenticated' : 'Not authenticated'}
- Default Model: ${status.defaultModel}
- Available Models: ${status.availableModels.join(', ')}
- Free Tier: ${status.isFree ? 'Yes (OAuth/Pro subscription)' : 'No (billed per token)'}

Authentication Fallback Chain:
${chainDisplay}
${status.tips.length > 0 ? '\nTips:\n' + status.tips.map(t => '- ' + t).join('\n') : ''}`
          }],
        };
      }

      case 'hybrid_metrics': {
        const authInfo = AUTH_CONFIG;
        const geminiStats = tokenTracker.getStats();

        // Format per-model breakdown
        const modelBreakdown = Object.entries(geminiStats.byModel)
          .map(([model, stats]) => `  - ${model}: ${stats.input.toLocaleString()} in / ${stats.output.toLocaleString()} out (${stats.requests} reqs)`)
          .join('\n') || '  (no requests yet)';

        return {
          content: [{
            type: 'text', text: `# Hybrid Agent Metrics

## Gemini CLI
- Auth method: ${authInfo.method}
- Free tier: ${authInfo.method === 'oauth' ? 'Yes (60 RPM, 1000 RPD)' : 'No'}
- Default model: ${getDefaultModel()}

### Token Usage (Session)
- Requests: ${geminiStats.requestCount}
- Input tokens: ${geminiStats.totalInput.toLocaleString()}
- Output tokens: ${geminiStats.totalOutput.toLocaleString()}
- Total tokens: ${geminiStats.totalTokens.toLocaleString()}
- Estimated cost: ${geminiStats.costNote}

### By Model
${modelBreakdown}

## OpenRouter (Removed)
- OpenRouter tools have been removed in this version.

## Available Tools: 8
- Core Tools: 4
- Agent Tools: 4` }],
        };
      }

      case 'gemini_config_show': {
        const { show_env = false } = args;

        // Mask sensitive values
        const maskValue = (val) => {
          if (!val) return '(not set)';
          if (val.length <= 8) return '****';
          return val.substring(0, 4) + '*'.repeat(Math.min(val.length - 4, 16));
        };

        // Get rate limit status
        const modelStatus = getSupportedModels().map(model => {
          const caps = MODEL_CAPABILITIES[model];
          const available = rateLimitTracker.isAvailable(model);
          return `  - ${model}: ${available ? '✅ Available' : '⚠️ Rate limited'} (Tier ${caps?.tier || '?'})`;
        }).join('\n');

        const config = {
          version: '0.3.7',  // Refactored version
          auth: {
            method: AUTH_CONFIG.method,
            geminiApiKey: maskValue(process.env.GEMINI_API_KEY),
            googleApiKey: maskValue(process.env.GOOGLE_API_KEY),
            vertexApiKey: maskValue(process.env.VERTEX_API_KEY),
          },
          models: {
            default: getDefaultModel(),
            available: getSupportedModels(),
          },
          features: {
            agentMode: process.env.GEMINI_AGENT_MODE === 'true',
            extensionsDisabled: process.env.GEMINI_AGENT_MODE !== 'true',
            smartModelSelection: true,
          },
          cache: {
            enabled: true,
            defaultTTL: '30 minutes',
          },
          paths: {
            workDir: process.cwd(),
            serverFile: import.meta.url,
          },
        };

        let output = `# Current Configuration

## Version
- Server: ${config.version}

## Authentication
- Method: ${config.auth.method}
- Gemini API Key: ${config.auth.geminiApiKey}
- Google API Key: ${config.auth.googleApiKey}
- Vertex API Key: ${config.auth.vertexApiKey}

## Model Selection (Smart Routing)
- Default for complex tasks: gemini-3-pro (available to all auth methods)
- Default for standard tasks: gemini-2.5-pro
- Default for simple tasks: gemini-2.5-flash
- Rate limit fallback: Enabled
- Auth method: ${AUTH_CONFIG.method} ${AUTH_CONFIG.method === 'vertex' ? '(higher rate limits)' : ''}
- Model status:
${modelStatus}

## Task Classification
- Complex tasks (Tier 1): gemini_agent_task
- Standard tasks (Tier 2): gemini_config_show, gemini_auth_status
- Simple tasks (Tier 3): gemini_health_check, hybrid_metrics, gemini_agent_list

## Features
- Smart Model Selection: ${config.features.smartModelSelection ? 'Enabled' : 'Disabled'}
- Agent Mode: ${config.features.agentMode ? 'Enabled' : 'Disabled (--extensions none)'}
- Response Cache: ${config.cache.enabled ? 'Enabled' : 'Disabled'}
- Cache TTL: ${config.cache.defaultTTL}
- .env file support: Enabled (.env, .env.local, ~/.env.gemini)

## Paths
- Working Directory: ${config.paths.workDir}`;

        if (show_env) {
          output += `

## Environment Variables (Relevant)
- NODE_ENV: ${process.env.NODE_ENV || '(not set)'}
- GEMINI_AGENT_MODE: ${process.env.GEMINI_AGENT_MODE || '(not set)'}
- VERTEX_PROJECT: ${process.env.VERTEX_PROJECT || '(not set)'}
- VERTEX_LOCATION: ${process.env.VERTEX_LOCATION || 'us-central1 (default)'}`;
        }

        output += `

## Quick Fixes
- To enable agent mode: Set GEMINI_AGENT_MODE=true
- To use API key auth: Set GEMINI_API_KEY=your-key`;

        return {
          content: [{ type: 'text', text: output }],
        };
      }

      case 'gemini_health_check': {
        const healthResult = {
          status: 'unknown',
          timestamp: new Date().toISOString(),
          geminiCli: { status: 'unknown', latencyMs: null, error: null },
          authentication: { method: AUTH_CONFIG.method, status: 'unknown' },
          models: { default: getDefaultModel(), available: [], rateLimited: [] },
          cache: { status: 'unknown' },
        };

        // Test 1: Check Gemini CLI connectivity
        const startTime = Date.now();
        try {
          const result = await runGeminiCli('Reply with exactly: OK', {
            toolName: 'gemini_health_check',
            timeout: 30000,
            preferFast: true,
          });
          healthResult.geminiCli.latencyMs = Date.now() - startTime;
          const response = typeof result === 'string' ? result : result?.response || '';
          if (response.length > 0) {
            healthResult.geminiCli.status = 'healthy';
            healthResult.authentication.status = 'valid';
          } else {
            healthResult.geminiCli.status = 'degraded';
            healthResult.geminiCli.error = 'Empty response';
          }
        } catch (err) {
          healthResult.geminiCli.latencyMs = Date.now() - startTime;
          healthResult.geminiCli.status = 'unhealthy';
          healthResult.geminiCli.error = err.message;
          if (err.message.includes('auth') || err.message.includes('401') || err.message.includes('403')) {
            healthResult.authentication.status = 'invalid';
          } else if (err.message.includes('rate') || err.message.includes('429')) {
            healthResult.authentication.status = 'rate_limited';
          } else {
            healthResult.authentication.status = 'unknown';
          }
        }

        // Test 2: Check model availability
        for (const model of getSupportedModels()) {
          if (rateLimitTracker.isAvailable(model)) {
            healthResult.models.available.push(model);
          } else {
            healthResult.models.rateLimited.push(model);
          }
        }

        // Test 3: Check cache
        try {
          const cache = getResponseCache();
          const stats = cache.getStats();
          healthResult.cache = { status: 'healthy', entries: stats.size, hitRate: stats.hitRate };
        } catch {
          healthResult.cache.status = 'unavailable';
        }

        // Determine overall status
        if (healthResult.geminiCli.status === 'healthy' && healthResult.authentication.status === 'valid' && healthResult.models.available.length > 0) {
          healthResult.status = 'healthy';
        } else if (healthResult.geminiCli.status === 'unhealthy') {
          healthResult.status = 'unhealthy';
        } else {
          healthResult.status = 'degraded';
        }

        const emoji = { healthy: '✅', degraded: '⚠️', unhealthy: '❌', unknown: '❓' };
        return {
          content: [{
            type: 'text', text: `# Gemini Health Check

## Overall Status: ${emoji[healthResult.status]} ${healthResult.status.toUpperCase()}

## Gemini CLI
- Status: ${emoji[healthResult.geminiCli.status]} ${healthResult.geminiCli.status}
- Latency: ${healthResult.geminiCli.latencyMs !== null ? `${healthResult.geminiCli.latencyMs}ms` : 'N/A'}
${healthResult.geminiCli.error ? `- Error: ${healthResult.geminiCli.error}` : ''}

## Authentication
- Method: ${healthResult.authentication.method}
- Status: ${healthResult.authentication.status}

## Model Availability
- Default: ${healthResult.models.default}
- Available (${healthResult.models.available.length}): ${healthResult.models.available.join(', ') || 'None'}
- Rate limited (${healthResult.models.rateLimited.length}): ${healthResult.models.rateLimited.join(', ') || 'None'}

## Cache
- Status: ${healthResult.cache.status}
${healthResult.cache.entries !== undefined ? `- Entries: ${healthResult.cache.entries}` : ''}
${healthResult.cache.hitRate !== undefined ? `- Hit rate: ${healthResult.cache.hitRate}` : ''}

## Timestamp
${healthResult.timestamp}`
          }],
        };
      }

      // === Agent Tools ===

      case 'gemini_agent_task':
      case 'gemini_agent_list':
      case 'gemini_agent_clear':
      case 'gemini_agent_approve': {
        // Import handler dynamically to avoid circular dependencies
        const { handlers: agentHandlers } = await import('./tool-handlers/agent/index.js');
        const handler = agentHandlers[name];
        if (!handler) {
          return {
            content: [{ type: 'text', text: `Error: Handler not found for ${name}` }],
            isError: true,
          };
        }

        // Build context for handler
        const handlerContext = {
          runGeminiCli,
          readFilesFromPatterns,
          sanitizePath,
          sanitizeGlobPatterns,
          safeSpawn,
          buildEnv: () => {
            const env = { ...process.env };
            if (AUTH_CONFIG.method === 'api-key' && AUTH_CONFIG.apiKey) {
              env.GEMINI_API_KEY = AUTH_CONFIG.apiKey;
            }
            return env;
          },
          spawn: (await import('child_process')).spawn,
        };

        return await handler(args, handlerContext);
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ============================================================================ 
// Error Handling & Shutdown
// ============================================================================ 

/**
 * Graceful shutdown handler
 * Ensures cache is persisted and resources are cleaned up
 */
async function gracefulShutdown(signal) {
  console.error(`[gemini-worker] Received ${signal}, shutting down gracefully...`);

  try {
    // Persist response cache
    const cache = getResponseCache();
    if (cache && typeof cache.persistSync === 'function') {
      cache.persistSync();
      console.error('[gemini-worker] Response cache persisted');
    }

    console.error('[gemini-worker] Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[gemini-worker] Error during shutdown:', error.message);
    process.exit(1);
  }
}

/**
 * Global error handlers to prevent server crashes
 */
process.on('uncaughtException', (error) => {
  console.error('[gemini-worker] Uncaught exception:', error.message);
  console.error('[gemini-worker] Stack:', error.stack);
  // Log but don't exit immediately - allow graceful shutdown
});

process.on('unhandledRejection', (reason, _promise) => {
  console.error('[gemini-worker] Unhandled rejection:', reason);
  // Log but don't exit - try to keep server running
});

/**
 * Shutdown signal handlers
 */
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('exit', (code) => {
  console.error(`[gemini-worker] Process exiting with code ${code}`);
});

// ============================================================================ 
// Start Server
// ============================================================================ 

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[gemini-worker] MCP server running with ${TOOLS.length} tools`);
    console.error(`[gemini-worker] Auth method: ${AUTH_CONFIG.method}`);
    console.error(`[gemini-worker] Default model: ${getDefaultModel()}`);
    console.error(`[gemini-worker] Available models: ${getSupportedModels().join(', ')}`);
  } catch (error) {
    console.error('[gemini-worker] Failed to start server:', error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[gemini-worker] Fatal error:', error.message);
  process.exit(1);
});