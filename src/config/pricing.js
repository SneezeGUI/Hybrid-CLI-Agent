/**
 * Centralized pricing configuration for the hybrid-cli-agent MCP server.
 * All prices are in USD per 1 Million tokens.
 */

/**
 * Pricing for Google Gemini models (API pricing).
 * Note: Users authenticated via OAuth (Google Cloud Project) may have free tier access
 * depending on their quota, but this table reflects the paid API rates.
 * @type {Object.<string, {input: number, output: number}>}
 */
export const GEMINI_PRICING = {
  'gemini-2.0-flash-exp': { input: 0.075, output: 0.30 },
  'gemini-2.5-flash': { input: 0.075, output: 0.30 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.5-pro': { input: 1.25, output: 5.0 },
  'gemini-3-flash-preview': { input: 0.10, output: 0.40 },
  'gemini-3-pro-preview': { input: 1.25, output: 5.0 },
  'gemini-3-pro': { input: 1.25, output: 5.0 },
};

/**
 * Pricing for Anthropic Claude models.
 * @type {Object.<string, {input: number, output: number}>}
 */
export const CLAUDE_PRICING = {
  'claude-sonnet-4-5-20250514': { input: 3.0, output: 15.0 },
  'claude-opus-4-5-20250514': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-opus-20240229': { input: 15.0, output: 75.0 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 }
};

/**
 * Pricing for OpenRouter models.
 * @type {Object.<string, {input: number, output: number}>}
 */
export const OPENROUTER_PRICING = {
  'openai/gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'openai/gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'openai/gpt-4o': { input: 2.5, output: 10 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
  'anthropic/claude-3.5-sonnet': { input: 3, output: 15 },
  'anthropic/claude-sonnet-4': { input: 3, output: 15 },
  'meta-llama/llama-3.1-8b-instruct': { input: 0.05, output: 0.08 },
  'meta-llama/llama-3.1-70b-instruct': { input: 0.35, output: 0.4 },
  'meta-llama/llama-3.1-405b-instruct': { input: 2.7, output: 2.7 },
  'google/gemini-2.5-flash': { input: 0.075, output: 0.3 },
  'google/gemini-2.5-pro': { input: 1.25, output: 5 },
  'deepseek/deepseek-r1': { input: 0.55, output: 2.19 },
  'deepseek/deepseek-chat': { input: 0.14, output: 0.28 },
  'mistralai/mistral-large': { input: 2, output: 6 },
  'mistralai/devstral-small': { input: 0.1, output: 0.3 },
  'meta-llama/llama-3.2-3b-instruct:free': { input: 0, output: 0 },
  'google/gemma-2-9b-it:free': { input: 0, output: 0 }
};

/**
 * Default pricing for unknown models to prevent calculation errors.
 */
export const DEFAULT_PRICING = { input: 0.5, output: 1.5 };

/**
 * Helper to determine if the authentication method qualifies for free tier (Gemini).
 * @param {string} authMethod - The authentication method used (e.g., 'oauth', 'api_key').
 * @returns {boolean}
 */
export function isOAuthFree(authMethod) {
  return authMethod === 'oauth';
}

/**
 * Retrieves pricing for a specific Gemini model.
 * @param {string} model - The model identifier.
 * @returns {{input: number, output: number}}
 */
export function getGeminiPricing(model) {
  return GEMINI_PRICING[model] || DEFAULT_PRICING;
}

/**
 * Retrieves pricing for a specific Claude model.
 * @param {string} model - The model identifier.
 * @returns {{input: number, output: number}}
 */
export function getClaudePricing(model) {
  return CLAUDE_PRICING[model] || DEFAULT_PRICING;
}

/**
 * Retrieves pricing for a specific OpenRouter model.
 * @param {string} model - The model identifier.
 * @returns {{input: number, output: number}}
 */
export function getOpenRouterPricing(model) {
  return OPENROUTER_PRICING[model] || DEFAULT_PRICING;
}

/**
 * Calculates the estimated cost for a request.
 * @param {string} model - The model identifier.
 * @param {number} inputTokens - Number of prompt tokens.
 * @param {number} outputTokens - Number of completion tokens.
 * @param {string} provider - The provider ('gemini', 'claude', 'openrouter').
 * @param {string} [authMethod='api_key'] - Authentication method (affects Gemini pricing).
 * @returns {number} The estimated cost in USD.
 */
export function calculateCost(model, inputTokens, outputTokens, provider, authMethod = 'api_key') {
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    // console.warn('Invalid token counts provided to calculateCost');
    return 0;
  }

  // Gemini OAuth users often have a free tier (ignoring rate limits for pricing calculation)
  if (provider === 'gemini' && isOAuthFree(authMethod)) {
    return 0;
  }

  let pricing;

  switch (provider) {
    case 'gemini':
      pricing = getGeminiPricing(model);
      break;
    case 'claude':
    case 'anthropic':
      pricing = getClaudePricing(model);
      break;
    case 'openrouter':
      pricing = getOpenRouterPricing(model);
      break;
    default:
      pricing = DEFAULT_PRICING;
  }

  const inputCost = (inputTokens / 1000000) * pricing.input;
  const outputCost = (outputTokens / 1000000) * pricing.output;

  return Number((inputCost + outputCost).toFixed(9)); // High precision for micro-transactions
}