/**
 * Tests for gemini_agent_task handler
 *
 * Note: These tests mock the Gemini CLI execution to avoid actual API calls.
 * Integration tests with real CLI would require GEMINI_AGENT_MODE=true.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

import { handlers } from '../src/mcp/tool-handlers/agent/index.js';
import {
  getAgentSessionManager,
  resetAgentSessionManager,
} from '../src/services/agent-session-manager.js';

describe('gemini_agent_task handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetAgentSessionManager();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetAgentSessionManager();
  });

  describe('Environment gate', () => {
    it('should reject when GEMINI_AGENT_MODE is not set', async () => {
      delete process.env.GEMINI_AGENT_MODE;

      const result = await handlers.gemini_agent_task(
        { task_description: 'Test task' },
        {}
      );

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Agent mode is disabled'));
    });

    it('should reject when GEMINI_AGENT_MODE is false', async () => {
      process.env.GEMINI_AGENT_MODE = 'false';

      const result = await handlers.gemini_agent_task(
        { task_description: 'Test task' },
        {}
      );

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Agent mode is disabled'));
    });
  });

  describe('Argument validation', () => {
    it('should require task_description', async () => {
      process.env.GEMINI_AGENT_MODE = 'true';

      const result = await handlers.gemini_agent_task({}, {});

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('task_description'));
    });
  });

  describe('Session management', () => {
    it('should reject resume with non-existent session', async () => {
      process.env.GEMINI_AGENT_MODE = 'true';

      const result = await handlers.gemini_agent_task(
        {
          task_description: 'Test task',
          session_id: 'non-existent-session-id',
        },
        {}
      );

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Session not found'));
    });

    it('should reject resume when session has no Gemini ID', async () => {
      process.env.GEMINI_AGENT_MODE = 'true';

      // Create a session without Gemini session ID
      const sessionManager = getAgentSessionManager();
      const session = sessionManager.createSession({
        taskDescription: 'Original task',
      });

      const result = await handlers.gemini_agent_task(
        {
          task_description: 'Continue task',
          session_id: session.id,
        },
        {}
      );

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('no Gemini session ID'));
    });
  });
});

describe('gemini_agent_list handler', () => {
  beforeEach(() => {
    resetAgentSessionManager();
  });

  afterEach(() => {
    resetAgentSessionManager();
  });

  it('should return empty message when no sessions', async () => {
    const result = await handlers.gemini_agent_list({});

    assert.ok(result.content[0].text.includes('No agent sessions found'));
  });

  it('should list existing sessions', async () => {
    const sessionManager = getAgentSessionManager();
    sessionManager.createSession({ taskDescription: 'Task 1' });
    sessionManager.createSession({ taskDescription: 'Task 2' });

    const result = await handlers.gemini_agent_list({});

    assert.ok(result.content[0].text.includes('Agent Sessions'));
    assert.ok(result.content[0].text.includes('Session:'));
  });

  it('should filter by status', async () => {
    const sessionManager = getAgentSessionManager();
    const session1 = sessionManager.createSession({ taskDescription: 'Task 1' });
    sessionManager.createSession({ taskDescription: 'Task 2' });
    sessionManager.setStatus(session1.id, 'completed');

    const completedResult = await handlers.gemini_agent_list({ status: 'completed' });
    const pendingResult = await handlers.gemini_agent_list({ status: 'pending' });

    // Count sessions in output (look for "Session:" occurrences)
    const completedCount = (completedResult.content[0].text.match(/Session:/g) || []).length;
    const pendingCount = (pendingResult.content[0].text.match(/Session:/g) || []).length;

    assert.strictEqual(completedCount, 1);
    assert.strictEqual(pendingCount, 1);
  });
});

describe('gemini_agent_clear handler', () => {
  beforeEach(() => {
    resetAgentSessionManager();
  });

  afterEach(() => {
    resetAgentSessionManager();
  });

  it('should require session_id', async () => {
    const result = await handlers.gemini_agent_clear({});

    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('session_id'));
  });

  it('should delete existing session', async () => {
    const sessionManager = getAgentSessionManager();
    const session = sessionManager.createSession({ taskDescription: 'Test' });

    const result = await handlers.gemini_agent_clear({ session_id: session.id });

    assert.ok(result.content[0].text.includes('deleted'));
    assert.strictEqual(sessionManager.size, 0);
  });

  it('should return error for non-existent session', async () => {
    const result = await handlers.gemini_agent_clear({ session_id: 'non-existent' });

    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('not found'));
  });
});
