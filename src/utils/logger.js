/**
 * Structured logging framework for the hybrid agent system
 * Replaces console.error with configurable, structured logging
 */

/**
 * Log levels with numeric priority
 */
export const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,  // Disable all logging
};

/**
 * ANSI color codes for terminal output
 */
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

/**
 * Patterns for sensitive data that should be masked
 */
const SENSITIVE_PATTERNS = [
  // OpenRouter API keys (sk-or-...)
  /(?:OPENROUTER_API_KEY|openrouter[_-]?key)['"=:\s]*['"]*([a-zA-Z0-9_-]{20,})['""]*/gi,
  /(sk-or-[a-zA-Z0-9_-]{10,})/gi,

  // Google/Gemini API keys
  /(?:GEMINI_API_KEY|GOOGLE_API_KEY|VERTEX_API_KEY)[=:\s]*([^\s]{10,})/gi,
  /\b(AIza[a-zA-Z0-9_-]{30,})/gi,  // Google API key pattern (capture group for masking)

  // Generic API keys (various formats: api_key=, apiKey:, "key": )
  /(?:api[_-]?key|apikey)['"=:\s]*['"]*([a-zA-Z0-9_-]{20,})['""]*/gi,

  // Bearer tokens
  /(?:bearer\s+)([a-zA-Z0-9_.-]{20,})/gi,
  /(?:authorization)['"=:\s]*['"]*(?:bearer\s+)?([a-zA-Z0-9_.-]{20,})['""]*/gi,

  // Auth tokens
  /(?:token|auth_token|access_token|refresh_token)['"=:\s]*['"]*([a-zA-Z0-9_.-]{20,})['""]*/gi,

  // Passwords
  /(?:password|passwd|pwd)['"=:\s]*['"]*([^\s'"]{4,})['""]*/gi,

  // Generic secrets and credentials
  /(?:secret|credential|private_key)['"=:\s]*['"]*([^\s'"]{8,})['""]*/gi,

  // Connection strings (mask password portion)
  /(?:mongodb|postgresql|mysql|redis):\/\/[^:]+:([^@]+)@/gi,

  // JWT tokens (mask payload)
  /(eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/gi,
];

/**
 * Mask sensitive data in a string
 * @param {string} str - String to sanitize
 * @returns {string} - String with sensitive data masked
 */
function maskSensitiveData(str) {
  if (typeof str !== 'string') {
    return str;
  }

  let masked = str;
  for (const pattern of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, (match, capture) => {
      if (capture && capture.length > 4) {
        const visible = capture.substring(0, 4);
        return match.replace(capture, `${visible}${'*'.repeat(Math.min(capture.length - 4, 16))}`);
      }
      return match;
    });
  }
  return masked;
}

/**
 * Format a log message with timestamp and level
 * @param {string} level - Log level name
 * @param {string} message - Log message
 * @param {Object} context - Additional context
 * @param {boolean} useColors - Whether to use ANSI colors
 * @returns {string} - Formatted log line
 */
function formatLogMessage(level, message, context = {}, useColors = true) {
  const timestamp = new Date().toISOString();
  const levelColors = {
    DEBUG: COLORS.gray,
    INFO: COLORS.blue,
    WARN: COLORS.yellow,
    ERROR: COLORS.red,
  };

  const color = useColors ? (levelColors[level] || '') : '';
  const reset = useColors ? COLORS.reset : '';
  const dim = useColors ? COLORS.dim : '';

  // Mask any sensitive data in message and context
  const safeMessage = maskSensitiveData(message);
  const safeContext = Object.keys(context).length > 0
    ? ` ${maskSensitiveData(JSON.stringify(context))}`
    : '';

  return `${dim}${timestamp}${reset} ${color}[${level}]${reset} ${safeMessage}${safeContext}`;
}

/**
 * Logger class with configurable levels and output
 */
class Logger {
  constructor(options = {}) {
    this.level = options.level ?? LOG_LEVELS.INFO;
    this.useColors = options.useColors ?? process.stdout.isTTY;
    this.prefix = options.prefix || '';
    this.output = options.output || process.stderr;
    this.maskSecrets = options.maskSecrets ?? true;
  }

  /**
   * Set the minimum log level
   * @param {number|string} level - Log level (number or name)
   */
  setLevel(level) {
    if (typeof level === 'string') {
      this.level = LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.INFO;
    } else {
      this.level = level;
    }
  }

  /**
   * Check if a level should be logged
   * @param {number} level - Level to check
   * @returns {boolean}
   */
  shouldLog(level) {
    return level >= this.level;
  }

  /**
   * Write a log entry
   * @param {number} level - Log level
   * @param {string} levelName - Level name
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  log(level, levelName, message, context = {}) {
    if (!this.shouldLog(level)) return;

    const prefix = this.prefix ? `[${this.prefix}] ` : '';
    const fullMessage = `${prefix}${message}`;
    const formatted = formatLogMessage(levelName, fullMessage, context, this.useColors);

    this.output.write(formatted + '\n');
  }

  /**
   * Debug level log
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  debug(message, context = {}) {
    this.log(LOG_LEVELS.DEBUG, 'DEBUG', message, context);
  }

  /**
   * Info level log
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  info(message, context = {}) {
    this.log(LOG_LEVELS.INFO, 'INFO', message, context);
  }

  /**
   * Warning level log
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  warn(message, context = {}) {
    this.log(LOG_LEVELS.WARN, 'WARN', message, context);
  }

  /**
   * Error level log
   * @param {string} message - Log message
   * @param {Object|Error} contextOrError - Additional context or Error object
   */
  error(message, contextOrError = {}) {
    let context = contextOrError;

    // Handle Error objects
    if (contextOrError instanceof Error) {
      context = {
        errorName: contextOrError.name,
        errorMessage: contextOrError.message,
        ...(contextOrError.code && { code: contextOrError.code }),
        ...(contextOrError.stack && { stack: contextOrError.stack.split('\n').slice(0, 5).join('\n') }),
      };
    }

    this.log(LOG_LEVELS.ERROR, 'ERROR', message, context);
  }

  /**
   * Create a child logger with a prefix
   * @param {string} prefix - Prefix for child logger
   * @returns {Logger}
   */
  child(prefix) {
    return new Logger({
      level: this.level,
      useColors: this.useColors,
      prefix: this.prefix ? `${this.prefix}:${prefix}` : prefix,
      output: this.output,
      maskSecrets: this.maskSecrets,
    });
  }

  /**
   * Time an operation
   * @param {string} label - Label for the operation
   * @returns {{ end: Function }} - Object with end() method to log duration
   */
  time(label) {
    const start = Date.now();
    return {
      end: () => {
        const duration = Date.now() - start;
        this.debug(`${label} completed`, { durationMs: duration });
      },
    };
  }
}

/**
 * Global logger instance
 */
let globalLogger = new Logger();

/**
 * Get the global logger instance
 * @returns {Logger}
 */
export function getLogger() {
  return globalLogger;
}

/**
 * Configure the global logger
 * @param {Object} options - Logger options
 */
export function configureLogger(options) {
  globalLogger = new Logger(options);
}

/**
 * Create a new logger instance
 * @param {Object} options - Logger options
 * @returns {Logger}
 */
export function createLogger(options) {
  return new Logger(options);
}

/**
 * Convenience exports for direct use
 */
export const debug = (msg, ctx) => globalLogger.debug(msg, ctx);
export const info = (msg, ctx) => globalLogger.info(msg, ctx);
export const warn = (msg, ctx) => globalLogger.warn(msg, ctx);
export const error = (msg, ctx) => globalLogger.error(msg, ctx);

export { Logger, maskSensitiveData };

export default {
  LOG_LEVELS,
  Logger,
  getLogger,
  configureLogger,
  createLogger,
  maskSensitiveData,
  debug,
  info,
  warn,
  error,
};
