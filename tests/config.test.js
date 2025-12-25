/**
 * Tests for configuration modules (models, pricing, timeouts)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  GEMINI_MODELS,
  CLAUDE_MODELS,
  OPENROUTER_MODELS,
  VALID_MODELS,
  GEMINI_PRICING,
  CLAUDE_PRICING,
  OPENROUTER_PRICING,
  TIMEOUTS,
  RATE_LIMITS,
  CACHE_CONFIG,
  getGeminiPricing,
  calculateCost,
  isValidGeminiModel,
  getTimeout,
  CONFIG
} from '../src/config/index.js';

describe('GEMINI_MODELS', () => {
  it('should export an object with model definitions', () => {
    assert.strictEqual(typeof GEMINI_MODELS, 'object');
    assert.ok(Object.keys(GEMINI_MODELS).length > 0);
  });

  it('should include required Gemini models', () => {
    assert.ok(GEMINI_MODELS['gemini-2.5-flash']);
    assert.ok(GEMINI_MODELS['gemini-2.5-pro']);
    assert.ok(GEMINI_MODELS['gemini-3-pro-preview']);
    assert.ok(GEMINI_MODELS['gemini-3-pro']);
  });

  it('should have correct structure for model definitions', () => {
    const model = GEMINI_MODELS['gemini-2.5-flash'];
    assert.ok(model.name);
    assert.strictEqual(typeof model.tier, 'number');
    assert.ok(model.complexity);
    assert.strictEqual(typeof model.contextWindow, 'number');
    assert.ok(Array.isArray(model.strengths));
    assert.strictEqual(typeof model.rpmLimit, 'number');
  });

  it('should validate valid models list matches keys', () => {
    assert.deepStrictEqual(VALID_MODELS.sort(), Object.keys(GEMINI_MODELS).sort());
  });
});

describe('GEMINI_PRICING', () => {
  it('should export pricing for Gemini models', () => {
    assert.ok(GEMINI_PRICING['gemini-2.5-flash']);
    assert.ok(GEMINI_PRICING['gemini-2.5-pro']);
  });

  it('should have input and output costs', () => {
    const pricing = GEMINI_PRICING['gemini-2.5-pro'];
    assert.strictEqual(typeof pricing.input, 'number');
    assert.strictEqual(typeof pricing.output, 'number');
  });

  it('should reflect that flash is cheaper than pro', () => {
    const flash = GEMINI_PRICING['gemini-2.5-flash'];
    const pro = GEMINI_PRICING['gemini-2.5-pro'];
    assert.ok(flash.input < pro.input);
    assert.ok(flash.output < pro.output);
  });
});

describe('CLAUDE_PRICING', () => {
  it('should export pricing for Claude models', () => {
    assert.ok(CLAUDE_PRICING['claude-sonnet-4-5-20250514']);
    assert.ok(CLAUDE_PRICING['claude-opus-4-5-20250514']);
  });

  it('should include pricing for legacy models', () => {
    assert.ok(CLAUDE_PRICING['claude-3-5-sonnet-20241022']);
  });
});

describe('OPENROUTER_MODELS', () => {
  it('should export OpenRouter definitions', () => {
    assert.ok(OPENROUTER_MODELS['openai/gpt-4o']);
    assert.ok(OPENROUTER_MODELS['anthropic/claude-3.5-sonnet']);
  });

  it('should include provider information', () => {
    assert.strictEqual(OPENROUTER_MODELS['openai/gpt-4o'].provider, 'OpenAI');
    assert.strictEqual(OPENROUTER_MODELS['anthropic/claude-3.5-sonnet'].provider, 'Anthropic');
    assert.strictEqual(OPENROUTER_MODELS['meta-llama/llama-3.1-70b-instruct'].provider, 'Meta');
    assert.strictEqual(OPENROUTER_MODELS['google/gemini-2.5-pro'].provider, 'Google');
  });
});

describe('TIMEOUTS', () => {
  it('should have standard timeout values', () => {
    assert.ok(TIMEOUTS.QUICK);
    assert.ok(TIMEOUTS.DEFAULT);
    assert.ok(TIMEOUTS.LONG);
    assert.ok(TIMEOUTS.EXTENDED);
  });

  it('should maintain logical timeout hierarchy', () => {
    assert.ok(TIMEOUTS.QUICK < TIMEOUTS.DEFAULT);
    assert.ok(TIMEOUTS.DEFAULT < TIMEOUTS.LONG);
    assert.ok(TIMEOUTS.LONG < TIMEOUTS.EXTENDED);
  });
});

describe('RATE_LIMITS & CACHE_CONFIG', () => {
  it('should export rate limits configuration', () => {
    assert.strictEqual(typeof RATE_LIMITS.cooldownMs, 'number');
    assert.strictEqual(typeof RATE_LIMITS.maxFailures, 'number');
  });

  it('should export cache configuration', () => {
    assert.strictEqual(typeof CACHE_CONFIG.maxEntries, 'number');
    assert.strictEqual(typeof CACHE_CONFIG.defaultTTL, 'number');
    assert.strictEqual(typeof CACHE_CONFIG.maxTTL, 'number');
  });
});

describe('Helper Functions', () => {
  describe('getGeminiPricing', () => {
    it('should return pricing for valid model', () => {
      const pricing = getGeminiPricing('gemini-2.5-flash');
      assert.strictEqual(pricing.input, 0.075);
    });

    it('should return default pricing for invalid model', () => {
      const pricing = getGeminiPricing('invalid-model');
      assert.ok(pricing.input > 0);
      assert.ok(pricing.output > 0);
    });
  });

  describe('calculateCost', () => {
    it('should calculate correct cost for Gemini', () => {
      // gemini-2.5-flash: input 0.075/1M, output 0.30/1M
      // 1M input + 1M output = 0.375
      const cost = calculateCost('gemini-2.5-flash', 1000000, 1000000, 'gemini');
      assert.strictEqual(cost, 0.375);
    });

    it('should return 0 for OAuth Gemini (Free Tier logic)', () => {
      const cost = calculateCost('gemini-2.5-flash', 1000, 1000, 'gemini', 'oauth');
      assert.strictEqual(cost, 0);
    });

    it('should calculate correct cost for Claude', () => {
      // claude-3-haiku: input 0.25/1M, output 1.25/1M
      const cost = calculateCost('claude-3-haiku-20240307', 1000000, 1000000, 'claude');
      assert.strictEqual(cost, 1.5);
    });

    it('should handle missing inputs gracefully', () => {
      const cost = calculateCost('gemini-2.5-flash', undefined, undefined, 'gemini');
      assert.strictEqual(cost, 0);
    });
  });

  describe('isValidGeminiModel', () => {
    it('should return true for valid models', () => {
      assert.strictEqual(isValidGeminiModel('gemini-2.5-pro'), true);
    });

    it('should return false for invalid models', () => {
      assert.strictEqual(isValidGeminiModel('gpt-4'), false);
    });
  });

  describe('getTimeout', () => {
    it('should return correct timeout value', () => {
      assert.strictEqual(getTimeout('QUICK'), TIMEOUTS.QUICK);
    });

    it('should return default for invalid type', () => {
      assert.strictEqual(getTimeout('INVALID_TYPE'), TIMEOUTS.DEFAULT);
    });
  });
});

describe('CONFIG Object', () => {
  it('should consolidate all configurations', () => {
    assert.ok(CONFIG.models.gemini);
    assert.ok(CONFIG.pricing.gemini);
    assert.ok(CONFIG.timeouts);
    assert.ok(CONFIG.rateLimits);
    assert.ok(CONFIG.cache);
  });
});