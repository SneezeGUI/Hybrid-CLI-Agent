/**
 * Tests for core tool handlers
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handlers } from '../src/mcp/tool-handlers/core/index.js';

const { gemini_auth_status } = handlers;

describe('Core Tool Handlers', () => {
  let mockContext;
  let spawnCalls = [];

  beforeEach(() => {
    spawnCalls = [];

    // Default mock context
    mockContext = {
      // Mock process handling for auth check
      spawn: 'mock-spawn',
      buildEnv: () => ({ MOCK_ENV: 'true' }),
      safeSpawn: (spawn, cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        const stdoutListeners = [];
        const stderrListeners = [];
        const closeListeners = [];
        const errorListeners = [];

        return {
          stdout: {
            on: (evt, cb) => { if (evt === 'data') stdoutListeners.push(cb); }
          },
          stderr: {
            on: (evt, cb) => { if (evt === 'data') stderrListeners.push(cb); }
          },
          on: (evt, cb) => {
            if (evt === 'close') closeListeners.push(cb);
            if (evt === 'error') errorListeners.push(cb);
          },
          // Helper to simulate process execution for tests
          emitClose: (code) => closeListeners.forEach(cb => cb(code)),
          emitError: (err) => errorListeners.forEach(cb => cb(err)),
          emitStdout: (data) => stdoutListeners.forEach(cb => cb(data)),
          emitStderr: (data) => stderrListeners.forEach(cb => cb(data))
        };
      },

      // Mock auth config
      getActiveAuthMethod: () => 'oauth',
      getDefaultModel: () => 'gemini-2.5-flash',
      AUTH_CONFIG: {
        method: 'oauth',
        fallbackChain: [
          { method: 'oauth', name: 'Google OAuth' },
          { method: 'api-key', name: 'API Key' }
        ],
        authFailures: {}
      }
    };
  });

  describe('gemini_auth_status', () => {
    it('should report authenticated status when CLI returns 0', async () => {
      // Override safeSpawn to auto-complete
      const originalSafeSpawn = mockContext.safeSpawn;
      mockContext.safeSpawn = (...args) => {
        const proc = originalSafeSpawn(...args);
        setTimeout(() => {
          proc.emitStdout('Authenticated as user@example.com');
          proc.emitClose(0);
        }, 10);
        return proc;
      };

      const result = await gemini_auth_status({}, mockContext);

      assert.strictEqual(result.isError, undefined);
      const text = result.content[0].text;
      assert.ok(text.includes('Active Method: oauth'));
      assert.ok(text.includes('OAuth Status: Authenticated'));
      assert.ok(text.includes('>>> 1. Google OAuth (active)'));
    });

    it('should report unauthenticated status when CLI returns non-zero', async () => {
      const originalSafeSpawn = mockContext.safeSpawn;
      mockContext.safeSpawn = (...args) => {
        const proc = originalSafeSpawn(...args);
        setTimeout(() => {
          proc.emitStderr('Login required');
          proc.emitClose(1);
        }, 10);
        return proc;
      };

      const result = await gemini_auth_status({}, mockContext);

      const text = result.content[0].text;
      assert.ok(text.includes('OAuth Status: Not authenticated'));
      assert.ok(text.includes('Tips:'));
      assert.ok(text.includes('Run "gemini auth login"'));
    });

    it('should handle process error', async () => {
      const originalSafeSpawn = mockContext.safeSpawn;
      mockContext.safeSpawn = (...args) => {
        const proc = originalSafeSpawn(...args);
        setTimeout(() => {
          proc.emitError(new Error('Spawn failed'));
        }, 10);
        return proc;
      };

      const result = await gemini_auth_status({}, mockContext);

      const text = result.content[0].text;
      assert.ok(text.includes('Not authenticated'));
    });

    it('should show correct tips for API key method', async () => {
      // Update context for API key
      mockContext.getActiveAuthMethod = () => 'api-key';
      mockContext.AUTH_CONFIG.method = 'api-key';

      const originalSafeSpawn = mockContext.safeSpawn;
      mockContext.safeSpawn = (...args) => {
        const proc = originalSafeSpawn(...args);
        setTimeout(() => proc.emitClose(0), 10);
        return proc;
      };

      const result = await gemini_auth_status({}, mockContext);

      const text = result.content[0].text;
      assert.ok(text.includes('Active Method: api-key'));
      assert.ok(text.includes('Using API key - consider OAuth'));
      assert.ok(text.includes('No (billed per token)'));
    });

    it('should mark failed methods in chain', async () => {
      mockContext.AUTH_CONFIG.authFailures = { 'oauth': 'Error' };
      mockContext.getActiveAuthMethod = () => 'api-key';

      const originalSafeSpawn = mockContext.safeSpawn;
      mockContext.safeSpawn = (...args) => {
        const proc = originalSafeSpawn(...args);
        setTimeout(() => proc.emitClose(0), 10);
        return proc;
      };

      const result = await gemini_auth_status({}, mockContext);

      const text = result.content[0].text;
      assert.ok(text.includes('[X] 1. Google OAuth (failed)'));
      assert.ok(text.includes('>>> 2. API Key (active)'));
      assert.ok(text.includes('Failed auth methods will be retried'));
    });
  });
});
