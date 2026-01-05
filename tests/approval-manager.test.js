import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  ApprovalManager,
  ApprovalStatus,
  DEFAULT_APPROVAL_TOOLS,
  getApprovalManager,
  resetApprovalManager,
} from '../src/services/approval-manager.js';

describe('ApprovalManager', () => {
  let manager;

  beforeEach(() => {
    manager = new ApprovalManager({ enabled: true, defaultTimeoutMs: 1000 });
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('constructor', () => {
    it('should use default values when no options provided', () => {
      const defaultManager = new ApprovalManager();
      const stats = defaultManager.getStats();
      assert.strictEqual(stats.defaultTimeoutMs, 300000);
      assert.ok(stats.requiredTools.includes('delete_file'));
      defaultManager.destroy();
    });

    it('should use provided options', () => {
      const stats = manager.getStats();
      assert.strictEqual(stats.enabled, true);
      assert.strictEqual(stats.defaultTimeoutMs, 1000);
    });
  });

  describe('requiresApproval', () => {
    it('should return true for dangerous tools when enabled', () => {
      assert.ok(manager.requiresApproval('delete_file'));
      assert.ok(manager.requiresApproval('run_shell_command'));
    });

    it('should return false for safe tools', () => {
      assert.ok(!manager.requiresApproval('read_file'));
      assert.ok(!manager.requiresApproval('list_directory'));
    });

    it('should return false when disabled', () => {
      const disabledManager = new ApprovalManager({ enabled: false });
      assert.ok(!disabledManager.requiresApproval('delete_file'));
      disabledManager.destroy();
    });
  });

  describe('requestApproval', () => {
    it('should create pending request and emit event', async () => {
      let emittedEvent = null;
      manager.on('approval:required', (e) => { emittedEvent = e; });

      const promise = manager.requestApproval({
        sessionId: 'session-1',
        tool: 'delete_file',
        input: { path: '/test.txt' },
      });

      assert.ok(emittedEvent);
      assert.strictEqual(emittedEvent.tool, 'delete_file');
      assert.strictEqual(emittedEvent.sessionId, 'session-1');

      // Approve to resolve promise
      manager.approve(emittedEvent.requestId);
      await promise;
    });

    it('should timeout if not approved', async () => {
      const promise = manager.requestApproval({
        sessionId: 'session-1',
        tool: 'delete_file',
        input: {},
        timeoutMs: 50,
      });

      await assert.rejects(promise, /timed out/);
    });
  });

  describe('approve', () => {
    it('should approve pending request', async () => {
      let requestId;
      manager.on('approval:required', (e) => { requestId = e.requestId; });

      const promise = manager.requestApproval({
        sessionId: 'session-1',
        tool: 'delete_file',
        input: {},
      });

      const approved = manager.approve(requestId, { approvedBy: 'test-user' });
      assert.ok(approved);

      const result = await promise;
      assert.strictEqual(result.status, ApprovalStatus.APPROVED);
      assert.strictEqual(result.approvedBy, 'test-user');
    });

    it('should emit approval:resolved event', async () => {
      let resolvedEvent = null;
      manager.on('approval:resolved', (e) => { resolvedEvent = e; });

      let requestId;
      manager.on('approval:required', (e) => { requestId = e.requestId; });

      const promise = manager.requestApproval({
        sessionId: 'session-1',
        tool: 'delete_file',
        input: {},
      });

      manager.approve(requestId);
      await promise;

      assert.ok(resolvedEvent);
      assert.strictEqual(resolvedEvent.status, ApprovalStatus.APPROVED);
    });

    it('should return false for non-existent request', () => {
      const approved = manager.approve('non-existent-id');
      assert.ok(!approved);
    });
  });

  describe('deny', () => {
    it('should deny pending request', async () => {
      let requestId;
      manager.on('approval:required', (e) => { requestId = e.requestId; });

      const promise = manager.requestApproval({
        sessionId: 'session-1',
        tool: 'delete_file',
        input: {},
      });

      const denied = manager.deny(requestId, { reason: 'Too dangerous' });
      assert.ok(denied);

      await assert.rejects(promise, /Too dangerous/);
    });

    it('should emit approval:resolved event with denial', async () => {
      let resolvedEvent = null;
      manager.on('approval:resolved', (e) => { resolvedEvent = e; });

      let requestId;
      manager.on('approval:required', (e) => { requestId = e.requestId; });

      const promise = manager.requestApproval({
        sessionId: 'session-1',
        tool: 'delete_file',
        input: {},
      });

      manager.deny(requestId, { reason: 'Not allowed' });

      try { await promise; } catch {}

      assert.ok(resolvedEvent);
      assert.strictEqual(resolvedEvent.status, ApprovalStatus.DENIED);
      assert.strictEqual(resolvedEvent.reason, 'Not allowed');
    });
  });

  describe('getRequest', () => {
    it('should return request details', async () => {
      let requestId;
      manager.on('approval:required', (e) => { requestId = e.requestId; });

      const promise = manager.requestApproval({
        sessionId: 'session-1',
        tool: 'delete_file',
        input: { path: '/test.txt' },
      });

      const request = manager.getRequest(requestId);
      assert.ok(request);
      assert.strictEqual(request.tool, 'delete_file');
      assert.strictEqual(request.sessionId, 'session-1');
      assert.deepStrictEqual(request.input, { path: '/test.txt' });

      // Clean up - await the rejection
      manager.deny(requestId);
      await assert.rejects(promise, /Denied/);
    });

    it('should return null for non-existent request', () => {
      const request = manager.getRequest('non-existent');
      assert.strictEqual(request, null);
    });
  });

  describe('listPending', () => {
    it('should list pending requests', async () => {
      const promises = [
        manager.requestApproval({ sessionId: 'session-1', tool: 'delete_file', input: {} }),
        manager.requestApproval({ sessionId: 'session-2', tool: 'shell', input: {} }),
      ];

      const pending = manager.listPending();
      assert.strictEqual(pending.length, 2);

      // Clean up - await rejections
      manager.denyAll('session-1');
      manager.denyAll('session-2');
      for (const promise of promises) {
        await assert.rejects(promise, /Denied/);
      }
    });

    it('should filter by session', async () => {
      const promises = [
        manager.requestApproval({ sessionId: 'session-1', tool: 'delete_file', input: {} }),
        manager.requestApproval({ sessionId: 'session-2', tool: 'shell', input: {} }),
      ];

      const pending = manager.listPending({ sessionId: 'session-1' });
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].sessionId, 'session-1');

      // Clean up - await rejections
      manager.denyAll('session-1');
      manager.denyAll('session-2');
      for (const promise of promises) {
        await assert.rejects(promise, /Denied/);
      }
    });
  });

  describe('approveAll', () => {
    it('should approve all pending requests for session', async () => {
      const promises = [
        manager.requestApproval({ sessionId: 'session-1', tool: 'delete_file', input: {} }),
        manager.requestApproval({ sessionId: 'session-1', tool: 'shell', input: {} }),
      ];

      const count = manager.approveAll('session-1');
      assert.strictEqual(count, 2);

      await Promise.all(promises);
    });
  });

  describe('denyAll', () => {
    it('should deny all pending requests for session', async () => {
      const promises = [
        manager.requestApproval({ sessionId: 'session-1', tool: 'delete_file', input: {} }),
        manager.requestApproval({ sessionId: 'session-1', tool: 'shell', input: {} }),
      ];

      const count = manager.denyAll('session-1', { reason: 'Session cancelled' });
      assert.strictEqual(count, 2);

      for (const promise of promises) {
        await assert.rejects(promise, /Session cancelled/);
      }
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      const promises = [
        manager.requestApproval({ sessionId: 'session-1', tool: 'delete_file', input: {} }),
        manager.requestApproval({ sessionId: 'session-2', tool: 'shell', input: {} }),
      ];

      const stats = manager.getStats();
      assert.strictEqual(stats.pending, 2);
      assert.strictEqual(stats.total, 2);
      assert.ok(stats.enabled);

      // Clean up - await rejections
      manager.denyAll('session-1');
      manager.denyAll('session-2');
      for (const promise of promises) {
        await assert.rejects(promise, /Denied/);
      }
    });
  });

  describe('clearCompleted', () => {
    it('should clear completed requests', async () => {
      let requestId;
      manager.on('approval:required', (e) => { requestId = e.requestId; });

      const promise = manager.requestApproval({
        sessionId: 'session-1',
        tool: 'delete_file',
        input: {},
      });

      manager.approve(requestId);
      await promise;

      const cleared = manager.clearCompleted();
      assert.strictEqual(cleared, 1);
      assert.strictEqual(manager.getStats().total, 0);
    });
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetApprovalManager();
  });

  describe('getApprovalManager', () => {
    it('should return the same instance on multiple calls', () => {
      const manager1 = getApprovalManager();
      const manager2 = getApprovalManager();
      assert.strictEqual(manager1, manager2);
    });
  });

  describe('resetApprovalManager', () => {
    it('should reset the singleton', () => {
      const manager1 = getApprovalManager({ defaultTimeoutMs: 5000 });
      resetApprovalManager();
      const manager2 = getApprovalManager({ defaultTimeoutMs: 10000 });

      assert.strictEqual(manager2.getStats().defaultTimeoutMs, 10000);
    });
  });
});

describe('DEFAULT_APPROVAL_TOOLS', () => {
  it('should include dangerous operations', () => {
    assert.ok(DEFAULT_APPROVAL_TOOLS.includes('delete_file'));
    assert.ok(DEFAULT_APPROVAL_TOOLS.includes('run_shell_command'));
    assert.ok(DEFAULT_APPROVAL_TOOLS.includes('bash'));
  });
});
