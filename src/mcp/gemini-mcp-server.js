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
import { analyzeStderr, createTypedError, readFilesFromPatterns } from './tool-handlers/base.js';
import { getRateLimitTracker } from '../utils/retry.js';
import { executeToolHandler } from './tool-handlers/index.js';

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
 * Uses centralized RateLimitTracker from utils/retry.js
 * Configured with RATE_LIMITS from src/config/timeouts.js
 */
const rateLimitTracker = getRateLimitTracker({
  cooldownMs: RATE_LIMITS.cooldownMs,
  maxFailures: RATE_LIMITS.maxFailures,
});

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
        rateLimitTracker.recordRateLimit(selectedModel);
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
            rateLimitTracker.recordRateLimit(selectedModel);
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

  // Build shared context for all handlers
  const handlerContext = {
    runGeminiCli,
    safeSpawn,
    spawn,
    buildEnv,
    AUTH_CONFIG,
    getActiveAuthMethod,
    getDefaultModel,
    getSupportedModels,
    rateLimitTracker,
    tokenTracker,
    MODEL_CAPABILITIES,
    getResponseCache,
    readFilesFromPatterns,
    sanitizePath,
    sanitizeGlobPatterns,
    isAgentModeEnabled,
  };

  return await executeToolHandler(name, args, handlerContext);
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