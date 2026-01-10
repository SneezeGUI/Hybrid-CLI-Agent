/**
 * Tests for core tool handlers
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handlers } from '../src/mcp/tool-handlers/core/index.js';

const { gemini_auth_status, gemini_prompt, ask_gemini } = handlers;

describe('Core Tool Handlers', () => {
  let mockContext;
  let spawnCalls = [];
  let runCliCalls = [];

  beforeEach(() => {
    spawnCalls = [];
    runCliCalls = [];
    
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
      },

      // Mock CLI runner
      runGeminiCli: async (prompt, opts) => {
        runCliCalls.push({ prompt, opts });
        return `Response to: ${prompt}`;
      },

      // Mock file reference handling
      hasFileReferences: (text) => text.includes('@'),
      processPrompt: async (text) => {
        if (text.includes('@error')) {
          return {
            processed: text.replace('@error', ''),
            files: [],
            errors: ['File not found: error']
          };
        }
        return {
          processed: text.replace(/@\w+/g, '[FILE_CONTENT]'),
          files: text.match(/@\w+/g).map(f => ({ path: f.substring(1) })),
          errors: []
        };
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
      // Raw output is not currently included in the response text
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
      // Raw error details not included in response
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

  describe('gemini_prompt', () => {
    it('should send simple prompt to CLI', async () => {
      const result = await gemini_prompt({ prompt: 'hello' }, mockContext);
      
      assert.strictEqual(runCliCalls.length, 1);
      assert.strictEqual(runCliCalls[0].prompt, 'hello');
      assert.strictEqual(runCliCalls[0].opts.toolName, 'gemini_prompt');
      assert.strictEqual(runCliCalls[0].opts.model, null);
      assert.ok(result.content[0].text.includes('Response to: hello'));
    });

    it('should pass requested model', async () => {
      await gemini_prompt({ prompt: 'hi', model: 'gemini-1.5-pro' }, mockContext);
      
      assert.strictEqual(runCliCalls[0].opts.model, 'gemini-1.5-pro');
    });

    it('should process file references', async () => {
      const result = await gemini_prompt({ prompt: 'Check @file1' }, mockContext);
      
      assert.strictEqual(runCliCalls[0].prompt, 'Check [FILE_CONTENT]');
      assert.ok(result.content[0].text.includes('Processed 1 file(s): file1'));
    });

    it('should report file processing warnings', async () => {
      const result = await gemini_prompt({ prompt: 'Check @error' }, mockContext);
      
      assert.ok(result.content[0].text.includes('Warnings: File not found: error'));
    });

    it('should handle CLI errors', async () => {
      mockContext.runGeminiCli = async () => {
        throw new Error('CLI failed');
      };

      const result = await gemini_prompt({ prompt: 'test' }, mockContext);
      
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes('Gemini prompt failed: CLI failed'));
    });
  });

  describe('ask_gemini', () => {
    it('should send question to CLI', async () => {
      const result = await ask_gemini({ question: 'What is X?' }, mockContext);
      
      assert.strictEqual(runCliCalls.length, 1);
      assert.strictEqual(runCliCalls[0].prompt, 'What is X?');
      assert.strictEqual(runCliCalls[0].opts.toolName, 'ask_gemini');
      assert.ok(result.content[0].text.includes('Response to: What is X?'));
    });

    it('should process file references in question', async () => {
      await ask_gemini({ question: 'What is in @file?' }, mockContext);
      
      assert.strictEqual(runCliCalls[0].prompt, 'What is in [FILE_CONTENT]?');
    });

    it('should handle errors gracefully', async () => {
      mockContext.runGeminiCli = async () => {
        throw new Error('Network error');
      };

      const result = await ask_gemini({ question: 'test' }, mockContext);
      
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes('Ask Gemini failed: Network error'));
    });
  });
});
