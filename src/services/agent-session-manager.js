import crypto from 'crypto';
import { AGENT_LIMITS, OUTPUT_LIMITS } from '../config/timeouts.js';
import { calculateCost } from '../config/pricing.js';
import { SessionError } from '../utils/errors.js';

/**
 * Session status constants
 */
export const SessionStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PENDING_REVIEW: 'pending_review',  // Awaiting Claude approval
  COMPLETED: 'completed',
  REJECTED: 'rejected',              // Changes rejected by reviewer
  FAILED: 'failed',
};

/**
 * AgentSessionManager - Manages Gemini agent mode sessions
 *
 * Key differences from ConversationManager:
 * - Tracks file mutations (created, modified, deleted)
 * - Tracks shell commands executed
 * - Stores Gemini's native session_id for --resume
 * - Supports iteration counting for safety limits
 */
class AgentSessionManager {
  /**
   * @param {Object} options Configuration options
   * @param {number} [options.maxSessions=50] Maximum concurrent sessions
   * @param {number} [options.expirationMs] Session expiration (default: 4 hours from AGENT_LIMITS)
   * @param {number} [options.cleanupIntervalMs] Cleanup interval (default: 1 hour from AGENT_LIMITS)
   * @param {boolean} [options.autoCleanup=true] Enable auto-cleanup
   */
  constructor(options = {}) {
    this.sessions = new Map();
    this.maxSessions = options.maxSessions || 50;
    this.expirationMs = options.expirationMs || AGENT_LIMITS.SESSION_EXPIRATION_MS;
    this.cleanupIntervalMs = options.cleanupIntervalMs || AGENT_LIMITS.SESSION_CLEANUP_INTERVAL_MS;

    if (options.autoCleanup !== false) {
      this.cleanupInterval = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    }
  }

