/**
 * Approval Manager - Human-in-the-loop approval for dangerous operations
 *
 * When AGENT_APPROVAL_MODE=true, dangerous operations require explicit approval
 * before being executed. This provides a safety net for automated agent actions.
 *
 * @module services/approval-manager
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

/**
 * Approval status constants
 */
export const ApprovalStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  TIMED_OUT: 'timed_out',
};

/**
 * Tools that require approval by default
 * Can be extended via APPROVAL_REQUIRED_TOOLS env var (comma-separated)
 */
export const DEFAULT_APPROVAL_TOOLS = [
  'delete_file',
  'remove_file',
  'run_shell_command',
  'shell',
  'execute',
  'bash',
];

/**
 * Approval request details
 * @typedef {Object} ApprovalRequest
 * @property {string} id - Unique request ID
 * @property {string} sessionId - Agent session ID
 * @property {string} tool - Tool name
 * @property {Object} input - Tool input/arguments
 * @property {string} status - Approval status
 * @property {number} createdAt - Timestamp
 * @property {number} expiresAt - Expiration timestamp
 * @property {string|null} approvedBy - Who approved (if approved)
 * @property {string|null} reason - Reason for denial (if denied)
 */

/**
 * Approval Manager - Handles approval requests for dangerous operations
 *
 * Events:
 * - 'approval:required' - { requestId, sessionId, tool, input }
 * - 'approval:resolved' - { requestId, status, approvedBy, reason }
 * - 'approval:expired' - { requestId }
 */
export class ApprovalManager extends EventEmitter {
  /**
   * @param {Object} options Configuration
   * @param {number} [options.defaultTimeoutMs=300000] Default approval timeout (5 min)
   * @param {string[]} [options.requiredTools] Tools that require approval
   * @param {boolean} [options.enabled=false] Whether approval mode is enabled
   */
  constructor(options = {}) {
    super();
    this.defaultTimeoutMs = options.defaultTimeoutMs || 300000; // 5 minutes
    this.enabled = options.enabled || process.env.AGENT_APPROVAL_MODE === 'true';

    // Parse required tools from env or use defaults
    const envTools = process.env.APPROVAL_REQUIRED_TOOLS
      ? process.env.APPROVAL_REQUIRED_TOOLS.split(',').map(t => t.trim())
      : [];
    this.requiredTools = new Set([
      ...(options.requiredTools || DEFAULT_APPROVAL_TOOLS),
      ...envTools,
    ]);

    /** @type {Map<string, ApprovalRequest>} */
    this.pendingRequests = new Map();

    /** @type {Map<string, NodeJS.Timeout>} */
    this.timeouts = new Map();
  }

  /**
   * Check if approval is required for a tool
   * @param {string} tool - Tool name
   * @returns {boolean} True if approval is required
   */
  requiresApproval(tool) {
    if (!this.enabled) return false;
    return this.requiredTools.has(tool);
  }

