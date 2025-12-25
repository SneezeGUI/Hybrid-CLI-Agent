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

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { glob } from 'glob';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getConversationManager, MessageRole } from '../services/conversation-manager.js';
import { processPrompt, hasFileReferences } from '../utils/prompt-processor.js';
import { getResponseCache } from '../services/response-cache.js';
import { applyEnvFile } from '../utils/env.js';
import { AICollaborationEngine } from '../services/ai-collaboration.js';

// Get project root from script location (works for system-wide MCP use)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..'); // src/mcp -> project root

// Load .env files before AUTH_CONFIG is initialized
// Checks: GEMINI_WORKER_ROOT env var > project root > cwd > ~/.env.gemini
applyEnvFile(process.cwd(), { silent: false, projectRoot: PROJECT_ROOT });
import {
  sanitizePath,
  validateDirectory,
  sanitizeGlobPatterns,
  sanitizeGitPatterns,
  TIMEOUTS,
  isWriteAllowed,
  safeSpawn,
  isAgentModeEnabled,
} from '../utils/security.js';
import {
  GEMINI_MODELS,
  GEMINI_PRICING,
  RATE_LIMITS,
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
  vertexLocation: process.env.VERTEX_LOCATION || 'us-central1',
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
        VERTEX_LOCATION: process.env.VERTEX_LOCATION || 'us-central1',
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
const AUTH_FAILURE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

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
      'draft_code_implementation',
      'gemini_verify_solution',
      'gemini_eval_plan',
      'ai_collaboration',
      'gemini_code_review',
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
      'research_heavy_context',
      'gemini_prompt',
      'gemini_git_diff_review',
      'cross_model_comparison',
      'gemini_content_comparison',
      'gemini_extract_structured',
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
      'ask_gemini',
      'summarize_directory',
      'gemini_summarize_files',
      'review_code_changes',
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
 * Check if git is available in the current environment
 * Uses safeSpawn to avoid shell injection
 */
async function isGitAvailable() {
  return new Promise((resolve) => {
    // Use safeSpawn instead of shell: true
    const proc = safeSpawn(spawn, 'git', ['--version'], {});
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

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
          // Check for rate limit errors
          const isRateLimit = stderr.includes('429') ||
                              stderr.includes('rate limit') ||
                              stderr.includes('quota exceeded') ||
                              stderr.includes('RESOURCE_EXHAUSTED');

          // Check for model not found errors (don't treat as auth error!)
          const isModelError = stderr.toLowerCase().includes('model') ||
                               stderr.includes('not found') ||
                               stderr.includes('invalid') ||
                               stderr.includes('unsupported');

          // Check for authentication errors (but not if it's a model error)
          const isAuthError = !isModelError && (
                              stderr.toLowerCase().includes('auth') ||
                              stderr.toLowerCase().includes('credential') ||
                              stderr.toLowerCase().includes('unauthenticated') ||
                              stderr.toLowerCase().includes('permission denied') ||
                              stderr.includes('401') ||
                              stderr.includes('403'));

          if (isRateLimit) {
            rateLimitTracker.recordFailure(selectedModel);
            reject({ isRateLimit: true, model: selectedModel, error: stderr });
          } else if (isModelError) {
            // Model error - treat as rate limit to trigger model fallback
            console.error(`[gemini-worker] Model error for ${selectedModel}, will try fallback`);
            rateLimitTracker.recordFailure(selectedModel);
            reject({ isRateLimit: true, model: selectedModel, error: stderr });
          } else if (isAuthError) {
            // Auth failure - record and allow fallback
            reject({ isAuthError: true, authMethod: currentAuthMethod, error: stderr });
          } else {
            reject(new Error(`Gemini CLI error: ${stderr || 'Unknown error'}`));
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
 * Read files from glob patterns with memory protection
 * @param {string[]} patterns - Glob patterns
 * @param {string} baseDir - Base directory
 * @param {Object} options - Options
 * @param {number} options.maxFileSize - Max bytes per file (default 500KB)
 * @param {number} options.maxTotalSize - Max total bytes (default 5MB)
 * @param {number} options.maxFiles - Max number of files (default 100)
 */
async function readFilesFromPatterns(patterns, baseDir = process.cwd(), options = {}) {
  const {
    maxFileSize = 500 * 1024,    // 500KB per file
    maxTotalSize = 5 * 1024 * 1024, // 5MB total
    maxFiles = 100,
  } = options;

  const results = [];
  let totalSize = 0;

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

          const content = await readFile(filepath, 'utf-8');
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

          results.push({ path: relativePath, content });
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
// Tool Definitions (27 Tools - inspired by gemini-cli-mcp-server's 33 tools)
// ============================================================================

const ALL_TOOLS = [
  // === Core Gemini Tools (6) ===
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
    name: 'gemini_prompt',
    description: `Send a prompt to Gemini with @filename syntax support.
USE THIS for general purpose interactions with Gemini.
Supports @filename to reference files directly (e.g., "Analyze @config.py")`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Prompt with optional @filename references (100K char limit)',
        },
        model: {
          type: 'string',
          enum: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview'],
          description: 'Model to use',
          default: 'gemini-2.5-pro',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'research_heavy_context',
    description: `**COST SAVER** - Reads and analyzes files using FREE Gemini instead of expensive Claude tokens.

ALWAYS USE THIS INSTEAD OF READING FILES DIRECTLY WHEN:
- Reading 5+ files
- Analyzing logs, large codebases, or documentation
- Searching for patterns across many files
- Understanding unfamiliar code architecture

HOW IT WORKS: Gemini reads files locally (FREE), analyzes them, returns a summary to Claude.
RESULT: You get the insights without spending Claude tokens on raw file contents.

Examples: "Find authentication bugs in src/**/*.py", "Summarize error patterns in logs/*.log"`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look for or analyze in the files',
        },
        file_patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files to read (e.g., ["src/**/*.py", "logs/*.log"])',
        },
        use_flash: {
          type: 'boolean',
          description: 'Use faster/cheaper Gemini Flash model (default: false, uses Pro)',
          default: false,
        },
        use_gemini_3: {
          type: 'boolean',
          description: 'Use Gemini 3 Pro (requires Vertex AI auth). Best for complex analysis.',
          default: false,
        },
        base_dir: {
          type: 'string',
          description: 'Base directory for file patterns (default: current working directory)',
        },
      },
      required: ['query', 'file_patterns'],
    },
  },
  {
    name: 'draft_code_implementation',
    description: `**DEPRECATED** - Use gemini_agent_task instead for better capabilities.

This tool will be removed in a future version. gemini_agent_task provides:
- Native file system access (no protected directory restrictions)
- Shell command execution (run tests, build, etc.)
- Session persistence for multi-step tasks
- Automatic iteration until task complete

LEGACY BEHAVIOR (still works):
Gemini writes code drafts (FREE), Claude reviews and approves.
WORKFLOW: 1) Call this tool 2) Review with 'cat' or 'git diff' 3) Approve or request changes`,
    inputSchema: {
      type: 'object',
      properties: {
        task_description: {
          type: 'string',
          description: 'Detailed description of what code to write',
        },
        target_file: {
          type: 'string',
          description: 'Path where the code should be written',
        },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for context files Gemini should reference',
          default: [],
        },
        language: {
          type: 'string',
          description: 'Programming language (auto-detected from target_file if not specified)',
        },
        use_gemini_3: {
          type: 'boolean',
          description: 'Use Gemini 3 Pro for higher quality code (requires Vertex AI)',
          default: false,
        },
      },
      required: ['task_description', 'target_file'],
    },
  },
  {
    name: 'ask_gemini',
    description: `**FREE** - Quick questions to Gemini without using Claude tokens.

USE THIS FOR: Brainstorming, second opinions, simple lookups, explanations.
NOT FOR: Tasks requiring Claude's judgment, final decisions, or complex reasoning.`,
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Question or prompt for Gemini',
        },
        model: {
          type: 'string',
          enum: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3-pro-preview'],
          description: 'Model to use (default: gemini-2.5-pro, gemini-3-pro requires Vertex AI)',
          default: 'gemini-2.5-pro',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'summarize_directory',
    description: `**FREE** - Gemini analyzes directory structure and key files.

ALWAYS USE THIS BEFORE exploring unfamiliar codebases.
Returns: Project purpose, entry points, architecture overview, tech stack.
SAVES: Claude tokens that would be spent reading package.json, README, etc.`,
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory to summarize',
        },
        depth: {
          type: 'number',
          description: 'How deep to analyze (1=overview, 3=detailed)',
          default: 2,
        },
        focus: {
          type: 'string',
          description: 'What aspects to focus on (e.g., "architecture", "dependencies", "entry points")',
        },
      },
      required: ['directory'],
    },
  },
  
  // === Analysis Tools (4) ===
  {
    name: 'gemini_eval_plan',
    description: `**FREE SECOND OPINION** - Gemini evaluates implementation plans before you start coding.

USE BEFORE starting any significant implementation.
Returns: Feasibility score, risks, missing elements, suggested improvements.
WHY: Catch issues early (FREE) instead of fixing them later (expensive).`,
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'Implementation plan from Claude Code',
        },
        context: {
          type: 'string',
          description: 'Project context (e.g., "Node.js REST API with MongoDB")',
        },
        requirements: {
          type: 'string',
          description: 'Specific requirements (e.g., "Must support 10,000 concurrent users")',
        },
        model: {
          type: 'string',
          default: 'gemini-2.5-pro',
        },
      },
      required: ['plan'],
    },
  },
  {
    name: 'gemini_verify_solution',
    description: `Comprehensive verification of complete solutions (800K char limit).
USE THIS before deploying or finalizing a solution.
Gemini verifies the solution meets all requirements.`,
    inputSchema: {
      type: 'object',
      properties: {
        solution: {
          type: 'string',
          description: 'Complete implementation including code, tests, docs',
        },
        requirements: {
          type: 'string',
          description: 'Original requirements specification',
        },
        test_criteria: {
          type: 'string',
          description: 'Performance and security criteria',
        },
        context: {
          type: 'string',
          description: 'Production deployment environment context',
        },
      },
      required: ['solution', 'requirements'],
    },
  },
  {
    name: 'gemini_code_review',
    description: `**FREE CODE REVIEW** - Gemini performs detailed code analysis with severity levels.

USE THIS FOR: Security audits, performance analysis, code quality checks.
SUPPORTS: @filename syntax to reference files directly.
Returns: Structured issues (critical/error/warning/info), recommendations, metrics.`,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Code to review (or @filename)',
        },
        language: {
          type: 'string',
          description: 'Programming language (auto-detected if not specified)',
        },
        focus_areas: {
          type: 'string',
          description: 'Comma-separated focus areas: security,performance,quality,best_practices',
          default: 'security,performance,quality,best_practices',
        },
        severity_threshold: {
          type: 'string',
          enum: ['info', 'warning', 'error', 'critical'],
          description: 'Minimum severity to report',
          default: 'info',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'gemini_git_diff_review',
    description: `Analyze git diffs with contextual feedback (150K char limit).
USE THIS to review pull requests or changes before committing.`,
    inputSchema: {
      type: 'object',
      properties: {
        diff: {
          type: 'string',
          description: 'Git diff content or "staged" to review staged changes',
        },
        review_type: {
          type: 'string',
          enum: ['comprehensive', 'security_only', 'performance_only', 'quick'],
          description: 'Type of review',
          default: 'comprehensive',
        },
        base_branch: {
          type: 'string',
          description: 'Base branch for comparison',
          default: 'main',
        },
        commit_message: {
          type: 'string',
          description: 'Commit message for context',
        },
      },
      required: ['diff'],
    },
  },
  
  // === AI Collaboration Tools (2) ===
  {
    name: 'ai_collaboration',
    description: `Multi-AI collaboration with debate, validation, or sequential modes.
USE THIS for complex decisions that benefit from multiple AI perspectives.

MODES:
- debate: Multi-round discussions between AI models
- validation: Cross-model validation with consensus
- sequential: Pipeline stages with handoffs

EXAMPLE (debate):
ai_collaboration(mode="debate", content="Should we use microservices?", models="gemini-2.5-flash,openai/gpt-4.1-mini", rounds=3)`,
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['debate', 'validation', 'sequential'],
          description: 'Collaboration mode',
          default: 'debate',
        },
        content: {
          type: 'string',
          description: 'Content to analyze/discuss',
        },
        models: {
          type: 'string',
          description: 'Comma-separated list of models (e.g., "gemini-2.5-flash,openai/gpt-4.1-mini,anthropic/claude-3-haiku")',
        },
        context: {
          type: 'string',
          description: 'Additional context',
        },
        // Debate options
        rounds: {
          type: 'number',
          description: 'Number of debate rounds (1-10)',
          default: 3,
        },
        debate_style: {
          type: 'string',
          enum: ['constructive', 'adversarial', 'collaborative', 'socratic', 'devil_advocate'],
          description: 'Debate style',
          default: 'constructive',
        },
        // Validation options
        validation_criteria: {
          type: 'string',
          description: 'Comma-separated criteria for validation mode',
        },
        confidence_threshold: {
          type: 'number',
          description: 'Confidence threshold for validation (0.0-1.0)',
          default: 0.7,
        },
        consensus_method: {
          type: 'string',
          enum: ['simple_majority', 'weighted_majority', 'unanimous', 'supermajority'],
          default: 'simple_majority',
        },
        // Sequential options
        pipeline_stages: {
          type: 'string',
          description: 'Comma-separated pipeline stages for sequential mode',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'cross_model_comparison',
    description: `Compare responses from multiple AI models.
USE THIS to get diverse perspectives on a question or problem.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Question or prompt to send to all models',
        },
        models: {
          type: 'string',
          description: 'Comma-separated list of models (e.g., "gemini-2.5-flash,openai/gpt-4.1-mini")',
        },
      },
      required: ['prompt'],
    },
  },
  
  // === OpenRouter Tools (3) ===
  {
    name: 'openrouter_chat',
    description: `Chat with any of 400+ AI models via OpenRouter.
USE THIS to access OpenAI, Anthropic, Meta, and other models.
Requires OPENROUTER_API_KEY environment variable.

Popular models:
- openai/gpt-4.1-nano (cheapest)
- openai/gpt-4o-mini
- anthropic/claude-3-haiku
- meta-llama/llama-3.1-70b-instruct`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Message to send',
        },
        model: {
          type: 'string',
          description: 'OpenRouter model ID',
          default: 'openai/gpt-4.1-nano',
        },
        temperature: {
          type: 'number',
          description: 'Temperature (0.0-2.0)',
          default: 0.7,
        },
        max_tokens: {
          type: 'number',
          description: 'Max tokens to generate',
          default: 4096,
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'openrouter_models',
    description: `List available OpenRouter models with pricing info.`,
    inputSchema: {
      type: 'object',
      properties: {
        provider_filter: {
          type: 'string',
          description: 'Filter by provider (e.g., "openai", "anthropic", "meta")',
        },
      },
      required: [],
    },
  },
  {
    name: 'openrouter_usage_stats',
    description: `Get OpenRouter usage statistics and costs for this session.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // === Metrics & Status (2) ===
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
    name: 'review_code_changes',
    description: `Asks Gemini to review code changes and provide feedback.
USE THIS before committing - get a second opinion on your changes.
Gemini analyzes the diff and suggests improvements.`,
    inputSchema: {
      type: 'object',
      properties: {
        file_patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to review',
        },
        focus_areas: {
          type: 'string',
          description: 'Specific areas to focus on (e.g., "security", "performance", "readability")',
        },
        git_diff: {
          type: 'boolean',
          description: 'Review only changed lines (requires git)',
          default: false,
        },
      },
      required: ['file_patterns'],
    },
  },

  // === Conversation Tools (5) ===
  {
    name: 'gemini_start_conversation',
    description: `Start a new stateful conversation with Gemini.
USE THIS when you need multi-turn interactions that maintain context.
Returns a conversation ID to use with gemini_continue_conversation.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional title for the conversation',
        },
        system_prompt: {
          type: 'string',
          description: 'System prompt to set context/persona for the conversation',
        },
        model: {
          type: 'string',
          enum: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview'],
          description: 'Model to use for this conversation',
          default: 'gemini-2.5-pro',
        },
        initial_message: {
          type: 'string',
          description: 'Optional first message to send immediately',
        },
      },
      required: [],
    },
  },
  {
    name: 'gemini_continue_conversation',
    description: `Continue an existing conversation with Gemini.
USE THIS to send follow-up messages in a multi-turn conversation.
Automatically includes conversation history for context.`,
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'ID of the conversation to continue',
        },
        message: {
          type: 'string',
          description: 'Message to send',
        },
      },
      required: ['conversation_id', 'message'],
    },
  },
  {
    name: 'gemini_list_conversations',
    description: `List all active conversations.
USE THIS to see what conversations are available to continue.`,
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['active', 'paused', 'completed', 'expired'],
          description: 'Filter by conversation state',
        },
        limit: {
          type: 'number',
          description: 'Max conversations to return',
          default: 20,
        },
      },
      required: [],
    },
  },
  {
    name: 'gemini_clear_conversation',
    description: `Clear/delete a conversation and its history.
USE THIS when you're done with a conversation and want to free resources.`,
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'ID of the conversation to clear',
        },
      },
      required: ['conversation_id'],
    },
  },
  {
    name: 'gemini_conversation_stats',
    description: `Get detailed statistics for a conversation or global stats.
USE THIS to check token usage, message counts, and conversation health.`,
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'ID of conversation (omit for global stats)',
        },
      },
      required: [],
    },
  },

  // === Cache Management Tool (1) ===
  {
    name: 'gemini_cache_manage',
    description: `Manage the response cache for Gemini queries.
USE THIS to view cache statistics, clear the cache, or check if a query is cached.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['stats', 'clear', 'check'],
          description: 'Action to perform',
          default: 'stats',
        },
        prompt: {
          type: 'string',
          description: 'Prompt to check (only for "check" action)',
        },
        model: {
          type: 'string',
          description: 'Model to check (only for "check" action)',
        },
      },
      required: [],
    },
  },

  // === Content Analysis Tools (3) ===
  {
    name: 'gemini_content_comparison',
    description: `Compare content from multiple sources and identify differences.
USE THIS to compare documents, code versions, or any text content.
Returns structured analysis of similarities, differences, and recommendations.`,
    inputSchema: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of content strings or @file references to compare',
        },
        comparison_type: {
          type: 'string',
          enum: ['semantic', 'structural', 'line_by_line', 'key_points'],
          description: 'Type of comparison to perform',
          default: 'semantic',
        },
        focus: {
          type: 'string',
          description: 'Specific aspects to focus on (e.g., "API changes", "security implications")',
        },
      },
      required: ['sources'],
    },
  },
  {
    name: 'gemini_extract_structured',
    description: `Extract structured data from unstructured text using a JSON schema.
USE THIS to parse logs, documents, or any text into structured JSON.
Provide a schema describing the expected output format.`,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Text content to extract data from (or @file reference)',
        },
        schema: {
          type: 'object',
          description: 'JSON schema describing expected output structure',
        },
        schema_description: {
          type: 'string',
          description: 'Natural language description of what to extract (alternative to schema)',
        },
        examples: {
          type: 'array',
          items: { type: 'object' },
          description: 'Example outputs to guide extraction',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'gemini_summarize_files',
    description: `Generate optimized summaries of multiple files.
USE THIS for quick understanding of codebases or document collections.
More efficient than research_heavy_context for pure summarization tasks.`,
    inputSchema: {
      type: 'object',
      properties: {
        file_patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files to summarize',
        },
        summary_style: {
          type: 'string',
          enum: ['brief', 'detailed', 'bullet_points', 'executive'],
          description: 'Style of summary to generate',
          default: 'bullet_points',
        },
        max_words_per_file: {
          type: 'number',
          description: 'Maximum words per file summary',
          default: 100,
        },
        group_by: {
          type: 'string',
          enum: ['none', 'directory', 'extension', 'purpose'],
          description: 'How to group summaries',
          default: 'directory',
        },
        base_dir: {
          type: 'string',
          description: 'Base directory for file patterns',
        },
      },
      required: ['file_patterns'],
    },
  },

  // ============================================================================
  // Agent Tools - Autonomous Task Execution
  // ============================================================================
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
4. Review results with \`git diff\``,
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
          default: 20,
          description: 'Maximum tool calls before stopping (safety limit)',
        },
        timeout_minutes: {
          type: 'integer',
          default: 10,
          description: 'Maximum execution time in minutes',
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
          enum: ['pending', 'running', 'completed', 'failed'],
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
];

