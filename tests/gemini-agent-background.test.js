/**
 * Tests for background task mode parameter validation
 * Note: Full integration tests should be done manually due to process lifecycle complexity
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import {
    getAgentSessionManager,
    resetAgentSessionManager,
    SessionStatus,
} from '../src/services/agent-session-manager.js';

describe('gemini_agent_task background mode', () => {
    let originalEnv;

    beforeEach(() => {
        resetAgentSessionManager();
        originalEnv = process.env.GEMINI_AGENT_MODE;
    });

    afterEach(() => {
        resetAgentSessionManager();
        process.env.GEMINI_AGENT_MODE = originalEnv;
    });

    describe('Session state for background tasks', () => {
        it('should support RUNNING state for background tasks', () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({
                taskDescription: 'Background test task',
            });

            // Set to RUNNING (as background mode does)
            sessionManager.setStatus(session.id, SessionStatus.RUNNING);

            const updated = sessionManager.getSession(session.id);
            assert.strictEqual(updated.status, SessionStatus.RUNNING);
        });

        it('should transition from RUNNING to PENDING_REVIEW', () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({
                taskDescription: 'Background test task',
            });

            sessionManager.setStatus(session.id, SessionStatus.RUNNING);

            // Simulate background completion with file changes
            sessionManager.recordFileMutation(session.id, 'create', 'test.js');
            sessionManager.setPendingReview(session.id, {
                filesCreated: ['test.js'],
                summary: 'Created test file',
            });

            const updated = sessionManager.getSession(session.id);
            assert.strictEqual(updated.status, SessionStatus.PENDING_REVIEW);
            assert.deepStrictEqual(updated.pendingChanges.filesCreated, ['test.js']);
        });

        it('should transition from RUNNING to COMPLETED without file changes', () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({
                taskDescription: 'Read-only background task',
            });

            sessionManager.setStatus(session.id, SessionStatus.RUNNING);

            // Complete without file changes (read-only task)
            sessionManager.setResult(session.id, 'Analysis complete');

            const updated = sessionManager.getSession(session.id);
            assert.strictEqual(updated.status, SessionStatus.COMPLETED);
            assert.strictEqual(updated.result, 'Analysis complete');
        });

        it('should transition from RUNNING to FAILED on error', () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({
                taskDescription: 'Background task that fails',
            });

            sessionManager.setStatus(session.id, SessionStatus.RUNNING);
            sessionManager.setError(session.id, 'Task failed');

            const updated = sessionManager.getSession(session.id);
            assert.strictEqual(updated.status, SessionStatus.FAILED);
            assert.strictEqual(updated.error, 'Task failed');
        });
    });

    describe('Session listing for background status polling', () => {
        it('should list RUNNING sessions for status polling', () => {
            const sessionManager = getAgentSessionManager();

            // Create multiple sessions in different states
            const bgSession = sessionManager.createSession({ taskDescription: 'Background task' });
            sessionManager.setStatus(bgSession.id, SessionStatus.RUNNING);

            const completed = sessionManager.createSession({ taskDescription: 'Completed task' });
            sessionManager.setResult(completed.id, 'Done');

            // Filter for RUNNING only (what Claude would poll)
            const running = sessionManager.listSessions({ status: SessionStatus.RUNNING });
            assert.strictEqual(running.length, 1);
            assert.strictEqual(running[0].id, bgSession.id);
        });

        it('should list PENDING_REVIEW sessions for approval', () => {
            const sessionManager = getAgentSessionManager();

            const session = sessionManager.createSession({ taskDescription: 'Task with changes' });
            sessionManager.setStatus(session.id, SessionStatus.RUNNING);
            sessionManager.setPendingReview(session.id, {
                filesModified: ['file.js'],
                summary: 'Modified file',
            });

            const pending = sessionManager.listSessions({ status: SessionStatus.PENDING_REVIEW });
            assert.strictEqual(pending.length, 1);
            assert.strictEqual(pending[0].status, SessionStatus.PENDING_REVIEW);
        });
    });
});
