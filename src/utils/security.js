/**
 * Security utilities for input validation and sanitization
 * Prevents command injection and path traversal attacks
 */

import { resolve, normalize, relative, isAbsolute, basename, dirname } from 'path';
import { stat } from 'fs/promises';
import { TIMEOUTS as CONFIG_TIMEOUTS } from '../config/index.js';

// ============================================================================
// Protected Files and Directories
// ============================================================================

/**
 * Files that should NEVER be overwritten by automated tools
 * These are critical configuration, security, and system files
 */
export const PROTECTED_FILES = new Set([
  // Package management
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',

  // Environment and secrets
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.staging',
  '.env.gemini',
  'credentials.json',
  'secrets.json',
  'service-account.json',

  // Configuration files
  'tsconfig.json',
  'jsconfig.json',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.json',
  'babel.config.js',
  'webpack.config.js',
  'vite.config.js',
  'rollup.config.js',

  // Git
  '.gitignore',
  '.gitattributes',

  // CI/CD
  '.travis.yml',
  '.github/workflows/*',
  'Dockerfile',
  'docker-compose.yml',

  // Project documentation
  'LICENSE',
  'LICENSE.md',
  'CHANGELOG.md',
]);

/**
 * Directory patterns that should be protected from writes
 * Uses simple string matching (startsWith)
 */
export const PROTECTED_DIRECTORIES = [
  // Package directories
  'node_modules/',
  'vendor/',

  // Version control
  '.git/',
  '.svn/',
  '.hg/',

  // IDE/Editor
  '.vscode/',
  '.idea/',

  // Claude Code configuration
  '.claude/',

  // Build outputs (usually shouldn't write directly)
  'dist/',
  'build/',
  'out/',

  // This project's critical directories (prevent self-modification)
  'src/mcp/',
  'src/utils/',
  'src/services/',
  'src/adapters/',
  'src/orchestrator/',
  'bin/',
];

/**
 * File extensions that are dangerous to write (could be executed)
 */
export const DANGEROUS_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.bash',
  '.dll',
  '.so',
  '.dylib',
]);

/**
 * Validates and sanitizes a file path to prevent path traversal
 * @param {string} inputPath - The user-provided path
 * @param {string} baseDir - The allowed base directory (defaults to cwd)
 * @returns {string|null} - Sanitized absolute path or null if invalid
 */
export function sanitizePath(inputPath, baseDir = process.cwd()) {
  if (!inputPath || typeof inputPath !== 'string') {
    return null;
  }

  // Normalize and resolve the path
  const normalizedBase = normalize(resolve(baseDir));
  const resolvedPath = normalize(resolve(baseDir, inputPath));

  // Check if the resolved path is within the base directory
  const relativePath = relative(normalizedBase, resolvedPath);

  // If relative path starts with '..' or is absolute, it's outside baseDir
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }

  return resolvedPath;
}

/**
 * Check if a file path is safe for writing
 * Validates against protected files, directories, and dangerous extensions
 * @param {string} filePath - The file path to check (can be relative or absolute)
 * @param {string} baseDir - The base directory for relative paths
 * @returns {{ allowed: boolean, reason?: string }} - Whether write is allowed and why not
 */
export function isWriteAllowed(filePath, baseDir = process.cwd()) {
  if (!filePath || typeof filePath !== 'string') {
    return { allowed: false, reason: 'Invalid file path' };
  }

  // First, sanitize the path to ensure it's within bounds
  const sanitized = sanitizePath(filePath, baseDir);
  if (!sanitized) {
    return { allowed: false, reason: 'Path traversal attempt detected' };
  }

  // Get the relative path for checking against protected patterns
  const normalizedBase = normalize(resolve(baseDir));
  const relativePath = relative(normalizedBase, sanitized).replace(/\\/g, '/');
  const fileName = basename(sanitized);
  const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';

  // Check against protected files (exact match)
  if (PROTECTED_FILES.has(fileName)) {
    return { allowed: false, reason: `Protected file: ${fileName}` };
  }

  // Check if path starts with any protected directory
  for (const protectedDir of PROTECTED_DIRECTORIES) {
    const normalizedProtected = protectedDir.replace(/\\/g, '/');
    if (relativePath.startsWith(normalizedProtected) ||
        relativePath.startsWith(normalizedProtected.slice(0, -1))) {
      return { allowed: false, reason: `Protected directory: ${protectedDir}` };
    }
  }

  // Check for dangerous extensions
  if (DANGEROUS_EXTENSIONS.has(ext.toLowerCase())) {
    return { allowed: false, reason: `Dangerous file extension: ${ext}` };
  }

  // Check for hidden files (starting with .) that look like config
  if (fileName.startsWith('.') && !fileName.startsWith('.test')) {
    // Allow some hidden files that are commonly needed
    const allowedHiddenPatterns = ['.test', '.spec', '.mock', '.fixture', '.sample', '.example'];
    if (!allowedHiddenPatterns.some(p => fileName.includes(p))) {
      return { allowed: false, reason: `Hidden/config file: ${fileName}` };
    }
  }

  return { allowed: true };
}