  /**
   * Creates a new agent session
   * @param {Object} options Session configuration
   * @param {string} options.taskDescription Description of the task
   * @param {string} [options.workingDirectory] Working directory (defaults to cwd)
   * @param {string} [options.model] Gemini model to use
   * @param {number} [options.maxIterations=20] Maximum tool calls
   * @param {number} [options.timeoutMinutes=10] Timeout in minutes
   * @returns {Object} The created session
   */
  createSession(options = {}) {
    if (this.sessions.size >= this.maxSessions) {
      throw new SessionError(`Maximum sessions (${this.maxSessions}) reached. Delete old sessions first.`);
    }

    const sessionId = crypto.randomUUID();
    const now = Date.now();

    const session = {
      id: sessionId,
      geminiSessionId: null, // Set when Gemini returns session event
      status: SessionStatus.PENDING,
      createdAt: now,
      updatedAt: now,

      // Task info
      taskDescription: options.taskDescription || '',
      workingDirectory: options.workingDirectory || process.cwd(),
      model: options.model || null,

      // Safety limits (using centralized constants from config/timeouts.js)
      maxIterations: options.maxIterations || AGENT_LIMITS.DEFAULT_MAX_ITERATIONS,
      timeoutMs: (options.timeoutMinutes || AGENT_LIMITS.DEFAULT_TIMEOUT_MINUTES) * 60 * 1000,
      iterations: 0,

      // Execution tracking
      toolCalls: [],

      // File mutations
      filesCreated: [],
      filesModified: [],
      filesDeleted: [],
      filesRead: [],

      // Shell commands
      shellCommands: [],

      // Token tracking
      tokens: { input: 0, output: 0, total: 0 },

      // Cost tracking (for API key users)
      authMethod: options.authMethod || 'oauth', // 'oauth' = free, 'api_key' = paid
      estimatedCost: 0, // USD, updated when tokens are tracked

      // Retry tracking
      autoRetries: 0, // Number of auto-retries attempted
      maxAutoRetries: options.maxAutoRetries || AGENT_LIMITS.MAX_AUTO_RETRIES,

      // Review tracking (for auto-review workflow)
      pendingChanges: null,  // Stores diff/files awaiting approval
      reviewedAt: null,      // When review was completed
      reviewedBy: null,      // Who approved (e.g., 'claude-opus')
      approvalStatus: null,  // 'approved', 'rejected', or null
      reviewFeedback: null,  // Feedback if rejected

      // Final result
      result: null,
      error: null,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Retrieves a session by ID
   * @param {string} id Session ID
   * @returns {Object|undefined} The session or undefined
   */
  getSession(id) {
    return this.sessions.get(id);
  }

  /**
   * Updates session with Gemini's native session ID (for --resume)
   * @param {string} sessionId Our session ID
   * @param {string} geminiSessionId Gemini's native session ID
   */
  setGeminiSessionId(sessionId, geminiSessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.geminiSessionId = geminiSessionId;
      session.updatedAt = Date.now();
    }
  }

  /**
   * Updates session status
   * @param {string} sessionId Session ID
   * @param {string} status New status
   */
  setStatus(sessionId, status) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.updatedAt = Date.now();
    }
  }

  /**
   * Sets the final result of a session
   * @param {string} sessionId Session ID
   * @param {string} result Result text
   */
  setResult(sessionId, result) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.result = result;
      session.status = SessionStatus.COMPLETED;
      session.updatedAt = Date.now();
    }
  }

  /**
   * Sets the error for a failed session
   * @param {string} sessionId Session ID
   * @param {string} error Error message
   */
  setError(sessionId, error) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.error = error;
      session.status = SessionStatus.FAILED;
      session.updatedAt = Date.now();
    }
  }

  /**
   * Records a file mutation for PENDING_REVIEW tracking
   * @param {string} sessionId Session ID
   * @param {string} type Mutation type: 'create', 'modify', or 'delete'
   * @param {string} filePath Path of the affected file
   */
  recordFileMutation(sessionId, type, filePath) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (type) {
      case 'create':
        if (!session.filesCreated.includes(filePath)) {
          session.filesCreated.push(filePath);
        }
        break;
      case 'modify':
        if (!session.filesModified.includes(filePath)) {
          session.filesModified.push(filePath);
        }
        break;
      case 'delete':
        if (!session.filesDeleted.includes(filePath)) {
          session.filesDeleted.push(filePath);
        }
        break;
    }
    session.updatedAt = Date.now();
  }

  /**
   * Sets session to pending review with changes awaiting approval
   * @param {string} sessionId Session ID
   * @param {Object} changes Changes awaiting approval
   * @param {string[]} [changes.filesModified] Files that were modified
   * @param {string[]} [changes.filesCreated] Files that were created
   * @param {string} [changes.diff] Git diff of changes
   * @param {string} [changes.summary] Summary of what changed
   */
  setPendingReview(sessionId, changes) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pendingChanges = changes;
      session.status = SessionStatus.PENDING_REVIEW;
      session.updatedAt = Date.now();
    }
  }

  /**
   * Sets the approval status after review
   * @param {string} sessionId Session ID
   * @param {boolean} approved Whether changes were approved
   * @param {Object} [options] Additional options
   * @param {string} [options.reviewedBy] Who performed the review
   * @param {string} [options.feedback] Feedback if rejected
   * @returns {boolean} True if status was set successfully
   */
  setApprovalStatus(sessionId, approved, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.status !== SessionStatus.PENDING_REVIEW) {
      return false; // Can only approve/reject sessions in PENDING_REVIEW state
    }

    session.reviewedAt = Date.now();
    session.reviewedBy = options.reviewedBy || 'unknown';
    session.approvalStatus = approved ? 'approved' : 'rejected';
    session.reviewFeedback = options.feedback || null;
    session.status = approved ? SessionStatus.COMPLETED : SessionStatus.REJECTED;
    session.updatedAt = Date.now();

    return true;
  }

  /**
   * Check if a session can be auto-retried
   * @param {string} sessionId Session ID
   * @returns {boolean} True if auto-retry is allowed
   */
  canAutoRetry(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.autoRetries < session.maxAutoRetries;
  }

  /**
   * Increment the retry count for a session
   * @param {string} sessionId Session ID
   * @returns {number} New retry count, or -1 if session not found
   */
  incrementRetry(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return -1;
    session.autoRetries++;
    session.status = SessionStatus.PENDING; // Reset to pending for retry
    session.updatedAt = Date.now();
    return session.autoRetries;
  }

  /**
   * Updates token counts and calculates estimated cost
   * @param {string} sessionId Session ID
   * @param {Object} tokens Token counts { input, output, total }
   */
  updateTokens(sessionId, tokens) {
    const session = this.sessions.get(sessionId);
    if (session && tokens) {
      const input = tokens.input || tokens.inputTokens || 0;
      const output = tokens.output || tokens.outputTokens || 0;
      const total = tokens.total || tokens.totalTokens || 0;

      session.tokens = { input, output, total };

      // Calculate cost for API key users (OAuth is free)
      if (session.authMethod !== 'oauth' && total > 0) {
        const model = session.model || 'gemini-2.5-flash';
        session.estimatedCost = calculateCost(model, input, output, 'gemini', session.authMethod);
      }

      session.updatedAt = Date.now();
    }
  }

  /**
   * Records a tool call and updates tracking arrays
   * @param {string} sessionId Session ID
   * @param {Object} toolCall Tool call details
   * @param {string} toolCall.tool Tool name
   * @param {Object} toolCall.input Tool input/arguments
   * @param {*} [toolCall.output] Tool output
   * @param {string} [toolCall.code] Tool code (for tool_code events)
   */
  recordToolCall(sessionId, toolCall) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.iterations++;

    // Truncate large input/output to prevent memory bloat
    const MAX_STORED_SIZE = OUTPUT_LIMITS.TOOL_CALL_MAX_SIZE; // ~500 tokens per field
    const truncateField = (value) => {
      if (typeof value !== 'string') {
        value = value != null ? JSON.stringify(value) : '';
      }
      if (value.length > MAX_STORED_SIZE) {
        return value.slice(0, MAX_STORED_SIZE / 2) + '\n[...truncated...]\n' + value.slice(-MAX_STORED_SIZE / 2);
      }
      return value;
    };

    session.toolCalls.push({
      tool: toolCall.tool,
      input: truncateField(toolCall.input),
      output: toolCall.output ? truncateField(toolCall.output) : undefined,
      code: toolCall.code ? truncateField(toolCall.code) : undefined,
      timestamp: Date.now(),
    });
    session.updatedAt = Date.now();

    const { tool, input } = toolCall;
    if (!tool || !input) return;

    // Extract path from various input formats
    const path = input.path || input.file_path || input.filename || input.target || input.file;

    switch (tool) {
      case 'write_file':
      case 'save_file':
      case 'create_file':
        if (path) {
          // Check if file was already tracked
          if (!session.filesCreated.includes(path) && !session.filesModified.includes(path)) {
            // New file - add to created
            session.filesCreated.push(path);
          } else if (session.filesCreated.includes(path)) {
            // Already created, now being modified again - keep in created
          } else if (!session.filesModified.includes(path)) {
            // Existing file being modified
            session.filesModified.push(path);
          }
        }
        break;

      case 'read_file':
      case 'view_file':
        if (path && !session.filesRead.includes(path)) {
          session.filesRead.push(path);
        }
        break;

      case 'delete_file':
      case 'remove_file':
        if (path && !session.filesDeleted.includes(path)) {
          session.filesDeleted.push(path);
        }
        break;

      case 'run_shell_command':
      case 'shell':
      case 'execute':
      case 'bash':
        if (input.command) {
          session.shellCommands.push({
            command: input.command,
            exitCode: toolCall.exitCode,
            timestamp: Date.now(),
          });
        }
        break;
    }
  }

  /**
   * Checks if session has exceeded safety limits
   * @param {string} sessionId Session ID
   * @returns {{exceeded: boolean, reason?: string}} Limit check result
   */
  checkLimits(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { exceeded: true, reason: 'Session not found' };
    }

    // Check iteration limit
    if (session.iterations >= session.maxIterations) {
      return {
        exceeded: true,
        reason: `Maximum iterations (${session.maxIterations}) reached`,
      };
    }

    // Check timeout
    const elapsed = Date.now() - session.createdAt;
    if (elapsed >= session.timeoutMs) {
      return {
        exceeded: true,
        reason: `Timeout (${Math.round(session.timeoutMs / 60000)} minutes) exceeded`,
      };
    }

    return { exceeded: false };
  }

  /**
   * Generates a structured summary of the session
   * @param {string} sessionId Session ID
   * @returns {Object|null} Session summary or null if not found
   */
  getSummary(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const duration = Date.now() - session.createdAt;

    return {
      id: session.id,
      geminiSessionId: session.geminiSessionId,
      status: session.status,
      duration,
      durationFormatted: `${Math.round(duration / 1000)}s`,
      iterations: session.iterations,
      maxIterations: session.maxIterations,

      files: {
        created: [...session.filesCreated],
        modified: [...session.filesModified],
        deleted: [...session.filesDeleted],
        read: [...session.filesRead],
      },

      shellCommands: session.shellCommands.length,
      shellCommandList: session.shellCommands.map((c) => c.command),

      tokens: { ...session.tokens },

      // Cost information (only relevant for API key users)
      authMethod: session.authMethod,
      estimatedCost: session.estimatedCost,
      estimatedCostFormatted: session.estimatedCost > 0
        ? `$${session.estimatedCost.toFixed(6)}`
        : (session.authMethod === 'oauth' ? 'FREE (OAuth)' : '$0.000000'),

      result: session.result,
      error: session.error,

      resumeCommand: session.geminiSessionId
        ? `gemini --resume ${session.geminiSessionId}`
        : null,
    };
  }

  /**
   * Lists sessions with optional filtering
   * @param {Object} [filter] Filter options
   * @param {string} [filter.status] Filter by status
   * @returns {Object[]} Array of session summaries
   */
  listSessions(filter = {}) {
    let sessions = Array.from(this.sessions.values());

    if (filter.status) {
      sessions = sessions.filter((s) => s.status === filter.status);
    }

    // Sort by creation time, newest first
    sessions.sort((a, b) => b.createdAt - a.createdAt);

    return sessions.map((s) => this.getSummary(s.id));
  }

  /**
   * Deletes a session
   * @param {string} id Session ID
   * @returns {boolean} True if deleted
   */
  deleteSession(id) {
    return this.sessions.delete(id);
  }

  /**
   * Removes expired sessions
   */
  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updatedAt > this.expirationMs) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Destroys the manager (clears interval and sessions)
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }

  /**
   * Gets the number of active sessions
   * @returns {number} Session count
   */
  get size() {
    return this.sessions.size;
  }
}

// Singleton instance
let instance = null;

/**
 * Gets the singleton AgentSessionManager instance
 * @param {Object} [config] Configuration (only used on first call)
 * @returns {AgentSessionManager} The singleton instance
 */
export function getAgentSessionManager(config) {
  if (!instance) {
    instance = new AgentSessionManager(config);
  }
  return instance;
}

/**
 * Resets the singleton (mainly for testing)
 */
export function resetAgentSessionManager() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

export default AgentSessionManager;