// ============================================================================
// Conditional Tool Registration
// ============================================================================

const AGENT_MODE_TOOL_NAMES = new Set([
  // Agent tools
  'gemini_agent_task', 'gemini_agent_list', 'gemini_agent_clear',
  // Auth & Utility
  'gemini_auth_status', 'gemini_config_show', 'hybrid_metrics', 'gemini_cache_manage',
  // OpenRouter
  'openrouter_chat', 'openrouter_models', 'openrouter_usage_stats',
  // Multi-model
  'ai_collaboration', 'cross_model_comparison',
  // Review (for pre-commit)
  'review_code_changes'
]);

// Filter tools based on mode
const TOOLS = isAgentModeEnabled()
  ? ALL_TOOLS.filter(t => AGENT_MODE_TOOL_NAMES.has(t.name))
  : ALL_TOOLS;

// Log active mode
if (isAgentModeEnabled()) {
  console.error('[gemini-worker] Agent Mode ENABLED - restricting tools to agent capabilities');
} else {
  console.error('[gemini-worker] Legacy Mode - all tools enabled (set GEMINI_AGENT_MODE=true for Agent Mode)');
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

      case 'research_heavy_context': {
        const { query, file_patterns, use_flash = false, use_gemini_3 = false, base_dir = process.cwd() } = args;

        // Sanitize glob patterns to prevent path traversal
        const safePatterns = sanitizeGlobPatterns(file_patterns, base_dir);
        if (safePatterns.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: No valid file patterns provided. Patterns cannot contain ".." or be absolute paths.' }],
            isError: true,
          };
        }

        // Read files locally (FREE - no tokens)
        const files = await readFilesFromPatterns(safePatterns, base_dir);

        if (files.length === 0) {
          return {
            content: [{ type: 'text', text: 'No files found matching the patterns.' }],
          };
        }

        // Combine file contents
        const combinedContent = files
          .map(f => `\n--- FILE: ${f.path} ---\n${f.content}`)
          .join('\n');

        // Construct the research prompt
        const prompt = `You are a Senior Research Assistant helping a Lead Engineer.

QUERY: ${query}

Analyze the following ${files.length} files.

OUTPUT RULES:
1. Be concise - the Lead Engineer is busy
2. Provide a high-level summary first, then specific findings
3. If you find bugs or issues, list them with file:line references
4. If asked about architecture, provide a clear mental model
5. Do NOT regurgitate code unless absolutely necessary

CONTEXT (${files.length} files):
${combinedContent}`;

        // Determine requested model (user hints override smart selection)
        let requestedModel = null;
        if (use_flash) requestedModel = 'gemini-2.5-flash';
        if (use_gemini_3) requestedModel = 'gemini-3-pro-preview';

        const result = await runGeminiCli(prompt, {
          model: requestedModel,
          toolName: 'research_heavy_context',
          preferFast: use_flash,
        });

        const costNote = AUTH_CONFIG.method === 'oauth'
          ? '(FREE with Pro subscription)'
          : '';

        return {
          content: [{
            type: 'text',
            text: `[Gemini analyzed ${files.length} files ${costNote}]\n\n${safeGetResponse(result)}`
          }],
        };
      }

      case 'draft_code_implementation': {
        // DEPRECATION WARNING
        console.error('[DEPRECATED] draft_code_implementation is deprecated. Use gemini_agent_task instead for better capabilities.');

        const { task_description, target_file, context_files = [], language, use_gemini_3 = false } = args;

        // Validate target file path (prevent writing outside cwd)
        const safeTargetFile = sanitizePath(target_file);
        if (!safeTargetFile) {
          return {
            content: [{ type: 'text', text: 'Error: Invalid target file path. Path cannot contain ".." or be absolute.' }],
            isError: true,
          };
        }

        // SECURITY: Check if write is allowed (protects critical files)
        const writeCheck = isWriteAllowed(target_file);
        if (!writeCheck.allowed) {
          return {
            content: [{
              type: 'text',
              text: `Error: Cannot write to this location.\nReason: ${writeCheck.reason}\n\nFor security, certain files and directories are protected from automated writes:\n- Configuration files (.env, package.json, etc.)\n- System directories (node_modules/, .git/, etc.)\n- Source directories of this tool (src/, bin/)\n\nPlease specify a different target path.`
            }],
            isError: true,
          };
        }

        // Read context files if provided (with sanitized patterns)
        let contextSection = '';
        if (context_files.length > 0) {
          const safeContextPatterns = sanitizeGlobPatterns(context_files);
          const files = await readFilesFromPatterns(safeContextPatterns);
          if (files.length > 0) {
            contextSection = `\nREFERENCE FILES:\n${files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n')}`;
          }
        }

        // Detect language from file extension
        const ext = target_file.split('.').pop();
        const detectedLang = language || {
          js: 'JavaScript', ts: 'TypeScript', py: 'Python',
          rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby',
        }[ext] || ext;

        const prompt = `You are a code generator. Output ONLY raw ${detectedLang} code.

TASK: ${task_description}
${contextSection}

CRITICAL RULES:
- Output ONLY the code itself, nothing else
- Do NOT explain what you will do
- Do NOT mention files, tools, or actions
- Do NOT use markdown code blocks
- Start your response with the first line of code
- Include JSDoc/docstrings and error handling
- Follow ${detectedLang} best practices`;

        // Smart model selection - code generation is complex, prefers best available
        let requestedModel = null;
        if (use_gemini_3) requestedModel = 'gemini-3-pro-preview';

        const result = await runGeminiCli(prompt, {
          model: requestedModel,
          toolName: 'draft_code_implementation',  // Complex task - will use best model
        });

        // Clean up Gemini response to extract only the code
        let cleanCode = safeGetResponse(result)
          // Remove markdown code blocks
          .replace(/^```[\w]*\n?/gm, '')
          .replace(/```$/gm, '')
          // Remove cached response marker
          .replace(/_\[cached response]_$/g, '')
          .trim();

        // Remove preamble text before actual code
        // Look for common code start patterns
        const codeStartPatterns = [
          /^\/\*\*/m,           // JSDoc comment
          /^\/\//m,             // Single-line comment
          /^["']use strict["']/m, // Use strict
          /^import\s/m,         // ES module import
          /^export\s/m,         // ES module export
          /^const\s/m,          // Const declaration
          /^let\s/m,            // Let declaration
          /^var\s/m,            // Var declaration
          /^function\s/m,       // Function declaration
          /^class\s/m,          // Class declaration
          /^#!\/.*\n/m,         // Shebang
        ];

        for (const pattern of codeStartPatterns) {
          const match = cleanCode.match(pattern);
          if (match) {
            const startIndex = cleanCode.indexOf(match[0]);
            if (startIndex > 0) {
              cleanCode = cleanCode.substring(startIndex);
            }
            break;
          }
        }

        // Write to disk (using validated path)
        await writeFile(safeTargetFile, cleanCode, 'utf-8');

        return {
          content: [{
            type: 'text',
            text: `✅ Gemini drafted ${target_file} (using ${result.model})\n\nReview it with:\n  cat ${target_file}\n  git diff ${target_file}\n\nThe code is ready for your review and refinement.`
          }],
        };
      }

      case 'review_code_changes': {
        const { file_patterns, focus_areas = 'general quality', git_diff = false } = args;

        let contentToReview = '';

        if (git_diff) {
          // Check for git availability
          if (!(await isGitAvailable())) {
            return {
              content: [{ type: 'text', text: 'Error: Git is not available or not installed. Cannot run git diff.' }],
              isError: true,
            };
          }

          // Sanitize git patterns to prevent command injection
          const safeGitPatterns = sanitizeGitPatterns(file_patterns);

          // Get git diff with timeout - SECURITY: use safeSpawn
          const diffResult = await new Promise((resolve, reject) => {
            const proc = safeSpawn(spawn, 'git', ['diff', '--staged', ...safeGitPatterns], {});
            let stdout = '';
            let killed = false;

            const timeoutId = setTimeout(() => {
              killed = true;
              proc.kill('SIGTERM');
              resolve('Git diff timed out');
            }, TIMEOUTS.QUICK);

            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.on('close', () => {
              clearTimeout(timeoutId);
              if (!killed) resolve(stdout);
            });
            proc.on('error', (err) => {
              clearTimeout(timeoutId);
              if (!killed) reject(err);
            });
          });
          contentToReview = diffResult || 'No staged changes found.';
        } else {
          // Sanitize glob patterns
          const safePatterns = sanitizeGlobPatterns(file_patterns);
          const files = await readFilesFromPatterns(safePatterns);
          contentToReview = files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n');
        }

        const prompt = `You are a Senior Code Reviewer.

FOCUS AREAS: ${focus_areas}

Review the following code/changes and provide:
1. Critical issues (bugs, security, performance)
2. Suggestions for improvement
3. What's done well (brief)

Be constructive and specific. Reference file:line when possible.

CODE TO REVIEW:
${contentToReview}`;

        const result = await runGeminiCli(prompt, {
          toolName: 'review_code_changes',  // Simple task - fast model OK
          preferFast: true,
        });

        return {
          content: [{ type: 'text', text: `[Code Review by Gemini]\n\n${safeGetResponse(result)}` }],
        };
      }

      case 'ask_gemini': {
        const { question, model: requestedModel = null } = args;

        // Process @filename syntax if present
        let processedQuestion = question;
        if (hasFileReferences(question)) {
          const processed = await processPrompt(question);
          processedQuestion = processed.processed;
        }

        const result = await runGeminiCli(processedQuestion, {
          model: requestedModel,
          toolName: 'ask_gemini',  // Simple task - uses fast model by default
        });
        return {
          content: [{ type: 'text', text: safeGetResponse(result) }],
        };
      }

      case 'summarize_directory': {
        const { directory, depth = 2, focus = 'general structure' } = args;
        // Note: This is a simple task - smart model selection will prefer fast models

        // Validate directory path to prevent traversal
        const safeDirectory = await validateDirectory(directory);
        if (!safeDirectory) {
          return {
            content: [{ type: 'text', text: 'Error: Invalid directory path. Path must exist and be within the current working directory.' }],
            isError: true,
          };
        }

        // Get directory tree using cross-platform Node.js approach
        const getFilesRecursive = async (dir, currentDepth = 0, maxDepth = depth) => {
          const files = [];
          try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = join(dir, entry.name);
              if (entry.isDirectory() && currentDepth < maxDepth) {
                files.push(...await getFilesRecursive(fullPath, currentDepth + 1, maxDepth));
              } else if (entry.isFile()) {
                files.push(fullPath);
              }
            }
          } catch (e) {
            // Ignore permission errors
          }
          return files;
        };

        const fileList = await getFilesRecursive(safeDirectory);
        const treeResult = fileList.join('\n');

        // Read key files (README, package.json, etc.) using sanitized directory
        const keyFiles = await readFilesFromPatterns([
          `README*`,
          `package.json`,
          `Cargo.toml`,
          `pyproject.toml`,
          `go.mod`,
        ], safeDirectory);

        const prompt = `You are a Codebase Analyst.

Analyze this directory structure and provide a clear mental model.

FOCUS: ${focus}

DIRECTORY TREE:
${treeResult}

KEY FILES:
${keyFiles.map(f => `--- ${f.path} ---\n${f.content}`).join('\n')}

Provide:
1. What this project does (1-2 sentences)
2. Key entry points
3. Directory structure explanation
4. Dependencies/tech stack
5. Where to start if making changes`;

        const result = await runGeminiCli(prompt, {
          toolName: 'summarize_directory',  // Simple task - fast model preferred
        });

        return {
          content: [{ type: 'text', text: `[Directory Analysis: ${directory}]\n\n${safeGetResponse(result)}` }],
        };
      }

      // === New Analysis Tools ===

      case 'gemini_prompt': {
        const { prompt, model: requestedModel = null } = args;

        // Process @filename syntax
        let processedPrompt = prompt;
        let fileInfo = '';

        if (hasFileReferences(prompt)) {
          const processed = await processPrompt(prompt);
          processedPrompt = processed.processed;

          if (processed.files.length > 0) {
            fileInfo = `\n_[Processed ${processed.files.length} file(s): ${processed.files.map(f => f.path).join(', ')}]_\n`;
          }
          if (processed.errors.length > 0) {
            fileInfo += `\n_[Warnings: ${processed.errors.join('; ')}]_\n`;
          }
        }

        const result = await runGeminiCli(processedPrompt, {
          model: requestedModel,
          toolName: 'gemini_prompt',  // Standard task - smart selection applies
        });
        return {
          content: [{ type: 'text', text: fileInfo + safeGetResponse(result) }],
        };
      }

      case 'gemini_eval_plan': {
        const { plan, context = '', requirements = '', model: requestedModel = null } = args;

        const prompt = `You are a Senior Solutions Architect evaluating an implementation plan.

CONTEXT: ${context}
REQUIREMENTS: ${requirements}

PLAN TO EVALUATE:
${plan}

Provide:
1. FEASIBILITY SCORE (1-10) with reasoning
2. RISKS & CONCERNS - potential issues or blockers
3. MISSING ELEMENTS - what the plan doesn't address
4. SUGGESTIONS - specific improvements
5. RECOMMENDED SEQUENCE - optimal order of implementation
6. ESTIMATED EFFORT - rough time estimates for each phase

Be constructive but thorough. Flag critical issues prominently.`;

        const result = await runGeminiCli(prompt, {
          model: requestedModel,
          toolName: 'gemini_eval_plan',  // Complex task - uses best model
        });
        return {
          content: [{ type: 'text', text: `[Plan Evaluation]\n\n${safeGetResponse(result)}` }],
        };
      }

      case 'gemini_verify_solution': {
        const { solution, requirements, test_criteria = '', context = '', model: requestedModel = null } = args;
        
        const prompt = `You are a Quality Assurance Architect verifying a complete solution.

CONTEXT: ${context}
REQUIREMENTS:
${requirements}

TEST CRITERIA: ${test_criteria}

SOLUTION TO VERIFY:
${solution}

Perform comprehensive verification:

1. REQUIREMENTS CHECK
   - For each requirement, state: ✅ MET / ❌ NOT MET / ⚠️ PARTIAL
   - Provide evidence from the solution

2. CODE QUALITY
   - Architecture assessment
   - Error handling coverage
   - Edge cases addressed

3. SECURITY REVIEW
   - Authentication/authorization
   - Input validation
   - Data protection

4. PERFORMANCE ASSESSMENT
   - Potential bottlenecks
   - Scalability concerns

5. TEST COVERAGE
   - What's tested
   - What's missing

6. DEPLOYMENT READINESS
   - Production checklist
   - Missing configurations

7. FINAL VERDICT
   - APPROVED FOR DEPLOYMENT / NEEDS REVISION
   - Critical blockers (if any)`;

        const result = await runGeminiCli(prompt, {
          model: requestedModel,
          toolName: 'gemini_verify_solution',  // Complex task - uses best model
        });
        return {
          content: [{ type: 'text', text: `[Solution Verification]\n\n${safeGetResponse(result)}` }],
        };
      }

      case 'gemini_code_review': {
        const { code, language = '', focus_areas = 'security,performance,quality,best_practices', severity_threshold = 'info' } = args;

        // Process @filename syntax if present
        let codeToReview = code;
        if (hasFileReferences(code)) {
          const processed = await processPrompt(code);
          codeToReview = processed.processed;
        }

        const prompt = `You are a Senior Code Reviewer performing a comprehensive analysis.

LANGUAGE: ${language || 'auto-detect'}
FOCUS AREAS: ${focus_areas}
MINIMUM SEVERITY: ${severity_threshold}

CODE TO REVIEW:
${codeToReview}

Provide structured output:

## SUMMARY
Brief overview of code quality and main concerns.

## ISSUES FOUND
For each issue:
- **[SEVERITY]** (critical/error/warning/info)
- **Location**: file:line or code snippet
- **Issue**: What's wrong
- **Impact**: Why it matters
- **Fix**: How to resolve

## POSITIVE ASPECTS
What the code does well.

## RECOMMENDATIONS
Top 3-5 priority improvements.

## METRICS
- Estimated complexity: Low/Medium/High
- Test coverage needed: Yes/No/Partial
- Documentation needed: Yes/No/Partial`;

        const result = await runGeminiCli(prompt, {
          toolName: 'gemini_code_review',  // Complex task - uses best model
        });
        return {
          content: [{ type: 'text', text: `[Code Review]\n\n${safeGetResponse(result)}` }],
        };
      }

      case 'gemini_git_diff_review': {
        const { diff, review_type = 'comprehensive', base_branch = 'main', commit_message = '' } = args;
        
        let diffContent = diff;
        
        // If "staged", get actual staged diff
        if (diff === 'staged' || diff === 'staged changes') {
          // Check for git availability
          if (!(await isGitAvailable())) {
            return {
              content: [{ type: 'text', text: 'Error: Git is not available or not installed. Cannot run git diff.' }],
              isError: true,
            };
          }

          // SECURITY: Use safeSpawn to prevent command injection
          diffContent = await new Promise((resolve) => {
            const proc = safeSpawn(spawn, 'git', ['diff', '--staged'], {});
            let stdout = '';
            let killed = false;

            const timeoutId = setTimeout(() => {
              killed = true;
              proc.kill('SIGTERM');
              resolve('Git diff timed out');
            }, TIMEOUTS.QUICK);

            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.on('close', () => {
              clearTimeout(timeoutId);
              if (!killed) resolve(stdout || 'No staged changes');
            });
            proc.on('error', () => {
              clearTimeout(timeoutId);
              if (!killed) resolve('Failed to get git diff');
            });
          });
        }
        
        const reviewPrompts = {
          comprehensive: 'Perform a complete code review covering security, performance, correctness, and style.',
          security_only: 'Focus ONLY on security vulnerabilities and concerns.',
          performance_only: 'Focus ONLY on performance issues and optimization opportunities.',
          quick: 'Quick review - highlight only critical issues.',
        };

        const prompt = `You are reviewing a git diff.

BASE BRANCH: ${base_branch}
COMMIT MESSAGE: ${commit_message}
REVIEW TYPE: ${review_type}

INSTRUCTIONS: ${reviewPrompts[review_type] || reviewPrompts.comprehensive}

DIFF:
${diffContent}

Provide:
1. CHANGE SUMMARY - What these changes do
2. ISSUES - Problems found (with line references from diff)
3. SUGGESTIONS - Improvements
4. VERDICT - Approve / Request Changes / Comment`;

        const result = await runGeminiCli(prompt, { model: 'gemini-2.5-pro' });
        return {
          content: [{ type: 'text', text: `[Git Diff Review - ${review_type}]\n\n${safeGetResponse(result)}` }],
        };
      }

      // === AI Collaboration Tools ===
      
      case 'ai_collaboration': {
        const {
          mode = 'debate',
          content,
          models = '',
          context = '',
          rounds = 3,
          debate_style = 'constructive',
          validation_criteria = '',
          confidence_threshold = 0.7,
          consensus_method = 'simple_majority',
          pipeline_stages = '',
        } = args;

        // Use AICollaborationEngine for REAL multi-model collaboration
        const collaborationEngine = new AICollaborationEngine({
          openrouter: {
            apiKey: process.env.OPENROUTER_API_KEY,
          },
        });

        const modelList = models ? models.split(',').map(m => m.trim()) : undefined;

        try {
          // Map string parameters to engine options
          const collaborationOptions = {
            mode: mode.toLowerCase(),
            content,
            models: modelList,
            context,
          };

          // Add mode-specific options
          if (mode === 'debate') {
            collaborationOptions.rounds = rounds;
            collaborationOptions.debateStyle = debate_style;
          } else if (mode === 'validation') {
            collaborationOptions.validationCriteria = validation_criteria;
            collaborationOptions.confidenceThreshold = confidence_threshold;
            collaborationOptions.consensusMethod = consensus_method;
          } else if (mode === 'sequential') {
            collaborationOptions.pipelineStages = pipeline_stages || 'analysis,review,optimization';
          }

          const result = await collaborationEngine.collaborate(collaborationOptions);

          // Format output based on mode
          let output = `[AI Collaboration - ${mode.toUpperCase()}]\n\n`;

          if (mode === 'debate') {
            output += `**Style:** ${result.style}\n`;
            output += `**Rounds:** ${result.rounds}\n`;
            output += `**Participants:** ${result.participants.join(', ')}\n\n`;
            output += `**Debate History:**\n`;
            for (const entry of result.history.slice(-6)) { // Show last 6 entries
              output += `\n---\n[Round ${entry.round}] [${entry.model}]:\n${entry.content || entry.error || 'No response'}\n`;
            }
            output += `\n---\n\n**Synthesis:**\n${result.synthesis}`;
          } else if (mode === 'validation') {
            output += `**Criteria:** ${result.criteria.join(', ')}\n`;
            output += `**Method:** ${result.method}\n`;
            output += `**Participants:** ${result.participants.join(', ')}\n\n`;
            output += `**Validations:**\n`;
            for (const v of result.validations) {
              output += `\n---\n[${v.model}]:\n${v.validation || v.error || 'No response'}\n`;
            }
            output += `\n---\n\n**Consensus:** ${JSON.stringify(result.consensus, null, 2)}`;
          } else if (mode === 'sequential') {
            output += `**Stages:** ${result.summary.stagesCompleted.join(' → ')}\n`;
            output += `**Success Rate:** ${result.summary.successfulStages}/${result.summary.totalStages}\n\n`;
            if (result.summary.failedStages.length > 0) {
              output += `**Failed Stages:** ${result.summary.stagesFailed.map(s => s.stage).join(', ')}\n\n`;
            }
            output += `**Final Output:**\n${result.finalOutput}`;
          }

          return {
            content: [{ type: 'text', text: output }],
          };
        } catch (error) {
          // Fallback to simulated collaboration if engine fails
          // (e.g., if OpenRouter not configured)
          const fallbackPrompt = `You are simulating a ${mode} collaboration.

TOPIC/CONTENT: ${content}
CONTEXT: ${context}
${mode === 'debate' ? `DEBATE STYLE: ${debate_style}\nROUNDS: ${rounds}` : ''}
${mode === 'validation' ? `CRITERIA: ${validation_criteria || 'correctness, completeness, quality'}` : ''}
${mode === 'sequential' ? `STAGES: ${pipeline_stages || 'analysis,review,optimization'}` : ''}

Provide comprehensive ${mode} analysis with multiple perspectives.`;

          const fallbackResult = await runGeminiCli(fallbackPrompt, { model: 'gemini-2.5-pro' });
          return {
            content: [{ type: 'text', text: `[AI Collaboration - ${mode} (fallback mode)]\n\n${fallbackResult.response}\n\n_Note: Full multi-model collaboration requires OpenRouter API key._` }],
          };
        }
      }

      case 'cross_model_comparison': {
        const { prompt, models = 'gemini-2.5-flash,gemini-2.5-pro' } = args;

        const modelList = models.split(',').map(m => m.trim());
        const results = [];

        for (const model of modelList) {
          if (model.startsWith('gemini-')) {
            try {
              const result = await runGeminiCli(prompt, { model });
              results.push({ model, response: safeGetResponse(result), error: null });
            } catch (error) {
              results.push({ model, response: null, error: error.message });
            }
          } else {
            results.push({ model, response: null, error: 'OpenRouter models require OPENROUTER_API_KEY' });
          }
        }

        const output = results.map(r => {
          if (r.error) {
            return `## ${r.model}\n❌ Error: ${r.error}`;
          }
          return `## ${r.model}\n${r.response}`;
        }).join('\n\n---\n\n');

        return {
          content: [{ type: 'text', text: `[Cross-Model Comparison]\n\n${output}` }],
        };
      }

      // === OpenRouter Tools ===
      
      case 'openrouter_chat': {
        const { prompt, model = 'openai/gpt-4.1-nano', temperature = 0.7, max_tokens = 4096 } = args;

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          return {
            content: [{ type: 'text', text: 'OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable.\nGet your key at: https://openrouter.ai/keys' }],
            isError: true,
          };
        }

        // Create AbortController for timeout (60 seconds)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/hybrid-cli-agent',
              'X-Title': 'Hybrid CLI Agent',
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              temperature,
              max_tokens,
            }),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (!response.ok) {
            const error = await response.text();
            return {
              content: [{ type: 'text', text: `OpenRouter error: ${error}` }],
              isError: true,
            };
          }

          const data = await response.json();
          const content = data.choices[0]?.message?.content || 'No response';

          // Track usage stats (fix: was previously not updating)
          if (data.usage) {
            openrouterStats.requests++;
            openrouterStats.inputTokens += data.usage.prompt_tokens || 0;
            openrouterStats.outputTokens += data.usage.completion_tokens || 0;
            // Estimate cost based on model
            const modelCosts = {
              'openai/gpt-4.1-nano': { input: 0.1, output: 0.4 },
              'openai/gpt-4.1-mini': { input: 0.4, output: 1.6 },
              'openai/gpt-4o': { input: 2.5, output: 10 },
              'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
              'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
            };
            const costs = modelCosts[model] || { input: 0.5, output: 1.5 };
            openrouterStats.estimatedCost +=
              ((data.usage.prompt_tokens || 0) / 1_000_000) * costs.input +
              ((data.usage.completion_tokens || 0) / 1_000_000) * costs.output;
          }

          return {
            content: [{ type: 'text', text: `[${model}]\n\n${content}` }],
          };
        } catch (error) {
          clearTimeout(timeoutId);
          if (error.name === 'AbortError') {
            return {
              content: [{ type: 'text', text: 'OpenRouter request timed out after 60 seconds' }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `OpenRouter error: ${error.message}` }],
            isError: true,
          };
        }
      }

      case 'openrouter_models': {
        const { provider_filter = '' } = args;
        
        const models = {
          'openai': ['gpt-4.1-nano ($0.10/1M)', 'gpt-4.1-mini ($0.40/1M)', 'gpt-4o ($2.50/1M)', 'gpt-4o-mini ($0.15/1M)'],
          'anthropic': ['claude-3-haiku ($0.25/1M)', 'claude-3.5-sonnet ($3/1M)', 'claude-sonnet-4 ($3/1M)'],
          'meta': ['llama-3.1-8b-instruct ($0.05/1M)', 'llama-3.1-70b-instruct ($0.35/1M)', 'llama-3.1-405b-instruct ($2.70/1M)'],
          'google': ['gemini-2.5-flash ($0.08/1M)', 'gemini-2.5-pro ($1.25/1M)'],
          'deepseek': ['deepseek-r1 ($0.55/1M)', 'deepseek-chat ($0.14/1M)'],
          'mistral': ['mistral-large ($2/1M)', 'devstral-small ($0.10/1M)'],
          'free': ['meta-llama/llama-3.2-3b-instruct:free', 'google/gemma-2-9b-it:free'],
        };
        
        let output = '# Available OpenRouter Models\n\n';
        
        const providers = provider_filter 
          ? [provider_filter.toLowerCase()] 
          : Object.keys(models);
        
        for (const provider of providers) {
          if (models[provider]) {
            output += `## ${provider.charAt(0).toUpperCase() + provider.slice(1)}\n`;
            output += models[provider].map(m => `- ${m}`).join('\n') + '\n\n';
          }
        }
        
        output += '\nGet API key at: https://openrouter.ai/keys';
        
        return {
          content: [{ type: 'text', text: output }],
        };
      }

      case 'openrouter_usage_stats': {
        return {
          content: [{ type: 'text', text: `OpenRouter Usage Stats:
- Session requests: ${openrouterStats.requests}
- Input tokens: ${openrouterStats.inputTokens.toLocaleString()}
- Output tokens: ${openrouterStats.outputTokens.toLocaleString()}
- Estimated cost: $${openrouterStats.estimatedCost.toFixed(4)}
- API key configured: ${process.env.OPENROUTER_API_KEY ? 'Yes' : 'No'}

Note: Actual costs may vary. Check OpenRouter dashboard for precise usage.` }],
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
          content: [{ type: 'text', text: `# Hybrid Agent Metrics

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

## OpenRouter
- API key configured: ${process.env.OPENROUTER_API_KEY ? 'Yes' : 'No'}
- Session requests: ${openrouterStats.requests}
- Input tokens: ${openrouterStats.inputTokens.toLocaleString()}
- Output tokens: ${openrouterStats.outputTokens.toLocaleString()}
- Estimated cost: $${openrouterStats.estimatedCost.toFixed(4)}

## Available Tools: 27
- Core Gemini Tools: 6
- Analysis Tools: 4
- AI Collaboration Tools: 2
- OpenRouter Tools: 3
- Conversation Tools: 5
- Content Analysis Tools: 3
- Cache Management: 1
- Metrics & Status: 3` }],
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
          version: '0.3.4',  // Agent output fixes + auto cleanup
          auth: {
            method: AUTH_CONFIG.method,
            geminiApiKey: maskValue(process.env.GEMINI_API_KEY),
            googleApiKey: maskValue(process.env.GOOGLE_API_KEY),
            vertexApiKey: maskValue(process.env.VERTEX_API_KEY),
            openrouterApiKey: maskValue(process.env.OPENROUTER_API_KEY),
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
- OpenRouter API Key: ${config.auth.openrouterApiKey}

## Model Selection (Smart Routing)
- Default for complex tasks: gemini-3-pro (available to all auth methods)
- Default for standard tasks: gemini-2.5-pro
- Default for simple tasks: gemini-2.5-flash
- Rate limit fallback: Enabled
- Auth method: ${AUTH_CONFIG.method} ${AUTH_CONFIG.method === 'vertex' ? '(higher rate limits)' : ''}
- Model status:
${modelStatus}

## Task Classification
- Complex tasks (Tier 1): code generation, plan evaluation, solution verification
- Standard tasks (Tier 2): research, analysis, prompts, comparisons
- Simple tasks (Tier 3): summarization, quick questions, reviews

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
- To use API key auth: Set GEMINI_API_KEY=your-key
- To enable OpenRouter: Set OPENROUTER_API_KEY=sk-or-...`;

        return {
          content: [{ type: 'text', text: output }],
        };
      }

      // === Conversation Tool Handlers ===

      case 'gemini_start_conversation': {
        const { title, system_prompt, model = 'gemini-2.5-pro', initial_message } = args;
        const conversationManager = getConversationManager();

        const conversation = conversationManager.startConversation({
          title,
          systemPrompt: system_prompt,
          model,
        });

        let response = `✅ Conversation started!
- ID: ${conversation.id}
- Title: ${conversation.title}
- Model: ${conversation.model}

Use gemini_continue_conversation with this ID to send messages.`;

        // If initial message provided, send it
        if (initial_message) {
          conversationManager.addMessage(conversation.id, MessageRole.USER, initial_message);
          const contextPrompt = conversationManager.buildContextPrompt(conversation.id, initial_message);
          const geminiResult = await runGeminiCli(contextPrompt, { model });
          conversationManager.addMessage(conversation.id, MessageRole.ASSISTANT, geminiResult.response);

          response += `\n\n---\n\n**Initial Response:**\n${geminiResult.response}`;
        }

        return {
          content: [{ type: 'text', text: response }],
        };
      }

      case 'gemini_continue_conversation': {
        const { conversation_id, message } = args;
        const conversationManager = getConversationManager();

        const conversation = conversationManager.getConversation(conversation_id);
        if (!conversation) {
          return {
            content: [{ type: 'text', text: `❌ Conversation ${conversation_id} not found` }],
            isError: true,
          };
        }

        // Add user message
        conversationManager.addMessage(conversation_id, MessageRole.USER, message);

        // Build context prompt with history
        const contextPrompt = conversationManager.buildContextPrompt(conversation_id, message);

        // Get Gemini response
        const geminiResult = await runGeminiCli(contextPrompt, { model: conversation.model });

        // Add assistant response
        conversationManager.addMessage(conversation_id, MessageRole.ASSISTANT, geminiResult.response);

        const stats = conversationManager.getConversationStats(conversation_id);

        return {
          content: [{ type: 'text', text: `[${conversation.title} - Turn ${stats.stats.userMessages}]\n\n${geminiResult.response}\n\n---\n_Tokens: ~${stats.stats.estimatedTokens} | Messages: ${stats.stats.messageCount}_` }],
        };
      }

      case 'gemini_list_conversations': {
        const { state, limit = 20 } = args;
        const conversationManager = getConversationManager();

        const result = conversationManager.listConversations({ state, limit });

        if (result.conversations.length === 0) {
          return {
            content: [{ type: 'text', text: 'No conversations found. Use gemini_start_conversation to create one.' }],
          };
        }

        let output = `# Conversations (${result.total} total)\n\n`;
        for (const conv of result.conversations) {
          const stateEmoji = conv.state === 'active' ? '🟢' : conv.state === 'completed' ? '✅' : '⏸️';
          output += `${stateEmoji} **${conv.title}**\n`;
          output += `   ID: \`${conv.id}\`\n`;
          output += `   Model: ${conv.model} | Messages: ${conv.messageCount}\n`;
          output += `   Updated: ${conv.updatedAt}\n\n`;
        }

        return {
          content: [{ type: 'text', text: output }],
        };
      }

      case 'gemini_clear_conversation': {
        const { conversation_id } = args;
        const conversationManager = getConversationManager();

        const cleared = conversationManager.clearConversation(conversation_id);

        if (cleared) {
          return {
            content: [{ type: 'text', text: `✅ Conversation ${conversation_id} cleared successfully.` }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `❌ Conversation ${conversation_id} not found.` }],
            isError: true,
          };
        }
      }

      case 'gemini_conversation_stats': {
        const { conversation_id } = args;
        const conversationManager = getConversationManager();

        if (conversation_id) {
          const stats = conversationManager.getConversationStats(conversation_id);
          if (!stats) {
            return {
              content: [{ type: 'text', text: `❌ Conversation ${conversation_id} not found.` }],
              isError: true,
            };
          }

          return {
            content: [{ type: 'text', text: `# Conversation Stats: ${stats.title}

**ID:** ${stats.id}
**State:** ${stats.state}
**Model:** ${stats.model}

## Usage
- Messages: ${stats.stats.messageCount}
- User messages: ${stats.stats.userMessages}
- Assistant messages: ${stats.stats.assistantMessages}
- Estimated tokens: ${stats.stats.estimatedTokens}
- Token usage: ${stats.tokenUsagePercent.toFixed(1)}%
- Message usage: ${stats.messageUsagePercent.toFixed(1)}%

## Timestamps
- Created: ${stats.metadata.createdAt}
- Updated: ${stats.metadata.updatedAt}` }],
          };
        } else {
          const globalStats = conversationManager.getGlobalStats();

          return {
            content: [{ type: 'text', text: `# Global Conversation Stats

## Overview
- Total conversations: ${globalStats.totalConversations}
- Active conversations: ${globalStats.activeConversations}
- Total messages: ${globalStats.totalMessages}
- Estimated total tokens: ${globalStats.totalTokensEstimated}

## Limits
- Max messages per conversation: ${globalStats.config.maxMessages}
- Max tokens per conversation: ${globalStats.config.maxTotalTokens}
- Conversation expiration: ${globalStats.config.expirationMs / 1000 / 60 / 60}h` }],
          };
        }
      }

      // === Cache Management Tool Handler ===

      case 'gemini_cache_manage': {
        const { action = 'stats', prompt, model = 'gemini-2.5-pro' } = args;
        const cache = getResponseCache();

        switch (action) {
          case 'stats': {
            const stats = cache.getStats();
            return {
              content: [{ type: 'text', text: `# Cache Statistics

## Performance
- Cache hits: ${stats.hits}
- Cache misses: ${stats.misses}
- Hit rate: ${stats.hitRate}

## Storage
- Cached entries: ${stats.size}
- Max entries: ${stats.maxEntries}
- Default TTL: ${stats.defaultTTL / 1000 / 60} minutes

## Maintenance
- Evictions (LRU): ${stats.evictions}
- Expirations (TTL): ${stats.expirations}` }],
            };
          }

          case 'clear': {
            const count = cache.clear();
            return {
              content: [{ type: 'text', text: `✅ Cache cleared. Removed ${count} entries.` }],
            };
          }

          case 'check': {
            if (!prompt) {
              return {
                content: [{ type: 'text', text: '❌ Prompt required for check action' }],
                isError: true,
              };
            }

            const isCached = cache.has(prompt, { model });
            return {
              content: [{ type: 'text', text: isCached
                ? `✅ Query is cached (model: ${model})`
                : `❌ Query is not cached (model: ${model})` }],
            };
          }

          default:
            return {
              content: [{ type: 'text', text: `❌ Unknown action: ${action}` }],
              isError: true,
            };
        }
      }

      // === Content Analysis Tool Handlers ===

      case 'gemini_content_comparison': {
        const { sources, comparison_type = 'semantic', focus = '' } = args;

        if (!sources || sources.length < 2) {
          return {
            content: [{ type: 'text', text: '❌ At least 2 sources required for comparison' }],
            isError: true,
          };
        }

        // Process sources (handle @file references)
        const processedSources = await Promise.all(sources.map(async (source, i) => {
          if (source.startsWith('@')) {
            const filepath = source.slice(1);
            try {
              const content = await readFile(filepath, 'utf-8');
              return { label: `Source ${i + 1} (${filepath})`, content };
            } catch (e) {
              return { label: `Source ${i + 1} (${filepath})`, content: `[Error reading file: ${e.message}]` };
            }
          }
          return { label: `Source ${i + 1}`, content: source };
        }));

        const comparisonMethods = {
          semantic: 'Focus on meaning and intent. Identify conceptual similarities and differences.',
          structural: 'Analyze structure and organization. Compare layouts, sections, and hierarchy.',
          line_by_line: 'Perform detailed line-by-line comparison. Show additions, deletions, and modifications.',
          key_points: 'Extract and compare key points from each source.',
        };

        const prompt = `You are a Content Comparison Specialist.

COMPARISON TYPE: ${comparison_type}
METHOD: ${comparisonMethods[comparison_type]}
${focus ? `FOCUS AREAS: ${focus}` : ''}

SOURCES TO COMPARE:
${processedSources.map(s => `\n=== ${s.label} ===\n${s.content}`).join('\n')}

Provide a structured comparison:

## Summary
Brief overview of the comparison.

## Similarities
What the sources have in common.

## Differences
Key differences between sources (be specific, reference source numbers).

## Analysis
Deeper insights based on the ${comparison_type} comparison.
${focus ? `\n### Focus: ${focus}\nSpecific analysis of the requested focus areas.` : ''}

## Recommendations
Suggested actions or considerations based on the comparison.`;

        const result = await runGeminiCli(prompt, { model: 'gemini-2.5-pro' });

        return {
          content: [{ type: 'text', text: `[Content Comparison - ${comparison_type}]\n\n${safeGetResponse(result)}` }],
        };
      }

      case 'gemini_extract_structured': {
        const { content, schema, schema_description, examples = [] } = args;

        // Handle @file reference
        let textContent = content;
        if (content.startsWith('@')) {
          const filepath = content.slice(1);
          try {
            textContent = await readFile(filepath, 'utf-8');
          } catch (e) {
            return {
              content: [{ type: 'text', text: `❌ Error reading file: ${e.message}` }],
              isError: true,
            };
          }
        }

        let schemaSection = '';
        if (schema) {
          schemaSection = `\nOUTPUT JSON SCHEMA:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;
        } else if (schema_description) {
          schemaSection = `\nEXPECTED OUTPUT STRUCTURE:\n${schema_description}`;
        } else {
          schemaSection = '\nInfer an appropriate JSON structure from the content.';
        }

        let examplesSection = '';
        if (examples.length > 0) {
          examplesSection = `\n\nEXAMPLES OF EXPECTED OUTPUT:\n${examples.map((ex, i) => `Example ${i + 1}:\n\`\`\`json\n${JSON.stringify(ex, null, 2)}\n\`\`\``).join('\n\n')}`;
        }

        const prompt = `You are a Data Extraction Specialist.

