/**
 * OpenRouter Client
 *
 * Provides access to 400+ AI models from OpenAI, Anthropic, Meta, Google, and more.
 *
 * Setup:
 *   export OPENROUTER_API_KEY="sk-or-v1-your-api-key"
 *
 * Get API key at: https://openrouter.ai/keys
 */

import { OPENROUTER_MODELS as CONFIG_OPENROUTER_MODELS } from '../config/index.js';

/**
 * Popular models available via OpenRouter
 * Re-exported from centralized config for backward compatibility
 */
export const OPENROUTER_MODELS = CONFIG_OPENROUTER_MODELS;

/**
 * OpenRouter API Client
 */
export class OpenRouterClient {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    this.baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1';
    this.defaultModel = config.defaultModel || process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4.1-nano';
    this.costLimitPerDay = parseFloat(process.env.OPENROUTER_COST_LIMIT_PER_DAY || '10.0');
    
    // Usage tracking
    this.usage = {
      totalCost: 0,
      requests: 0,
      tokensByModel: {},
    };
  }

  /**
   * Check if OpenRouter is configured
   */
  isConfigured() {
    return !!this.apiKey;
  }

  /**
   * Get available models (cached list)
   */
  getAvailableModels() {
    return Object.keys(OPENROUTER_MODELS);
  }

  /**
   * Get model info
   */
  getModelInfo(model) {
    return OPENROUTER_MODELS[model] || null;
  }

  /**
   * Send a chat completion request
   */
  async chat(options = {}) {
    if (!this.isConfigured()) {
      throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable.');
    }

    const {
      model = this.defaultModel,
      messages,
      prompt,
      temperature = 0.7,
      maxTokens = 4096,
      stream = false,
      timeoutMs = 60000, // 60 second default timeout
    } = options;

    // Convert prompt to messages format if needed
    const chatMessages = messages || [{ role: 'user', content: prompt }];

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/hybrid-cli-agent',
          'X-Title': 'Hybrid CLI Agent',
        },
        body: JSON.stringify({
          model,
          messages: chatMessages,
          temperature,
          max_tokens: maxTokens,
          stream,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
      }

      const data = await response.json();

      // Track usage
      if (data.usage) {
        this.trackUsage(model, data.usage);
      }

      return {
        content: data.choices[0]?.message?.content || '',
        model: data.model,
        usage: data.usage,
        cost: this.estimateCost(model, data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0),
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`OpenRouter request timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Track usage for cost management
   */
  trackUsage(model, usage) {
    this.usage.requests++;
    
    if (!this.usage.tokensByModel[model]) {
      this.usage.tokensByModel[model] = { input: 0, output: 0 };
    }
    
    this.usage.tokensByModel[model].input += usage.prompt_tokens || 0;
    this.usage.tokensByModel[model].output += usage.completion_tokens || 0;
    
    const cost = this.estimateCost(model, usage.prompt_tokens || 0, usage.completion_tokens || 0);
    this.usage.totalCost += cost;

    // Warn if approaching daily limit
    if (this.usage.totalCost > this.costLimitPerDay * 0.8) {
      console.warn(`[OpenRouter] Warning: Approaching daily cost limit (${this.usage.totalCost.toFixed(2)}/${this.costLimitPerDay} USD)`);
    }
  }

  /**
   * Estimate cost for a request
   */
  estimateCost(model, inputTokens, outputTokens) {
    const modelInfo = OPENROUTER_MODELS[model];
    if (!modelInfo) return 0;
    
    const inputCost = (inputTokens / 1_000_000) * modelInfo.costPer1M.input;
    const outputCost = (outputTokens / 1_000_000) * modelInfo.costPer1M.output;
    return inputCost + outputCost;
  }

  /**
   * Get usage statistics
   */
  getUsageStats() {
    return {
      ...this.usage,
      costLimitPerDay: this.costLimitPerDay,
      remainingBudget: this.costLimitPerDay - this.usage.totalCost,
    };
  }

  /**
   * Compare responses across multiple models
   */
  async crossModelComparison(prompt, models = []) {
    const modelsToUse = models.length > 0 ? models : [
      'openai/gpt-4.1-nano',
      'anthropic/claude-3-haiku',
      this.defaultModel,
    ];

    const results = await Promise.allSettled(
      modelsToUse.map(async (model) => {
        const result = await this.chat({ model, prompt });
        return { model, ...result };
      })
    );

    return results.map((result, i) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return { 
          model: modelsToUse[i], 
          error: result.reason.message,
          content: null,
        };
      }
    });
  }

  /**
   * Get an opinion from a specific model
   */
  async getOpinion(prompt, model = null) {
    return this.chat({
      model: model || this.defaultModel,
      prompt,
    });
  }
}

export default OpenRouterClient;