  /**
   * Request approval for an operation
   * @param {Object} params Request parameters
   * @param {string} params.sessionId - Agent session ID
   * @param {string} params.tool - Tool name
   * @param {Object} params.input - Tool input
   * @param {number} [params.timeoutMs] - Timeout for this request
   * @returns {Promise<ApprovalRequest>} Resolves when approved, rejects if denied/timeout
   */
  async requestApproval({ sessionId, tool, input, timeoutMs }) {
    const requestId = crypto.randomUUID();
    const now = Date.now();
    const timeout = timeoutMs || this.defaultTimeoutMs;

    const request = {
      id: requestId,
      sessionId,
      tool,
      input,
      status: ApprovalStatus.PENDING,
      createdAt: now,
      expiresAt: now + timeout,
      approvedBy: null,
      reason: null,
    };

    this.pendingRequests.set(requestId, request);

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      this.handleTimeout(requestId);
    }, timeout);
    this.timeouts.set(requestId, timeoutHandle);

    // Emit event for listeners to handle
    this.emit('approval:required', {
      requestId,
      sessionId,
      tool,
      input,
      expiresAt: request.expiresAt,
    });

    // Return promise that resolves/rejects when approval is resolved
    return new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
    });
  }

  /**
   * Handle approval timeout
   * @param {string} requestId - Request ID
   */
  handleTimeout(requestId) {
    const request = this.pendingRequests.get(requestId);
    if (!request || request.status !== ApprovalStatus.PENDING) return;

    request.status = ApprovalStatus.TIMED_OUT;
    this.timeouts.delete(requestId);

    this.emit('approval:expired', { requestId });
    this.emit('approval:resolved', { requestId, status: ApprovalStatus.TIMED_OUT });

    request.reject(new Error(`Approval request timed out after ${this.defaultTimeoutMs / 1000}s`));
  }

  /**
   * Approve a pending request
   * @param {string} requestId - Request ID
   * @param {Object} [options] - Options
   * @param {string} [options.approvedBy] - Who approved
   * @returns {boolean} True if approved successfully
   */
  approve(requestId, options = {}) {
    const request = this.pendingRequests.get(requestId);
    if (!request || request.status !== ApprovalStatus.PENDING) return false;

    // Clear timeout
    const timeout = this.timeouts.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(requestId);
    }

    request.status = ApprovalStatus.APPROVED;
    request.approvedBy = options.approvedBy || 'user';

    this.emit('approval:resolved', {
      requestId,
      status: ApprovalStatus.APPROVED,
      approvedBy: request.approvedBy,
    });

    request.resolve(request);
    return true;
  }

  /**
   * Deny a pending request
   * @param {string} requestId - Request ID
   * @param {Object} [options] - Options
   * @param {string} [options.reason] - Reason for denial
   * @returns {boolean} True if denied successfully
   */
  deny(requestId, options = {}) {
    const request = this.pendingRequests.get(requestId);
    if (!request || request.status !== ApprovalStatus.PENDING) return false;

    // Clear timeout
    const timeout = this.timeouts.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(requestId);
    }

    request.status = ApprovalStatus.DENIED;
    request.reason = options.reason || 'Denied by user';

    this.emit('approval:resolved', {
      requestId,
      status: ApprovalStatus.DENIED,
      reason: request.reason,
    });

    request.reject(new Error(request.reason));
    return true;
  }

  /**
   * Get a pending approval request
   * @param {string} requestId - Request ID
   * @returns {ApprovalRequest|null} The request or null
   */
  getRequest(requestId) {
    return this.pendingRequests.get(requestId) || null;
  }

  /**
   * List pending approval requests
   * @param {Object} [filter] - Filter options
   * @param {string} [filter.sessionId] - Filter by session ID
   * @returns {ApprovalRequest[]} Pending requests
   */
  listPending(filter = {}) {
    const pending = [];
    for (const request of this.pendingRequests.values()) {
      if (request.status !== ApprovalStatus.PENDING) continue;
      if (filter.sessionId && request.sessionId !== filter.sessionId) continue;
      pending.push({
        id: request.id,
        sessionId: request.sessionId,
        tool: request.tool,
        input: request.input,
        status: request.status,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
        remainingMs: request.expiresAt - Date.now(),
      });
    }
    return pending.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Approve all pending requests for a session
   * @param {string} sessionId - Session ID
   * @param {Object} [options] - Options
   * @returns {number} Number of requests approved
   */
  approveAll(sessionId, options = {}) {
    let count = 0;
    for (const request of this.pendingRequests.values()) {
      if (request.sessionId === sessionId && request.status === ApprovalStatus.PENDING) {
        if (this.approve(request.id, options)) count++;
      }
    }
    return count;
  }

  /**
   * Deny all pending requests for a session
   * @param {string} sessionId - Session ID
   * @param {Object} [options] - Options
   * @returns {number} Number of requests denied
   */
  denyAll(sessionId, options = {}) {
    let count = 0;
    for (const request of this.pendingRequests.values()) {
      if (request.sessionId === sessionId && request.status === ApprovalStatus.PENDING) {
        if (this.deny(request.id, options)) count++;
      }
    }
    return count;
  }

  /**
   * Clear completed requests
   * @returns {number} Number of requests cleared
   */
  clearCompleted() {
    let count = 0;
    for (const [requestId, request] of this.pendingRequests.entries()) {
      if (request.status !== ApprovalStatus.PENDING) {
        this.pendingRequests.delete(requestId);
        count++;
      }
    }
    return count;
  }

  /**
   * Get statistics
   * @returns {Object} Approval stats
   */
  getStats() {
    let pending = 0, approved = 0, denied = 0, timedOut = 0;

    for (const request of this.pendingRequests.values()) {
      switch (request.status) {
        case ApprovalStatus.PENDING: pending++; break;
        case ApprovalStatus.APPROVED: approved++; break;
        case ApprovalStatus.DENIED: denied++; break;
        case ApprovalStatus.TIMED_OUT: timedOut++; break;
      }
    }

    return {
      enabled: this.enabled,
      pending,
      approved,
      denied,
      timedOut,
      total: this.pendingRequests.size,
      requiredTools: [...this.requiredTools],
      defaultTimeoutMs: this.defaultTimeoutMs,
    };
  }

  /**
   * Destroy the manager
   */
  destroy() {
    // Clear all timeouts
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();

    // Deny all pending
    for (const request of this.pendingRequests.values()) {
      if (request.status === ApprovalStatus.PENDING) {
        request.status = ApprovalStatus.DENIED;
        request.reason = 'Manager destroyed';
        request.reject(new Error('Approval manager destroyed'));
      }
    }

    this.pendingRequests.clear();
    this.removeAllListeners();
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton ApprovalManager instance
 * @param {Object} [config] - Configuration (only used on first call)
 * @returns {ApprovalManager}
 */
export function getApprovalManager(config) {
  if (!instance) {
    instance = new ApprovalManager(config);
  }
  return instance;
}

/**
 * Reset the singleton (mainly for testing)
 */
export function resetApprovalManager() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

export default ApprovalManager;
