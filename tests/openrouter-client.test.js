/**
 * Tests for OpenRouterClient service
 */

import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert';
import OpenRouterClient from '../src/services/openrouter-client.js';

describe('OpenRouterClient', () => {
  let originalEnv;
  let originalFetch;

  before(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;
  });

  after(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_DEFAULT_MODEL;
    delete process.env.OPENROUTER_COST_LIMIT_PER_DAY;
  });

  afterEach(() => {
    // Restore fetch if mocked
    global.fetch = originalFetch;
  });

  describe('Constructor & Configuration', () => {
    it('should initialize with default values when no config provided', () => {
      const client = new OpenRouterClient();
      
      assert.strictEqual(client.apiKey, undefined);
      assert.strictEqual(client.baseUrl, 'https://openrouter.ai/api/v1');
      assert.strictEqual(client.defaultModel, 'openai/gpt-4.1-nano');
      assert.strictEqual(client.costLimitPerDay, 10.0);
      
      // Check initial usage state
      assert.deepStrictEqual(client.usage, {
        totalCost: 0,
        requests: 0,
        tokensByModel: {},
      });
    });

    it('should initialize with provided configuration', () => {
      const config = {
        apiKey: 'sk-test-key',
        baseUrl: 'https://custom.api',
        defaultModel: 'anthropic/claude-3-opus'
      };
      const client = new OpenRouterClient(config);

      assert.strictEqual(client.apiKey, 'sk-test-key');
      assert.strictEqual(client.baseUrl, 'https://custom.api');
      assert.strictEqual(client.defaultModel, 'anthropic/claude-3-opus');
    });

    it('should load configuration from environment variables', () => {
      process.env.OPENROUTER_API_KEY = 'env-key';
      process.env.OPENROUTER_DEFAULT_MODEL = 'env-model';
      process.env.OPENROUTER_COST_LIMIT_PER_DAY = '5.5';

      const client = new OpenRouterClient();

      assert.strictEqual(client.apiKey, 'env-key');
      assert.strictEqual(client.defaultModel, 'env-model');
      assert.strictEqual(client.costLimitPerDay, 5.5);
    });

    it('isConfigured() should return correct status', () => {
      const unconfiguredClient = new OpenRouterClient();
      assert.strictEqual(unconfiguredClient.isConfigured(), false);

      const configuredClient = new OpenRouterClient({ apiKey: 'sk-key' });
      assert.strictEqual(configuredClient.isConfigured(), true);
    });
  });

  describe('Usage Tracking & Cost', () => {
    it('trackUsage should increment request count and token stats', () => {
      const client = new OpenRouterClient({ apiKey: 'test' });
      const model = 'test-model';
      const usage1 = { prompt_tokens: 10, completion_tokens: 20 };
      const usage2 = { prompt_tokens: 5, completion_tokens: 5 };

      // First request
      client.trackUsage(model, usage1);
      assert.strictEqual(client.usage.requests, 1);
      assert.deepStrictEqual(client.usage.tokensByModel[model], { input: 10, output: 20 });

      // Second request
      client.trackUsage(model, usage2);
      assert.strictEqual(client.usage.requests, 2);
      assert.deepStrictEqual(client.usage.tokensByModel[model], { input: 15, output: 25 });
    });

    it('trackUsage should handle separate models independently', () => {
      const client = new OpenRouterClient({ apiKey: 'test' });
      
      client.trackUsage('model-a', { prompt_tokens: 10, completion_tokens: 10 });
      client.trackUsage('model-b', { prompt_tokens: 20, completion_tokens: 20 });

      assert.strictEqual(client.usage.requests, 2);
      assert.strictEqual(client.usage.tokensByModel['model-a'].input, 10);
      assert.strictEqual(client.usage.tokensByModel['model-b'].input, 20);
    });

    it('getUsageStats should return comprehensive statistics', () => {
      const client = new OpenRouterClient({ apiKey: 'test' });
      process.env.OPENROUTER_COST_LIMIT_PER_DAY = '100';
      // Reset limit from env
      client.costLimitPerDay = 100;

      // Manually set usage for predictability (bypassing estimateCost model lookup issues)
      client.usage.totalCost = 10.50;
      client.usage.requests = 5;

      const stats = client.getUsageStats();

      assert.strictEqual(stats.totalCost, 10.50);
      assert.strictEqual(stats.requests, 5);
      assert.strictEqual(stats.costLimitPerDay, 100);
      assert.strictEqual(stats.remainingBudget, 89.50);
    });

    it('estimateCost should return 0 for unknown models', () => {
      const client = new OpenRouterClient();
      const cost = client.estimateCost('unknown-model-xyz', 1000, 1000);
      assert.strictEqual(cost, 0);
    });
  });

  describe('Input Validation & Chat Safety', () => {
    it('chat() should throw immediately if not configured', async () => {
      const client = new OpenRouterClient(); // No API key
      
      await assert.rejects(
        async () => await client.chat({ prompt: 'hello' }),
        /OpenRouter API key not configured/
      );
    });

    it('crossModelComparison() should propagate unconfigured error', async () => {
      const client = new OpenRouterClient(); // No API key
      
      // Since crossModelComparison uses Promise.allSettled, it catches errors internally
      // and returns objects with error properties
      const results = await client.crossModelComparison('hello', ['model-a']);
      
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].model, 'model-a');
      assert.ok(results[0].error.includes('OpenRouter API key not configured'));
    });
  });

  describe('Model Management', () => {
    it('getAvailableModels should return a list of keys', () => {
      const client = new OpenRouterClient();
      const models = client.getAvailableModels();
      assert.ok(Array.isArray(models));
      // We assume at least the default model exists in the config
      assert.ok(models.length > 0); 
    });

    it('getModelInfo should return null for unknown model', () => {
      const client = new OpenRouterClient();
      const info = client.getModelInfo('fake-model-123');
      assert.strictEqual(info, null);
    });
  });

  describe('Network Mocking (Integration Logic)', () => {
    it('chat() should use default model if none specified', async () => {
      const client = new OpenRouterClient({ apiKey: 'sk-test', defaultModel: 'default-gpt' });
      
      // Mock successful fetch
      global.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        assert.strictEqual(body.model, 'default-gpt'); // Verify default model was used
        
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'Response' } }],
            model: 'default-gpt',
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          })
        };
      };

      await client.chat({ prompt: 'test' });
    });

    it('chat() should construct correct request headers and body', async () => {
      const client = new OpenRouterClient({ apiKey: 'sk-test' });
      let capturedOptions;

      global.fetch = async (url, options) => {
        capturedOptions = options;
        return {
          ok: true,
          json: async () => ({ choices: [], usage: {} })
        };
      };

      await client.chat({
        prompt: 'Hello',
        model: 'test-model',
        temperature: 0.5,
        maxTokens: 100
      });

      assert.strictEqual(capturedOptions.method, 'POST');
      assert.strictEqual(capturedOptions.headers['Authorization'], 'Bearer sk-test');
      assert.strictEqual(capturedOptions.headers['HTTP-Referer'], 'https://github.com/hybrid-cli-agent');
      
      const body = JSON.parse(capturedOptions.body);
      assert.strictEqual(body.model, 'test-model');
      assert.strictEqual(body.temperature, 0.5);
      assert.strictEqual(body.max_tokens, 100);
      assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
    });

    it('chat() should handle API errors gracefully', async () => {
      const client = new OpenRouterClient({ apiKey: 'sk-test' });

      global.fetch = async () => ({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      });

      await assert.rejects(
        async () => await client.chat({ prompt: 'test' }),
        /OpenRouter API error: 401 - Unauthorized/
      );
    });
  });
});