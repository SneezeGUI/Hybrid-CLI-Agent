import { test, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { handlers } from '../src/mcp/tool-handlers/agent/index.js';
import { getAgentSessionManager, resetAgentSessionManager } from '../src/services/agent-session-manager.js';

describe('Gemini Agent Status Workflow', () => {
  beforeEach(() => {
    resetAgentSessionManager();
    // Mock environment
    process.env.GEMINI_AGENT_MODE = 'true';
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterEach(() => {
    resetAgentSessionManager();
    delete process.env.GEMINI_AGENT_MODE;
    delete process.env.GEMINI_API_KEY;
  });

  it('should return PENDING_REVIEW when file is modified via "replace" tool using "file" arg', async () => {
    const mockProc = new EventEmitter();
    mockProc.stdout = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    mockProc.stdin = { write: () => {}, end: () => {} };
    mockProc.kill = () => {};
    mockProc.killed = false;

    const mockContext = {
      safeSpawn: () => {
        // Simulate agent output asynchronously
        setTimeout(() => {
            // 1. Emit tool_use event for replace with 'file' argument
            const toolEvent = JSON.stringify({
                type: 'tool_use',
                tool_name: 'replace',
                tool_input: {
                    file: 'test.txt',
                    old_string: 'foo',
                    new_string: 'bar'
                }
            });
            mockProc.stdout.emit('data', Buffer.from(toolEvent + '\n'));
            
            // 2. Emit text event
            const textEvent = JSON.stringify({
                type: 'text',
                content: 'I have updated the file.'
            });
            mockProc.stdout.emit('data', Buffer.from(textEvent + '\n'));

            // 3. Close process
            mockProc.emit('close', 0);
        }, 10);
        return mockProc;
      }
    };

    const result = await handlers.gemini_agent_task({
      task_description: 'Update test.txt',
      max_iterations: 5,
      timeout_minutes: 1
    }, mockContext);

    // Assert that the result indicates PENDING REVIEW
    const isPendingReview = result.content[0].text.includes('PENDING REVIEW');
    
    // Check session status
    const sessionManager = getAgentSessionManager();
    const sessions = sessionManager.listSessions();
    const session = sessions[0];
    
    assert.strictEqual(session.status, 'pending_review', 'Session status should be pending_review');
    assert.strictEqual(session.files.modified.length, 1, 'Should have 1 modified file');
    assert.strictEqual(session.files.modified[0], 'test.txt', 'Modified file should be test.txt');
    assert.ok(isPendingReview, 'Output should contain "PENDING REVIEW"');
  });

  it('should return COMPLETED when no files are modified', async () => {
    const mockProc = new EventEmitter();
    mockProc.stdout = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    mockProc.stdin = { write: () => {}, end: () => {} };
    mockProc.kill = () => {};
    mockProc.killed = false;

    const mockContext = {
      safeSpawn: () => {
        setTimeout(() => {
            const textEvent = JSON.stringify({
                type: 'text',
                content: 'Just checking things.'
            });
            mockProc.stdout.emit('data', Buffer.from(textEvent + '\n'));
            mockProc.emit('close', 0);
        }, 10);
        return mockProc;
      }
    };

    const result = await handlers.gemini_agent_task({
      task_description: 'Read only task',
      max_iterations: 5
    }, mockContext);

    const sessionManager = getAgentSessionManager();
    const session = sessionManager.listSessions()[0];
    
    assert.strictEqual(session.status, 'completed', 'Session status should be completed');
    assert.ok(result.content[0].text.includes('Agent Task Completed'), 'Output should contain "Agent Task Completed"');
  });
});
