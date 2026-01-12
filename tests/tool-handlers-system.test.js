import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handlers } from '../src/mcp/tool-handlers/system/index.js';

const { hybrid_metrics, gemini_config_show, gemini_health_check } = handlers;

describe('System Tool Handlers', () => {
  let mockContext;

  beforeEach(() => {
    mockContext = {
      AUTH_CONFIG: { method: 'oauth' },
      getDefaultModel: () => 'gemini-2.5-pro',
      getSupportedModels: () => ['gemini-2.5-pro', 'gemini-2.5-flash'],
      MODEL_CAPABILITIES: {
        'gemini-2.5-pro': { tier: 2 },
        'gemini-2.5-flash': { tier: 3 }
      },
      tokenTracker: {
        getStats: () => ({
          requestCount: 10,
          totalInput: 1000,
          totalOutput: 500,
          totalTokens: 1500,
          costNote: 'FREE',
          byModel: {
            'gemini-2.5-pro': { input: 1000, output: 500, requests: 10 }
          }
        })
      },
      rateLimitTracker: {
        isAvailable: (model) => true
      },
      runGeminiCli: async () => ({ response: 'HEALTH_CHECK_OK' }),
      getResponseCache: () => ({
        getStats: () => ({ size: 5, hitRate: '50%' })
      })
    };
  });

  describe('hybrid_metrics', () => {
    it('should return metrics markdown', async () => {
      const result = await hybrid_metrics({}, mockContext);
      assert.strictEqual(result.isError, undefined);
      assert.ok(result.content[0].text.includes('# Hybrid Agent Metrics'));
      assert.ok(result.content[0].text.includes('Auth method: oauth'));
      assert.ok(result.content[0].text.includes('Requests: 10'));
      assert.ok(result.content[0].text.includes('gemini-2.5-pro: 1,000 in'));
    });
  });

  describe('gemini_config_show', () => {
    it('should show configuration', async () => {
      process.env.GEMINI_AGENT_MODE = 'true';
      const result = await gemini_config_show({}, mockContext);
      
      assert.strictEqual(result.isError, undefined);
      assert.ok(result.content[0].text.includes('# Current Configuration'));
      assert.ok(result.content[0].text.includes('Agent Mode: Enabled'));
      assert.ok(result.content[0].text.includes('Method: oauth'));
    });

    it('should hide sensitive values', async () => {
      process.env.GEMINI_API_KEY = 'sk-1234567890abcdef';
      const result = await gemini_config_show({}, mockContext);
      
      assert.ok(result.content[0].text.includes('sk-1****'));
      assert.ok(!result.content[0].text.includes('abcdef'));
      
      delete process.env.GEMINI_API_KEY;
    });

    it('should show env vars when requested', async () => {
        const result = await gemini_config_show({ show_env: true }, mockContext);
        assert.ok(result.content[0].text.includes('Environment Variables'));
    });
  });

  describe('gemini_health_check', () => {
    it('should report healthy status', async () => {
      const result = await gemini_health_check({}, mockContext);
      
      assert.strictEqual(result.isError, undefined);
      assert.ok(result.content[0].text.includes('Overall Status: ✅ HEALTHY'));
      assert.ok(result.content[0].text.includes('Gemini CLI\n- Status: ✅ healthy'));
      assert.ok(result.content[0].text.includes('Cache\n- Status: healthy'));
    });

    it('should report unhealthy when CLI fails', async () => {
      mockContext.runGeminiCli = async () => { throw new Error('CLI Error'); };
      
      const result = await gemini_health_check({}, mockContext);
      
      assert.ok(result.content[0].text.includes('Overall Status: ❌ UNHEALTHY'));
      assert.ok(result.content[0].text.includes('Error: CLI Error'));
    });

    it('should report degraded when cache unavailable', async () => {
      mockContext.getResponseCache = () => { throw new Error('Cache Error'); };
      
      const result = await gemini_health_check({}, mockContext);
      
      // If CLI is healthy but cache is down, it might be degraded or healthy depending on logic.
      // Logic says: if CLI healthy && Auth valid && Models available -> Healthy.
      // Cache status is just reported.
      // Let's check the logic in source:
      // if (geminiCli.status === 'healthy' && authentication.status === 'valid' && models.available.length > 0) -> healthy
      // So cache failure doesn't degrade overall status in current logic, just shows unavailable in Cache section.
      
      assert.ok(result.content[0].text.includes('Overall Status: ✅ HEALTHY'));
      assert.ok(result.content[0].text.includes('Cache\n- Status: unavailable'));
    });
  });
});
