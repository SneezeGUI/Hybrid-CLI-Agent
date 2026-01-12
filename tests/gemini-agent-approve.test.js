/**
 * Tests for gemini_agent_approve handler
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { handlers } from '../src/mcp/tool-handlers/agent/index.js';
import {
    getAgentSessionManager,
    resetAgentSessionManager,
    SessionStatus,
} from '../src/services/agent-session-manager.js';

describe('gemini_agent_approve handler', () => {
    beforeEach(() => {
        resetAgentSessionManager();
    });

    afterEach(() => {
        resetAgentSessionManager();
    });

    describe('Argument validation', () => {
        it('should require session_id', async () => {
            const result = await handlers.gemini_agent_approve({ approved: true });

            assert.strictEqual(result.isError, true);
            assert.ok(result.content[0].text.includes('session_id'));
        });

        it('should require approved boolean', async () => {
            const result = await handlers.gemini_agent_approve({ session_id: 'test-id' });

            assert.strictEqual(result.isError, true);
            assert.ok(result.content[0].text.includes('approved'));
        });

        it('should reject non-boolean approved value', async () => {
            const result = await handlers.gemini_agent_approve({
                session_id: 'test-id',
                approved: 'yes',
            });

            assert.strictEqual(result.isError, true);
            assert.ok(result.content[0].text.includes('approved'));
        });
    });

    describe('Session validation', () => {
        it('should reject non-existent session', async () => {
            const result = await handlers.gemini_agent_approve({
                session_id: 'non-existent',
                approved: true,
            });

            assert.strictEqual(result.isError, true);
            assert.ok(result.content[0].text.includes('not found'));
        });

        it('should reject session not in PENDING_REVIEW state', async () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({ taskDescription: 'Test task' });

            // Session is in PENDING state, not PENDING_REVIEW
            const result = await handlers.gemini_agent_approve({
                session_id: session.id,
                approved: true,
            });

            assert.strictEqual(result.isError, true);
            assert.ok(result.content[0].text.includes('not pending review'));
        });

        it('should reject already completed session', async () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({ taskDescription: 'Test task' });
            sessionManager.setResult(session.id, 'completed');

            const result = await handlers.gemini_agent_approve({
                session_id: session.id,
                approved: true,
            });

            assert.strictEqual(result.isError, true);
            assert.ok(result.content[0].text.includes('not pending review'));
        });
    });

    describe('Approval workflow', () => {
        it('should approve session and set to COMPLETED', async () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({ taskDescription: 'Test task' });

            // Set session to PENDING_REVIEW state
            sessionManager.setPendingReview(session.id, {
                filesModified: ['src/test.js'],
                summary: 'Test changes',
            });

            const result = await handlers.gemini_agent_approve({
                session_id: session.id,
                approved: true,
            });

            assert.strictEqual(result.isError, undefined);
            assert.ok(result.content[0].text.includes('Approved'));

            // Verify session state changed
            const updated = sessionManager.getSession(session.id);
            assert.strictEqual(updated.status, SessionStatus.COMPLETED);
            assert.strictEqual(updated.approvalStatus, 'approved');
            assert.ok(updated.reviewedAt);
        });

        it('should reject session and set to REJECTED', async () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({ taskDescription: 'Test task' });

            sessionManager.setPendingReview(session.id, {
                filesModified: ['src/test.js'],
                summary: 'Test changes',
            });

            const result = await handlers.gemini_agent_approve({
                session_id: session.id,
                approved: false,
                feedback: 'Code style issues',
            });

            assert.strictEqual(result.isError, undefined);
            assert.ok(result.content[0].text.includes('Rejected'));

            const updated = sessionManager.getSession(session.id);
            assert.strictEqual(updated.status, SessionStatus.REJECTED);
            assert.strictEqual(updated.approvalStatus, 'rejected');
            assert.strictEqual(updated.reviewFeedback, 'Code style issues');
        });

        it('should store reviewer information', async () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({ taskDescription: 'Test task' });

            sessionManager.setPendingReview(session.id, {
                filesModified: ['src/test.js'],
            });

            await handlers.gemini_agent_approve({
                session_id: session.id,
                approved: true,
            });

            const updated = sessionManager.getSession(session.id);
            assert.strictEqual(updated.reviewedBy, 'claude-opus');
        });
    });

    describe('Inline fixes', () => {
        it('should accept fixes array in approved request', async () => {
            const sessionManager = getAgentSessionManager();
            const session = sessionManager.createSession({ taskDescription: 'Test task' });

            sessionManager.setPendingReview(session.id, {
                filesModified: ['src/test.js'],
            });

            // This will fail to apply fixes since file doesn't exist, but should still approve
            const result = await handlers.gemini_agent_approve({
                session_id: session.id,
                approved: true,
                fixes: [
                    { file: 'src/nonexistent.js', search: 'old', replace: 'new' },
                ],
            });

            // Should still approve even if fixes fail
            assert.strictEqual(result.isError, undefined);

            const updated = sessionManager.getSession(session.id);
            assert.strictEqual(updated.status, SessionStatus.COMPLETED);
        });
    });
});