/**
 * Get a list of allowed directories for code generation
 * These are common source directories where generated code should go
 */
export function getAllowedWriteDirectories() {
  return [
    'src/',
    'lib/',
    'app/',
    'pages/',
    'components/',
    'features/',
    'modules/',
    'api/',
    'routes/',
    'controllers/',
    'models/',
    'views/',
    'templates/',
    'test/',
    'tests/',
    '__tests__/',
    'spec/',
    'examples/',
    'demo/',
    'scripts/',
    'tools/',
    'public/',
    'static/',
    'assets/',
  ];
}

/**
 * Validates a directory path exists and is within allowed bounds
 * @param {string} dirPath - Directory path to validate
 * @param {string} baseDir - Allowed base directory
 * @returns {Promise<string|null>} - Validated path or null
 */
export async function validateDirectory(dirPath, baseDir = process.cwd()) {
  const sanitized = sanitizePath(dirPath, baseDir);
  if (!sanitized) {
    return null;
  }

  try {
    const stats = await stat(sanitized);
    if (!stats.isDirectory()) {
      return null;
    }
    return sanitized;
  } catch {
    return null;
  }
}

/**
 * Validates a file path exists and is within allowed bounds
 * @param {string} filePath - File path to validate
 * @param {string} baseDir - Allowed base directory
 * @returns {Promise<string|null>} - Validated path or null
 */
export async function validateFile(filePath, baseDir = process.cwd()) {
  const sanitized = sanitizePath(filePath, baseDir);
  if (!sanitized) {
    return null;
  }

  try {
    const stats = await stat(sanitized);
    if (!stats.isFile()) {
      return null;
    }
    return sanitized;
  } catch {
    return null;
  }
}

/**
 * Sanitizes glob patterns to prevent traversal
 * @param {string[]} patterns - Array of glob patterns
 * @param {string} baseDir - Allowed base directory
 * @returns {string[]} - Sanitized patterns (removes dangerous ones)
 */
export function sanitizeGlobPatterns(patterns, baseDir = process.cwd()) {
  if (!Array.isArray(patterns)) {
    return [];
  }

  return patterns.filter(pattern => {
    if (typeof pattern !== 'string') return false;

    // Reject patterns that try to escape
    if (pattern.includes('..')) return false;

    // Reject absolute paths
    if (isAbsolute(pattern)) return false;

    // Reject patterns starting with / or \
    if (pattern.startsWith('/') || pattern.startsWith('\\')) return false;

    return true;
  });
}

/**
 * Sanitizes command arguments using WHITELIST approach
 * Only allows alphanumeric characters and safe symbols
 * @param {string} arg - Command argument to sanitize
 * @param {Object} options - Sanitization options
 * @param {boolean} options.allowPaths - Allow path separators (/ and \)
 * @param {boolean} options.allowGlobs - Allow glob characters (* and ?)
 * @param {boolean} options.allowSpaces - Allow spaces (dangerous in shell)
 * @returns {string} - Sanitized argument
 */
export function sanitizeCommandArg(arg, options = {}) {
  if (typeof arg !== 'string') {
    return '';
  }

  const {
    allowPaths = false,
    allowGlobs = false,
    allowSpaces = false,
  } = options;

  // Build whitelist pattern based on options
  // Base: alphanumeric, dash, underscore, dot
  let pattern = 'a-zA-Z0-9_.\\-';

  if (allowPaths) {
    pattern += '\\\\/';  // Add forward and back slash
  }

  if (allowGlobs) {
    pattern += '*?';  // Add glob characters
  }

  if (allowSpaces) {
    pattern += ' ';  // Add space
  }

  // Replace anything NOT in whitelist with empty string
  const regex = new RegExp(`[^${pattern}]`, 'g');
  return arg.replace(regex, '');
}

/**
 * Validate a command argument strictly - returns null if invalid
 * Use this for critical security contexts where you want to reject bad input
 * @param {string} arg - Argument to validate
 * @param {RegExp} allowedPattern - Pattern of allowed characters
 * @returns {string|null} - Original string if valid, null if invalid
 */
export function validateCommandArg(arg, allowedPattern = /^[a-zA-Z0-9_.\-]+$/) {
  if (typeof arg !== 'string' || !arg) {
    return null;
  }

  if (!allowedPattern.test(arg)) {
    return null;
  }

  return arg;
}

