/**
 * @fileoverview Centralized configuration for AI models supported by the hybrid-cli-agent.
 * Contains definitions for Gemini, Claude, and OpenRouter models, including capabilities and limits.
 * @module config/models
 */

/**
 * Gemini model capabilities and configuration.
 * @type {Object.<string, {name: string, tier: number, complexity: string, contextWindow: number, rpmLimit: number}>}
 */
export const GEMINI_MODELS = {
  'gemini-3-pro-preview': {
    name: 'gemini-3-pro-preview',
    tier: 1,
    complexity: 'highest',
    contextWindow: 2000000,
    strengths: ['complex reasoning', 'code generation', 'nuanced analysis', 'multi-step tasks'],
    requires: null,
    costPerMToken: 0,  // FREE with OAuth
    rpmLimit: 10,
  },
  'gemini-3-flash-preview': {
    name: 'gemini-3-flash-preview',
    tier: 1,
    complexity: 'high',
    contextWindow: 1000000,
    strengths: ['fast complex tasks', 'code generation', 'quick analysis'],
    requires: null,
    costPerMToken: 0,
    rpmLimit: 60,
  },
  'gemini-2.5-pro': {
    name: 'gemini-2.5-pro',
    tier: 2,
    complexity: 'high',
    contextWindow: 1000000,
    strengths: ['code generation', 'analysis', 'reasoning', 'general purpose'],
    requires: null,
    costPerMToken: 0,  // FREE with OAuth
    rpmLimit: 60,
  },
  'gemini-2.5-flash': {
    name: 'gemini-2.5-flash',
    tier: 3,
    complexity: 'medium',
    contextWindow: 1000000,
    strengths: ['speed', 'cost efficiency', 'simple tasks', 'summarization'],
    requires: null,
    costPerMToken: 0,  // FREE with OAuth
    rpmLimit: 60,
  },
  // Alias for gemini-3-pro-preview (used in some contexts)
  'gemini-3-pro': {
    name: 'gemini-3-pro',
    tier: 1,
    complexity: 'highest',
    contextWindow: 2000000,
    strengths: ['complex reasoning', 'code generation', 'nuanced analysis', 'multi-step tasks'],
    requires: null,
    costPerMToken: 0,  // FREE with OAuth
    rpmLimit: 10,
  },
};

/**
 * List of available Claude models.
 * @type {string[]}
 */
export const CLAUDE_MODELS = [
  'claude-sonnet-4-5-20250514',
  'claude-opus-4-5-20250514',
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-3-5-sonnet-20241022',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307'
];

/**
 * OpenRouter model definitions with provider and pricing info.
 * Keys are the full OpenRouter model IDs.
 * @type {Object.<string, {provider: string, costPer1M: {input: number, output: number}}>}
 */
export const OPENROUTER_MODELS = {
  // OpenAI
  'openai/gpt-4.1-nano': { provider: 'OpenAI', costPer1M: { input: 0.1, output: 0.4 } },
  'openai/gpt-4.1-mini': { provider: 'OpenAI', costPer1M: { input: 0.4, output: 1.6 } },
  'openai/gpt-4o': { provider: 'OpenAI', costPer1M: { input: 2.5, output: 10 } },
  'openai/gpt-4o-mini': { provider: 'OpenAI', costPer1M: { input: 0.15, output: 0.6 } },

  // Anthropic
  'anthropic/claude-3-haiku': { provider: 'Anthropic', costPer1M: { input: 0.25, output: 1.25 } },
  'anthropic/claude-3.5-sonnet': { provider: 'Anthropic', costPer1M: { input: 3, output: 15 } },
  'anthropic/claude-sonnet-4': { provider: 'Anthropic', costPer1M: { input: 3, output: 15 } },

  // Meta
  'meta-llama/llama-3.1-8b-instruct': { provider: 'Meta', costPer1M: { input: 0.05, output: 0.08 } },
  'meta-llama/llama-3.1-70b-instruct': { provider: 'Meta', costPer1M: { input: 0.35, output: 0.4 } },
  'meta-llama/llama-3.1-405b-instruct': { provider: 'Meta', costPer1M: { input: 2.7, output: 2.7 } },

  // Google (via OpenRouter)
  'google/gemini-2.5-flash': { provider: 'Google', costPer1M: { input: 0.075, output: 0.3 } },
  'google/gemini-2.5-pro': { provider: 'Google', costPer1M: { input: 1.25, output: 5 } },

  // DeepSeek
  'deepseek/deepseek-r1': { provider: 'DeepSeek', costPer1M: { input: 0.55, output: 2.19 } },
  'deepseek/deepseek-chat': { provider: 'DeepSeek', costPer1M: { input: 0.14, output: 0.28 } },

  // Mistral
  'mistralai/mistral-large': { provider: 'Mistral', costPer1M: { input: 2, output: 6 } },
  'mistralai/devstral-small': { provider: 'Mistral', costPer1M: { input: 0.1, output: 0.3 } },

  // Free models
  'meta-llama/llama-3.2-3b-instruct:free': { provider: 'Meta', costPer1M: { input: 0, output: 0 } },
  'google/gemma-2-9b-it:free': { provider: 'Google', costPer1M: { input: 0, output: 0 } },
};

/**
 * Array of valid Gemini model identifiers used for validation.
 * @type {string[]}
 */
export const VALID_MODELS = Object.keys(GEMINI_MODELS);

/**
 * Retrieves configuration for a specific Gemini model.
 * @param {string} name - The name/ID of the model.
 * @returns {Object|undefined} The model configuration object or undefined if not found.
 */
export const getGeminiModel = (name) => {
  return GEMINI_MODELS[name];
};

/**
 * Retrieves the list of all available Claude model names.
 * @returns {string[]} Array of Claude model IDs.
 */
export const getClaudeModels = () => {
  return [...CLAUDE_MODELS];
};

/**
 * Retrieves configuration for a specific OpenRouter model.
 * @param {string} name - The short name or ID of the OpenRouter model.
 * @returns {Object|undefined} The OpenRouter model configuration or undefined if not found.
 */
export const getOpenRouterModel = (name) => {
  return OPENROUTER_MODELS[name];
};

/**
 * Retrieves a list of supported Gemini model names.
 * @returns {string[]} Array of supported Gemini model names.
 */
export const getSupportedGeminiModels = () => {
  return Object.keys(GEMINI_MODELS);
};

/**
 * Checks if a given model name is a valid supported Gemini model.
 * @param {string} name - The model name to validate.
 * @returns {boolean} True if the model is valid, false otherwise.
 */
export const isValidGeminiModel = (name) => {
  return VALID_MODELS.includes(name);
};