Extract structured data from the following content and return ONLY valid JSON.
${schemaSection}
${examplesSection}

CONTENT TO EXTRACT FROM:
${textContent}

IMPORTANT:
- Return ONLY the JSON, no markdown code blocks
- Ensure all JSON is valid and properly escaped
- If data is missing, use null
- If multiple items match, return an array`;

        const result = await runGeminiCli(prompt, { model: 'gemini-2.5-pro' });

        // Try to parse and validate JSON
        let parsedJson;
        try {
          // Clean up common issues
          const cleanedResponse = safeGetResponse(result)
            .replace(/^```json\n?/gm, '')
            .replace(/```$/gm, '')
            .trim();
          parsedJson = JSON.parse(cleanedResponse);
        } catch (e) {
          return {
            content: [{ type: 'text', text: `[Extracted Data - Raw]\n\n${safeGetResponse(result)}\n\n⚠️ Note: Response may not be valid JSON. Error: ${e.message}` }],
          };
        }

        return {
          content: [{ type: 'text', text: `[Extracted Structured Data]\n\n\`\`\`json\n${JSON.stringify(parsedJson, null, 2)}\n\`\`\`` }],
        };
      }

      case 'gemini_summarize_files': {
        const { file_patterns, summary_style = 'bullet_points', max_words_per_file = 100, group_by = 'directory', base_dir = process.cwd() } = args;

        // Sanitize glob patterns
        const safePatterns = sanitizeGlobPatterns(file_patterns, base_dir);
        if (safePatterns.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: No valid file patterns provided. Patterns cannot contain ".." or be absolute paths.' }],
            isError: true,
          };
        }

        const files = await readFilesFromPatterns(safePatterns, base_dir);

        if (files.length === 0) {
          return {
            content: [{ type: 'text', text: 'No files found matching the patterns.' }],
          };
        }

        const styleInstructions = {
          brief: 'One sentence summary.',
          detailed: 'Comprehensive summary covering purpose, key components, and notable aspects.',
          bullet_points: '3-5 bullet points highlighting key aspects.',
          executive: 'High-level executive summary focusing on business value and key decisions.',
        };

        const prompt = `You are a Technical Documentation Specialist.

Summarize each of the following ${files.length} files.

SUMMARY STYLE: ${summary_style}
INSTRUCTION: ${styleInstructions[summary_style]}
MAX WORDS PER FILE: ${max_words_per_file}
GROUPING: ${group_by}

FILES:
${files.map(f => `\n=== ${f.path} ===\n${f.content.slice(0, 10000)}`).join('\n')}

${group_by !== 'none' ? `Group the summaries by ${group_by}.` : ''}

Output format:
${group_by !== 'none' ? '## [Group Name]\n\n' : ''}### [filename]
[Summary in ${summary_style} style]
`;

        const result = await runGeminiCli(prompt, { model: 'gemini-2.5-flash' });

        return {
          content: [{ type: 'text', text: `[File Summaries - ${files.length} files]\n\n${safeGetResponse(result)}` }],
        };
      }

      // ============================================================================
      // Agent Tools - Autonomous Task Execution
      // ============================================================================

      case 'gemini_agent_task':
      case 'gemini_agent_list':
      case 'gemini_agent_clear': {
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

// OpenRouter usage tracking
const openrouterStats = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCost: 0,
};

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

    // Clear any active conversations
    const conversationManager = getConversationManager();
    if (conversationManager) {
      const stats = conversationManager.getStats();
      console.error(`[gemini-worker] Active conversations at shutdown: ${stats.activeConversations}`);
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