/**
 * Validates git-safe file patterns (no shell injection)
 * @param {string[]} patterns - File patterns for git commands
 * @returns {string[]} - Safe patterns only
 */
export function sanitizeGitPatterns(patterns) {
  if (!Array.isArray(patterns)) {
    return [];
  }

  return patterns.filter(pattern => {
    if (typeof pattern !== 'string') return false;

    // Only allow alphanumeric, dots, dashes, underscores, slashes, and wildcards
    const safePattern = /^[a-zA-Z0-9._\-/*]+$/;
    return safePattern.test(pattern);
  });
}

/**
 * Creates a spawn wrapper with timeout support
 * @param {Function} spawn - The spawn function from child_process
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {Object} options - Spawn options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 60000)
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export function spawnWithTimeout(spawn, command, args, options = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, options);

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 5000);

      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
    }

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (!killed) {
        resolve({ stdout, stderr, code });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (!killed) {
        reject(err);
      }
    });
  });
}

/**
 * Default timeout values (in milliseconds)
 * Re-exported from centralized config for backward compatibility
 */
export const TIMEOUTS = CONFIG_TIMEOUTS;

/**
 * Commands that are batch scripts on Windows (.cmd files)
 * These need special handling via cmd.exe /c
 */
const WINDOWS_CMD_COMMANDS = new Set([
  'gemini',
  'claude',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'git',  // Also commonly a .cmd on Windows
]);

/**
 * Resolve the command to use based on platform
 * On Windows, we may need to use .cmd or .exe extensions
 * @param {string} command - The command name
 * @returns {string} - Platform-appropriate command
 */
export function resolveCommand(command) {
  // For Windows .cmd files, we now handle them in safeSpawn via cmd.exe
  // Just return the command as-is
  return command;
}

/**
 * Safe spawn wrapper that NEVER uses shell: true
 * This prevents command injection attacks
 * On Windows, .cmd files are spawned via cmd.exe /c to avoid EINVAL errors
 * @param {Function} spawn - The spawn function from child_process
 * @param {string} command - Command to run (will be resolved for platform)
 * @param {string[]} args - Command arguments (will be validated)
 * @param {Object} options - Spawn options (shell: true will be overridden)
 * @returns {import('child_process').ChildProcess}
 */
export function safeSpawn(spawn, command, args = [], options = {}) {
  // CRITICAL: Force shell to false to prevent command injection
  const safeOptions = {
    ...options,
    shell: false,  // NEVER allow shell execution
    windowsHide: true,  // Hide window on Windows
  };

  // Ensure args is an array of strings
  const safeArgs = Array.isArray(args)
    ? args.filter(arg => typeof arg === 'string')
    : [];

  const isWindows = process.platform === 'win32';

  // On Windows, .cmd files can't be spawned directly with shell: false
  // We spawn cmd.exe /c <command> <args> instead - this is safe because
  // arguments are passed as an array, not a string
  if (isWindows && WINDOWS_CMD_COMMANDS.has(command)) {
    return spawn('cmd.exe', ['/c', command, ...safeArgs], safeOptions);
  }

  return spawn(command, safeArgs, safeOptions);
}

/**
 * Safe spawn with timeout and promise wrapper
 * @param {Function} spawn - The spawn function from child_process
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {Object} options - Spawn options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 60000)
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export function safeSpawnWithTimeout(spawn, command, args, options = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    // Use safeSpawn to ensure no shell execution
    const proc = safeSpawn(spawn, command, args, options);

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 5000);

      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
    }

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (!killed) {
        resolve({ stdout, stderr, code });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (!killed) {
        reject(err);
      }
    });
  });
}

// ============================================================================
// Agent Mode Security
// ============================================================================

/**
 * Check if Gemini agent mode is enabled
 *
 * Agent mode allows Gemini to execute shell commands and modify files directly.
 * This is disabled by default for security and must be explicitly enabled
 * via the GEMINI_AGENT_MODE environment variable.
 *
 * @returns {boolean} True if agent mode is enabled
 */
export function isAgentModeEnabled() {
  return process.env.GEMINI_AGENT_MODE === 'true';
}

export default {
  // Path validation
  sanitizePath,
  validateDirectory,
  validateFile,
  isWriteAllowed,
  getAllowedWriteDirectories,
  // Protected resources
  PROTECTED_FILES,
  PROTECTED_DIRECTORIES,
  DANGEROUS_EXTENSIONS,
  // Input sanitization
  sanitizeGlobPatterns,
  sanitizeCommandArg,
  validateCommandArg,
  sanitizeGitPatterns,
  // Safe execution
  resolveCommand,
  safeSpawn,
  safeSpawnWithTimeout,
  spawnWithTimeout,
  TIMEOUTS,
  // Agent mode
  isAgentModeEnabled,
};
