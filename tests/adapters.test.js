/**
 * Unit tests for CLI adapters
 * Run with: npm test
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import { BaseAdapter } from '../src/adapters/base.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { GeminiCliAdapter } from '../src/adapters/gemini-cli.js';

describe('BaseAdapter', () => {
  test('should throw on unimplemented methods', async () => {
    const adapter = new BaseAdapter();
    
    await assert.rejects(adapter.isAvailable(), /must be implemented/);
    assert.throws(() => adapter.getCheckCommand(), /must be implemented/);
    await assert.rejects(adapter.spawn('test'), /must be implemented/);
    await assert.rejects(async () => {
      for await (const chunk of adapter.send('test', 'msg')) {
        // Should throw
      }
    }, /must be implemented/);
    await assert.rejects(adapter.terminate('test'), /must be implemented/);
  });

  test('should track sessions', () => {
    const adapter = new BaseAdapter();
    adapter.sessions.set('test-1', { id: 'test-1', status: 'ready' });
    
    assert.strictEqual(adapter.getStatus('test-1').status, 'ready');
    assert.strictEqual(adapter.getStatus('nonexistent'), null);
    assert.strictEqual(adapter.listSessions().length, 1);
  });

  test('should return empty models by default', () => {
    const adapter = new BaseAdapter();
    assert.deepStrictEqual(adapter.getSupportedModels(), []);
    assert.strictEqual(adapter.getDefaultModel(), null);
  });

  test('should return 0 cost by default', () => {
    const adapter = new BaseAdapter();
    assert.strictEqual(adapter.estimateCost(1000, 1000), 0);
  });
});

describe('ClaudeCodeAdapter', () => {
  test('should have correct name', () => {
    const adapter = new ClaudeCodeAdapter();
    assert.strictEqual(adapter.name, 'claude-code');
  });

  test('should return correct check command', () => {
    const adapter = new ClaudeCodeAdapter();
    assert.strictEqual(adapter.getCheckCommand(), 'claude --version');
  });

  test('should return supported models', () => {
    const adapter = new ClaudeCodeAdapter();
    const models = adapter.getSupportedModels();
    
    assert.ok(models.includes('claude-sonnet-4-5-20250514'));
    assert.ok(models.includes('claude-opus-4-5-20250514'));
  });

  test('should return default model', () => {
    const adapter = new ClaudeCodeAdapter();
    assert.strictEqual(adapter.getDefaultModel(), 'claude-sonnet-4-5-20250514');
  });

  test('should estimate costs correctly', () => {
    const adapter = new ClaudeCodeAdapter();
    
    // 1M input tokens at $3, 1M output at $15 = $18
    const cost = adapter.estimateCost(1_000_000, 1_000_000);
    assert.strictEqual(cost, 18);
    
    // 1000 input at $3/1M, 1000 output at $15/1M = $0.018
    const smallCost = adapter.estimateCost(1000, 1000);
    assert.strictEqual(smallCost, 0.018);
  });

  test('should spawn session correctly', async () => {
    const adapter = new ClaudeCodeAdapter();
    const session = await adapter.spawn('test-session', {
      model: 'claude-sonnet-4-5-20250514',
      workDir: '/tmp',
    });
    
    assert.strictEqual(session.id, 'test-session');
    assert.strictEqual(session.model, 'claude-sonnet-4-5-20250514');
    assert.strictEqual(session.workDir, '/tmp');
    assert.strictEqual(session.status, 'ready');
  });
});

describe('GeminiCliAdapter', () => {
  test('should have correct name', () => {
    const adapter = new GeminiCliAdapter();
    assert.strictEqual(adapter.name, 'gemini-cli');
  });

  test('should return correct check command', () => {
    const adapter = new GeminiCliAdapter();
    assert.strictEqual(adapter.getCheckCommand(), 'gemini --version');
  });

  test('should detect auth method from environment', () => {
    // Save original env
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalVertexKey = process.env.VERTEX_API_KEY;

    // Clear env for default test
    delete process.env.GEMINI_API_KEY;
    delete process.env.VERTEX_API_KEY;

    // Test OAuth (default)
    const oauthAdapter = new GeminiCliAdapter();
    assert.strictEqual(oauthAdapter.auth.method, 'oauth');
    
    // Test API key detection
    process.env.GEMINI_API_KEY = 'test-key';
    const apiAdapter = new GeminiCliAdapter();
    assert.strictEqual(apiAdapter.auth.method, 'api-key');
    
    // Cleanup/Restore
    if (originalGeminiKey) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }

    if (originalVertexKey) {
      process.env.VERTEX_API_KEY = originalVertexKey;
    }
  });

  test('should return supported models based on auth', () => {
    const adapter = new GeminiCliAdapter({ authMethod: 'oauth' });
    const models = adapter.getSupportedModels();
    
    assert.ok(models.includes('gemini-2.5-flash'));
    assert.ok(models.includes('gemini-2.5-pro'));
  });

  test('should return default model based on auth', () => {
    const oauthAdapter = new GeminiCliAdapter({ authMethod: 'oauth' });
    assert.strictEqual(oauthAdapter.getDefaultModel(), 'gemini-2.5-pro');
    
    const vertexAdapter = new GeminiCliAdapter({ authMethod: 'vertex' });
    assert.strictEqual(vertexAdapter.getDefaultModel(), 'gemini-3-pro');
  });

  test('should estimate zero cost for OAuth', () => {
    const adapter = new GeminiCliAdapter({ authMethod: 'oauth' });
    assert.strictEqual(adapter.estimateCost(1_000_000, 1_000_000), 0);
  });

  test('should estimate cost for API key usage', () => {
    const adapter = new GeminiCliAdapter({ authMethod: 'api-key' });
    // gemini-2.5-pro: $1.25/1M input, $5.0/1M output
    const cost = adapter.estimateCost(1_000_000, 1_000_000, 'gemini-2.5-pro');
    assert.strictEqual(cost, 6.25);
  });

  test('should return auth info', () => {
    const adapter = new GeminiCliAdapter({ authMethod: 'oauth' });
    const info = adapter.getAuthInfo();
    
    assert.strictEqual(info.method, 'oauth');
    assert.strictEqual(info.isFree, true);
    assert.ok(info.note.includes('FREE'));
  });

  test('should build correct environment', () => {
    const adapter = new GeminiCliAdapter({
      authMethod: 'api-key',
      apiKey: 'test-api-key',
    });
    
    const env = adapter.buildEnv();
    assert.strictEqual(env.GEMINI_API_KEY, 'test-api-key');
  });

  test('should spawn session with auth info', async () => {
    const adapter = new GeminiCliAdapter({ authMethod: 'oauth' });
    
    // Mock checkAuth to avoid actual CLI call
    adapter.checkAuth = async () => ({
      authenticated: true,
      method: 'oauth',
      isProSubscription: true,
    });
    
    const session = await adapter.spawn('test-session', {
      model: 'gemini-2.5-pro',
    });
    
    assert.strictEqual(session.id, 'test-session');
    assert.strictEqual(session.auth.method, 'oauth');
    assert.strictEqual(session.auth.isFree, true);
  });
});
