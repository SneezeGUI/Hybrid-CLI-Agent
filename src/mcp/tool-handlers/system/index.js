/**
 * System Tool Handlers
 *
 * Handlers: hybrid_metrics, gemini_config_show, gemini_cache_manage
 */

import { success, error } from '../base.js';

/**
 * Get hybrid agent metrics
 */
async function handleHybridMetrics(args, context) {
  const { AUTH_CONFIG, getDefaultModel, openrouterStats } = context;

  return success(`# Hybrid Agent Metrics

## Gemini CLI
- Auth method: ${AUTH_CONFIG.method}
- Free tier: ${AUTH_CONFIG.method === 'oauth' ? 'Yes (60 RPM, 1000 RPD)' : 'No'}
- Default model: ${getDefaultModel()}

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
- Metrics & Status: 3`);
}

/**
 * Show configuration
 */
async function handleGeminiConfigShow(args, context) {
  const { show_env = false } = args;
  const { AUTH_CONFIG, getDefaultModel, getSupportedModels, MODEL_CAPABILITIES, rateLimitTracker } = context;

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
    return `  - ${model}: ${available ? 'Available' : 'Rate limited'} (Tier ${caps?.tier || '?'})`;
  }).join('\n');

  const config = {
    version: '0.3.3',
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

  return success(output);
}

/**
 * Manage response cache
 */
async function handleGeminiCacheManage(args, context) {
  const { action = 'stats', prompt, model = 'gemini-2.5-pro' } = args;
  const { getResponseCache } = context;

  const cache = getResponseCache();

  switch (action) {
    case 'stats': {
      const stats = cache.getStats();
      return success(`# Cache Statistics

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
- Expirations (TTL): ${stats.expirations}`);
    }

    case 'clear': {
      const count = cache.clear();
      return success(`Cache cleared. Removed ${count} entries.`);
    }

    case 'check': {
      if (!prompt) {
        return error('Prompt required for check action');
      }

      const isCached = cache.has(prompt, { model });
      return success(isCached
        ? `Query is cached (model: ${model})`
        : `Query is not cached (model: ${model})`);
    }

    default:
      return error(`Unknown action: ${action}`);
  }
}

/**
 * Export handlers map
 */
export const handlers = {
  hybrid_metrics: handleHybridMetrics,
  gemini_config_show: handleGeminiConfigShow,
  gemini_cache_manage: handleGeminiCacheManage,
};

export default handlers;
