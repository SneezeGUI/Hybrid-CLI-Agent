/**
 * Tests for token tracking and JSON output parsing
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Simulate the extractTokenStats function from gemini-mcp-server.js
function extractTokenStats(stats) {
  if (!stats || !stats.models) return { input: 0, output: 0 };

  // Get the first model's stats (typically only one model per request)
  const models = Object.values(stats.models);
  if (models.length === 0) return { input: 0, output: 0 };

  const modelStats = models[0];
  const tokens = modelStats.tokens || {};

  return {
    input: tokens.input || tokens.prompt || 0,
    output: tokens.candidates || tokens.output || 0,
  };
}

// Simulate the MODEL_PRICING from gemini-mcp-server.js
const MODEL_PRICING = {
  'gemini-2.5-flash': { input: 0.075, output: 0.30 },
  'gemini-2.5-pro': { input: 1.25, output: 5.0 },
  'gemini-3-pro': { input: 1.25, output: 5.0 },
};

// Simulate the tokenTracker from gemini-mcp-server.js
function createTokenTracker(getActiveAuthMethod = () => 'api-key') {
  return {
    totalInput: 0,
    totalOutput: 0,
    totalCost: 0,
    requestCount: 0,
    byModel: {},

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

    reset() {
      this.totalInput = 0;
      this.totalOutput = 0;
      this.totalCost = 0;
      this.requestCount = 0;
      this.byModel = {};
    },
  };
}

describe('extractTokenStats', () => {
  it('should extract tokens from Gemini JSON stats', () => {
    const stats = {
      models: {
        'gemini-2.5-flash': {
          tokens: {
            input: 1965,
            prompt: 1965,
            candidates: 57,
            total: 2166,
          },
        },
      },
    };

    const result = extractTokenStats(stats);
    assert.strictEqual(result.input, 1965);
    assert.strictEqual(result.output, 57);
  });

  it('should handle missing stats', () => {
    assert.deepStrictEqual(extractTokenStats(null), { input: 0, output: 0 });
    assert.deepStrictEqual(extractTokenStats(undefined), { input: 0, output: 0 });
    assert.deepStrictEqual(extractTokenStats({}), { input: 0, output: 0 });
  });

  it('should handle empty models object', () => {
    const stats = { models: {} };
    assert.deepStrictEqual(extractTokenStats(stats), { input: 0, output: 0 });
  });

  it('should handle missing tokens object', () => {
    const stats = { models: { 'gemini-2.5-flash': {} } };
    assert.deepStrictEqual(extractTokenStats(stats), { input: 0, output: 0 });
  });

  it('should prefer input over prompt', () => {
    const stats = {
      models: {
        'gemini-2.5-pro': {
          tokens: {
            input: 100,
            prompt: 200,
            candidates: 50,
          },
        },
      },
    };

    const result = extractTokenStats(stats);
    assert.strictEqual(result.input, 100);
  });
});

describe('tokenTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = createTokenTracker();
  });

  it('should start with zero values', () => {
    const stats = tracker.getStats();
    assert.strictEqual(stats.totalInput, 0);
    assert.strictEqual(stats.totalOutput, 0);
    assert.strictEqual(stats.totalCost, 0);
    assert.strictEqual(stats.requestCount, 0);
  });

  it('should record token usage', () => {
    tracker.record('gemini-2.5-flash', 1000, 500);

    const stats = tracker.getStats();
    assert.strictEqual(stats.totalInput, 1000);
    assert.strictEqual(stats.totalOutput, 500);
    assert.strictEqual(stats.totalTokens, 1500);
    assert.strictEqual(stats.requestCount, 1);
  });

  it('should accumulate across multiple requests', () => {
    tracker.record('gemini-2.5-flash', 1000, 500);
    tracker.record('gemini-2.5-pro', 2000, 1000);

    const stats = tracker.getStats();
    assert.strictEqual(stats.totalInput, 3000);
    assert.strictEqual(stats.totalOutput, 1500);
    assert.strictEqual(stats.requestCount, 2);
  });

  it('should track per-model stats', () => {
    tracker.record('gemini-2.5-flash', 1000, 500);
    tracker.record('gemini-2.5-flash', 500, 250);
    tracker.record('gemini-2.5-pro', 2000, 1000);

    const stats = tracker.getStats();
    assert.strictEqual(stats.byModel['gemini-2.5-flash'].input, 1500);
    assert.strictEqual(stats.byModel['gemini-2.5-flash'].output, 750);
    assert.strictEqual(stats.byModel['gemini-2.5-flash'].requests, 2);
    assert.strictEqual(stats.byModel['gemini-2.5-pro'].input, 2000);
    assert.strictEqual(stats.byModel['gemini-2.5-pro'].requests, 1);
  });

  it('should calculate cost for API key users', () => {
    tracker.record('gemini-2.5-flash', 1_000_000, 1_000_000);

    const stats = tracker.getStats();
    // Flash: $0.075/1M input + $0.30/1M output = $0.375
    assert.strictEqual(stats.totalCost.toFixed(3), '0.375');
    assert.strictEqual(stats.isFree, false);
  });

  it('should report zero cost for OAuth users', () => {
    const oauthTracker = createTokenTracker(() => 'oauth');
    oauthTracker.record('gemini-2.5-flash', 1_000_000, 1_000_000);

    const stats = oauthTracker.getStats();
    assert.strictEqual(stats.totalCost, 0);
    assert.strictEqual(stats.isFree, true);
    assert.strictEqual(stats.costNote, 'FREE (OAuth/Pro subscription)');
  });

  it('should reset all values', () => {
    tracker.record('gemini-2.5-flash', 1000, 500);
    tracker.reset();

    const stats = tracker.getStats();
    assert.strictEqual(stats.totalInput, 0);
    assert.strictEqual(stats.totalOutput, 0);
    assert.strictEqual(stats.requestCount, 0);
    assert.deepStrictEqual(stats.byModel, {});
  });

  it('should handle unknown models with default pricing', () => {
    tracker.record('unknown-model', 1_000_000, 1_000_000);

    const stats = tracker.getStats();
    // Should use gemini-2.5-pro pricing as fallback: $1.25/1M input + $5.0/1M output = $6.25
    assert.strictEqual(stats.totalCost.toFixed(2), '6.25');
  });
});

describe('JSON response parsing', () => {
  it('should parse valid Gemini JSON response', () => {
    const jsonResponse = JSON.stringify({
      session_id: 'abc-123',
      response: 'This is the clean response text.',
      stats: {
        models: {
          'gemini-2.5-flash': {
            tokens: {
              input: 1965,
              prompt: 1965,
              candidates: 57,
              total: 2166,
            },
          },
        },
      },
    });

    const parsed = JSON.parse(jsonResponse);
    assert.strictEqual(parsed.response, 'This is the clean response text.');
    assert.strictEqual(parsed.session_id, 'abc-123');

    const tokens = extractTokenStats(parsed.stats);
    assert.strictEqual(tokens.input, 1965);
    assert.strictEqual(tokens.output, 57);
  });

  it('should handle response without stats', () => {
    const jsonResponse = JSON.stringify({
      response: 'Response without stats',
    });

    const parsed = JSON.parse(jsonResponse);
    assert.strictEqual(parsed.response, 'Response without stats');

    const tokens = extractTokenStats(parsed.stats);
    assert.strictEqual(tokens.input, 0);
    assert.strictEqual(tokens.output, 0);
  });

  it('should handle malformed JSON gracefully', () => {
    const badJson = 'not valid json at all';

    let response = badJson;
    let tokens = { input: 0, output: 0 };

    try {
      const parsed = JSON.parse(badJson);
      response = parsed.response || badJson;
      tokens = extractTokenStats(parsed.stats);
    } catch (e) {
      // Fallback to raw text - expected behavior
    }

    assert.strictEqual(response, badJson);
    assert.strictEqual(tokens.input, 0);
    assert.strictEqual(tokens.output, 0);
  });
});
