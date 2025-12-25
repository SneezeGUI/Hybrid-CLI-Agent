/**
 * Structured error classes for the hybrid agent system
 * Provides specific error types for better error handling and debugging
 */

/**
 * Base error class for all hybrid agent errors
 */
export class HybridError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} code - Error code (e.g., 'VALIDATION_ERROR')
   * @param {Object} context - Additional context for debugging
   */
  constructor(message, code = 'HYBRID_ERROR', context = {}) {
    super(message);
    this.name = 'HybridError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to JSON for logging
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }

  /**
   * Create a user-friendly error message
   */
  toUserMessage() {
    return `${this.code}: ${this.message}`;
  }
}

/**
 * Validation errors for invalid input
 */
export class ValidationError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {string} field - Field that failed validation
   * @param {*} value - The invalid value (will be sanitized)
   */
  constructor(message, field = null, value = undefined) {
    super(message, 'VALIDATION_ERROR', { field });
    this.name = 'ValidationError';
    this.field = field;
    // Don't store actual value to avoid leaking sensitive data
    this.valueType = typeof value;
  }

  toUserMessage() {
    if (this.field) {
      return `Validation error in '${this.field}': ${this.message}`;
    }
    return `Validation error: ${this.message}`;
  }
}

/**
 * Authentication errors
 */
export class AuthenticationError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {string} method - Auth method that failed (oauth, api-key, vertex)
   */
  constructor(message, method = null) {
    super(message, 'AUTH_ERROR', { method });
    this.name = 'AuthenticationError';
    this.method = method;
  }

  toUserMessage() {
    const methodStr = this.method ? ` (${this.method})` : '';
    return `Authentication failed${methodStr}: ${this.message}`;
  }
}

/**
 * Timeout errors for long-running operations
 */
export class TimeoutError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {string} operation - Operation that timed out
   * @param {number} timeoutMs - Timeout duration in milliseconds
   */
  constructor(message, operation = null, timeoutMs = null) {
    super(message, 'TIMEOUT_ERROR', { operation, timeoutMs });
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }

  toUserMessage() {
    const timeout = this.timeoutMs ? ` after ${this.timeoutMs / 1000}s` : '';
    const op = this.operation ? ` during '${this.operation}'` : '';
    return `Operation timed out${op}${timeout}`;
  }
}

/**
 * Model/API errors
 */
export class ModelError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {string} model - Model name
   * @param {string} provider - Provider (gemini, openrouter, claude)
   */
  constructor(message, model = null, provider = null) {
    super(message, 'MODEL_ERROR', { model, provider });
    this.name = 'ModelError';
    this.model = model;
    this.provider = provider;
  }

  toUserMessage() {
    const modelStr = this.model ? ` for model '${this.model}'` : '';
    const providerStr = this.provider ? ` (${this.provider})` : '';
    return `Model error${modelStr}${providerStr}: ${this.message}`;
  }
}

/**
 * Rate limit errors
 */
export class RateLimitError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {number} retryAfter - Seconds to wait before retrying
   * @param {string} provider - Provider that rate limited
   */
  constructor(message, retryAfter = null, provider = null) {
    super(message, 'RATE_LIMIT_ERROR', { retryAfter, provider });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
    this.provider = provider;
  }

  toUserMessage() {
    const retry = this.retryAfter ? ` Retry after ${this.retryAfter}s.` : '';
    return `Rate limit exceeded.${retry}`;
  }
}

/**
 * File system errors
 */
export class FileSystemError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {string} operation - Operation (read, write, delete)
   * @param {string} path - File path (sanitized)
   */
  constructor(message, operation = null, path = null) {
    // Sanitize path to avoid leaking directory structure
    const sanitizedPath = path ? path.split(/[/\\]/).pop() : null;
    super(message, 'FILESYSTEM_ERROR', { operation, file: sanitizedPath });
    this.name = 'FileSystemError';
    this.operation = operation;
  }

  toUserMessage() {
    const op = this.operation ? ` during '${this.operation}'` : '';
    return `File system error${op}: ${this.message}`;
  }
}

