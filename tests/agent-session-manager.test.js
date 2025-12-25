/**
 * Tests for AgentSessionManager service
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import AgentSessionManager, {
  getAgentSessionManager,
  resetAgentSessionManager,
  SessionStatus,
} from '../src/services/agent-session-manager.js';

describe('AgentSessionManager', () => {
  let manager;

  beforeEach(() => {
    // Create a fresh instance for each test - disable auto cleanup to avoid timer issues
    manager = new AgentSessionManager({
      autoCleanup: false,
    });
  });

  afterEach(() => {
    if (manager) {
      manager.destroy();
      manager = null;
    }
  });

  describe('Constructor & Configuration', () => {
    it('should initialize with default configuration', () => {
      assert.strictEqual(manager.maxSessions, 50);
      assert.strictEqual(manager.sessions.size, 0);
    });

    it('should accept custom configuration', () => {
      const customManager = new AgentSessionManager({
        maxSessions: 10,
        expirationMs: 1000,
        autoCleanup: false,
      });
      assert.strictEqual(customManager.maxSessions, 10);
      assert.strictEqual(customManager.expirationMs, 1000);
      customManager.destroy();
    });

    it('should clear cleanup timer on destroy', () => {
      manager.destroy();
      assert.strictEqual(manager.sessions.size, 0);
    });
  });

  describe('createSession', () => {
    it('should create session with auto-generated ID', () => {
      const session = manager.createSession({
        taskDescription: 'Test task',
      });

      assert.ok(session.id);
      assert.strictEqual(typeof session.id, 'string');
      assert.strictEqual(session.status, SessionStatus.PENDING);
      assert.strictEqual(session.taskDescription, 'Test task');
      assert.strictEqual(manager.size, 1);
    });

    it('should set default values', () => {
      const session = manager.createSession({
        taskDescription: 'Test task',
      });

      assert.strictEqual(session.maxIterations, 20);
      assert.strictEqual(session.timeoutMs, 10 * 60 * 1000);
      assert.strictEqual(session.iterations, 0);
      assert.deepStrictEqual(session.toolCalls, []);
      assert.deepStrictEqual(session.filesCreated, []);
      assert.deepStrictEqual(session.filesModified, []);
      assert.deepStrictEqual(session.shellCommands, []);
    });

    it('should accept custom options', () => {
      const session = manager.createSession({
        taskDescription: 'Custom task',
        workingDirectory: '/test/dir',
        model: 'gemini-2.5-pro',
        maxIterations: 50,
        timeoutMinutes: 30,
      });

      assert.strictEqual(session.taskDescription, 'Custom task');
      assert.strictEqual(session.workingDirectory, '/test/dir');
      assert.strictEqual(session.model, 'gemini-2.5-pro');
      assert.strictEqual(session.maxIterations, 50);
      assert.strictEqual(session.timeoutMs, 30 * 60 * 1000);
    });

    it('should throw when max sessions reached', () => {
      const smallManager = new AgentSessionManager({
        maxSessions: 2,
        autoCleanup: false,
      });

      smallManager.createSession({ taskDescription: 'Task 1' });
      smallManager.createSession({ taskDescription: 'Task 2' });

      assert.throws(() => {
        smallManager.createSession({ taskDescription: 'Task 3' });
      }, /Maximum sessions/);

      smallManager.destroy();
    });
  });

  describe('getSession', () => {
    it('should retrieve existing session', () => {
      const created = manager.createSession({ taskDescription: 'Test' });
      const retrieved = manager.getSession(created.id);

      assert.strictEqual(retrieved.id, created.id);
      assert.strictEqual(retrieved.taskDescription, 'Test');
    });

    it('should return undefined for non-existent session', () => {
      const result = manager.getSession('non-existent-id');
      assert.strictEqual(result, undefined);
    });
  });

  describe('setGeminiSessionId', () => {
    it('should set Gemini session ID', () => {
      const session = manager.createSession({ taskDescription: 'Test' });
      assert.strictEqual(session.geminiSessionId, null);

      manager.setGeminiSessionId(session.id, 'gemini-abc-123');

      const updated = manager.getSession(session.id);
      assert.strictEqual(updated.geminiSessionId, 'gemini-abc-123');
    });

    it('should not throw for non-existent session', () => {
      // Should not throw, just do nothing
      manager.setGeminiSessionId('non-existent', 'gemini-id');
    });
  });

  describe('setStatus', () => {
    it('should update session status', () => {
      const session = manager.createSession({ taskDescription: 'Test' });
      assert.strictEqual(session.status, SessionStatus.PENDING);

      manager.setStatus(session.id, SessionStatus.RUNNING);

      const updated = manager.getSession(session.id);
      assert.strictEqual(updated.status, SessionStatus.RUNNING);
    });
  });

  describe('setResult and setError', () => {
    it('should set result and mark as completed', () => {
      const session = manager.createSession({ taskDescription: 'Test' });

      manager.setResult(session.id, 'Task completed successfully');

      const updated = manager.getSession(session.id);
      assert.strictEqual(updated.result, 'Task completed successfully');
      assert.strictEqual(updated.status, SessionStatus.COMPLETED);
    });

    it('should set error and mark as failed', () => {
      const session = manager.createSession({ taskDescription: 'Test' });

      manager.setError(session.id, 'Something went wrong');

      const updated = manager.getSession(session.id);
      assert.strictEqual(updated.error, 'Something went wrong');
      assert.strictEqual(updated.status, SessionStatus.FAILED);
    });
  });

  describe('recordToolCall', () => {
    it('should increment iterations', () => {
      const session = manager.createSession({ taskDescription: 'Test' });
      assert.strictEqual(session.iterations, 0);

      manager.recordToolCall(session.id, {
        tool: 'read_file',
        input: { path: '/test/file.js' },
      });

      assert.strictEqual(session.iterations, 1);

      manager.recordToolCall(session.id, {
        tool: 'read_file',
        input: { path: '/test/other.js' },
      });

      assert.strictEqual(session.iterations, 2);
    });

    it('should track file reads', () => {
      const session = manager.createSession({ taskDescription: 'Test' });

      manager.recordToolCall(session.id, {
        tool: 'read_file',
        input: { path: '/test/file.js' },
      });

      assert.deepStrictEqual(session.filesRead, ['/test/file.js']);
    });

    it('should track file writes', () => {
      const session = manager.createSession({ taskDescription: 'Test' });

      manager.recordToolCall(session.id, {
        tool: 'write_file',
        input: { path: '/test/new.js' },
      });

      assert.deepStrictEqual(session.filesCreated, ['/test/new.js']);
    });

    it('should track shell commands', () => {
      const session = manager.createSession({ taskDescription: 'Test' });

      manager.recordToolCall(session.id, {
        tool: 'run_shell_command',
        input: { command: 'npm test' },
      });

      assert.strictEqual(session.shellCommands.length, 1);
      assert.strictEqual(session.shellCommands[0].command, 'npm test');
    });

    it('should not duplicate file paths', () => {
      const session = manager.createSession({ taskDescription: 'Test' });

      manager.recordToolCall(session.id, {
        tool: 'read_file',
        input: { path: '/test/file.js' },
      });

      manager.recordToolCall(session.id, {
        tool: 'read_file',
        input: { path: '/test/file.js' },
      });

      assert.strictEqual(session.filesRead.length, 1);
    });
  });

  describe('checkLimits', () => {
    it('should return not exceeded for new session', () => {
      const session = manager.createSession({ taskDescription: 'Test' });
      const result = manager.checkLimits(session.id);

      assert.strictEqual(result.exceeded, false);
      assert.strictEqual(result.reason, undefined);
    });

    it('should detect iteration limit exceeded', () => {
      const session = manager.createSession({
        taskDescription: 'Test',
        maxIterations: 2,
      });

      manager.recordToolCall(session.id, { tool: 'test', input: {} });
      manager.recordToolCall(session.id, { tool: 'test', input: {} });

      const result = manager.checkLimits(session.id);

      assert.strictEqual(result.exceeded, true);
      assert.ok(result.reason.includes('Maximum iterations'));
    });

    it('should return exceeded for non-existent session', () => {
      const result = manager.checkLimits('non-existent');

      assert.strictEqual(result.exceeded, true);
      assert.strictEqual(result.reason, 'Session not found');
    });
  });

  describe('getSummary', () => {
    it('should return structured summary', () => {
      const session = manager.createSession({
        taskDescription: 'Test task',
      });

      manager.setGeminiSessionId(session.id, 'gemini-123');
      manager.recordToolCall(session.id, {
        tool: 'write_file',
        input: { path: '/test/new.js' },
      });

      const summary = manager.getSummary(session.id);

      assert.strictEqual(summary.id, session.id);
      assert.strictEqual(summary.geminiSessionId, 'gemini-123');
      assert.strictEqual(summary.iterations, 1);
      assert.deepStrictEqual(summary.files.created, ['/test/new.js']);
      assert.strictEqual(summary.resumeCommand, 'gemini --resume gemini-123');
    });

    it('should return null for non-existent session', () => {
      const result = manager.getSummary('non-existent');
      assert.strictEqual(result, null);
    });
  });

  describe('listSessions', () => {
    it('should list all sessions', () => {
      manager.createSession({ taskDescription: 'Task 1' });
      manager.createSession({ taskDescription: 'Task 2' });

      const sessions = manager.listSessions();

      assert.strictEqual(sessions.length, 2);
    });

    it('should filter by status', () => {
      const session1 = manager.createSession({ taskDescription: 'Task 1' });
      manager.createSession({ taskDescription: 'Task 2' });

      manager.setStatus(session1.id, SessionStatus.COMPLETED);

      const completed = manager.listSessions({ status: SessionStatus.COMPLETED });
      const pending = manager.listSessions({ status: SessionStatus.PENDING });

      assert.strictEqual(completed.length, 1);
      assert.strictEqual(pending.length, 1);
    });
  });

  describe('deleteSession', () => {
    it('should delete existing session', () => {
      const session = manager.createSession({ taskDescription: 'Test' });
      assert.strictEqual(manager.size, 1);

      const result = manager.deleteSession(session.id);

      assert.strictEqual(result, true);
      assert.strictEqual(manager.size, 0);
    });

    it('should return false for non-existent session', () => {
      const result = manager.deleteSession('non-existent');
      assert.strictEqual(result, false);
    });
  });

  describe('cleanup', () => {
    it('should remove expired sessions', async () => {
      const shortExpiryManager = new AgentSessionManager({
        expirationMs: 50,
        autoCleanup: false,
      });

      shortExpiryManager.createSession({ taskDescription: 'Test' });
      assert.strictEqual(shortExpiryManager.size, 1);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      shortExpiryManager.cleanup();
      assert.strictEqual(shortExpiryManager.size, 0);

      shortExpiryManager.destroy();
    });
  });

  describe('Singleton', () => {
    afterEach(() => {
      resetAgentSessionManager();
    });

    it('should return same instance', () => {
      const instance1 = getAgentSessionManager();
      const instance2 = getAgentSessionManager();

      assert.strictEqual(instance1, instance2);
    });

    it('should reset singleton', () => {
      const instance1 = getAgentSessionManager();
      instance1.createSession({ taskDescription: 'Test' });

      resetAgentSessionManager();

      const instance2 = getAgentSessionManager();
      assert.notStrictEqual(instance1, instance2);
      assert.strictEqual(instance2.size, 0);
    });
  });
});