/**
 * Process/spawn errors
 */
export class ProcessError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {string} command - Command that failed
   * @param {number} exitCode - Process exit code
   */
  constructor(message, command = null, exitCode = null) {
    super(message, 'PROCESS_ERROR', { command, exitCode });
    this.name = 'ProcessError';
    this.command = command;
    this.exitCode = exitCode;
  }

  toUserMessage() {
    const exit = this.exitCode !== null ? ` (exit code: ${this.exitCode})` : '';
    return `Process error${exit}: ${this.message}`;
  }
}

/**
 * Configuration errors
 */
export class ConfigError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {string} setting - Configuration setting that's invalid
   */
  constructor(message, setting = null) {
    super(message, 'CONFIG_ERROR', { setting });
    this.name = 'ConfigError';
    this.setting = setting;
  }

  toUserMessage() {
    const settingStr = this.setting ? ` for '${this.setting}'` : '';
    return `Configuration error${settingStr}: ${this.message}`;
  }
}

/**
 * Session/conversation errors
 */
export class SessionError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {string} sessionId - Session ID
   * @param {string} state - Session state when error occurred
   */
  constructor(message, sessionId = null, state = null) {
    super(message, 'SESSION_ERROR', { sessionId, state });
    this.name = 'SessionError';
    this.sessionId = sessionId;
    this.state = state;
  }

  toUserMessage() {
    const stateStr = this.state ? ` (state: ${this.state})` : '';
    return `Session error${stateStr}: ${this.message}`;
  }
}

/**
 * Cost/budget errors
 */
export class BudgetError extends HybridError {
  /**
   * @param {string} message - Error message
   * @param {number} spent - Amount spent
   * @param {number} limit - Budget limit
   */
  constructor(message, spent = null, limit = null) {
    super(message, 'BUDGET_ERROR', { spent, limit });
    this.name = 'BudgetError';
    this.spent = spent;
    this.limit = limit;
  }

  toUserMessage() {
    if (this.spent !== null && this.limit !== null) {
      return `Budget exceeded: $${this.spent.toFixed(4)} spent of $${this.limit.toFixed(4)} limit`;
    }
    return `Budget error: ${this.message}`;
  }
}

/**
 * Error codes for easy reference
 */
export const ERROR_CODES = {
  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_PROMPT: 'INVALID_PROMPT',
  INVALID_MODEL: 'INVALID_MODEL',
  INVALID_PATTERN: 'INVALID_PATTERN',

  // Authentication
  AUTH_ERROR: 'AUTH_ERROR',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  AUTH_MISSING: 'AUTH_MISSING',

  // Operations
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  MODEL_ERROR: 'MODEL_ERROR',
  PROCESS_ERROR: 'PROCESS_ERROR',

  // Resources
  FILESYSTEM_ERROR: 'FILESYSTEM_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
  SESSION_ERROR: 'SESSION_ERROR',
  BUDGET_ERROR: 'BUDGET_ERROR',
};

/**
 * Helper to wrap unknown errors in HybridError
 * @param {Error|string} err - Error to wrap
 * @param {string} context - Context where error occurred
 * @returns {HybridError}
 */
export function wrapError(err, context = 'unknown') {
  if (err instanceof HybridError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new HybridError(message, 'WRAPPED_ERROR', { originalContext: context });

  if (err instanceof Error && err.stack) {
    wrapped.originalStack = err.stack;
  }

  return wrapped;
}

/**
 * Check if error is a specific type
 * @param {Error} err - Error to check
 * @param {string} code - Error code to check against
 * @returns {boolean}
 */
export function isErrorCode(err, code) {
  return err instanceof HybridError && err.code === code;
}

export default {
  HybridError,
  ValidationError,
  AuthenticationError,
  TimeoutError,
  ModelError,
  RateLimitError,
  FileSystemError,
  ProcessError,
  ConfigError,
  SessionError,
  BudgetError,
  ERROR_CODES,
  wrapError,
  isErrorCode,
};
