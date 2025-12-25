/**
 * Environment file utilities
 *
 * Shared utilities for loading and parsing .env files.
 * Extracted from multiple locations to eliminate code duplication.
 */

import { readFileSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// Module-level cache for loaded env files (prevents repeated file reads)
const envCache = new Map();
const ENV_CACHE_TTL = 30000; // 30 seconds cache TTL

/**
 * Clear the env file cache (useful for tests and hot reloading)
 */
export function clearEnvCache() {
  envCache.clear();
}

/**
 * Parse .env file content into an object
 * @param {string} content - File content
 * @returns {Object} - Parsed environment variables
 */
function parseEnvContent(content) {
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      let value = match[2].trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[match[1].trim()] = value;
    }
  }
  return env;
}

/**
 * Get the list of paths to search for .env files
 * @param {string} [baseDir] - Base directory (defaults to cwd)
 * @param {string} [projectRoot] - Project root directory (for system-wide MCP use)
 * @returns {string[]} - Array of paths to check
 */
export function getEnvFilePaths(baseDir = process.cwd(), projectRoot = null) {
  const paths = [];

  // 1. Check GEMINI_WORKER_ROOT env var (can be set in Claude settings.json)
  if (process.env.GEMINI_WORKER_ROOT) {
    paths.push(join(process.env.GEMINI_WORKER_ROOT, '.env'));
    paths.push(join(process.env.GEMINI_WORKER_ROOT, '.env.local'));
  }

  // 2. Check project root (where the script lives)
  if (projectRoot && projectRoot !== baseDir) {
    paths.push(join(projectRoot, '.env'));
    paths.push(join(projectRoot, '.env.local'));
  }

  // 3. Check base directory (cwd)
  paths.push(join(baseDir, '.env'));
  paths.push(join(baseDir, '.env.local'));

  // 4. Check home directory
  paths.push(join(homedir(), '.env.gemini'));

  return paths;
}

/**
 * Load environment variables from .env file (synchronous)
 *
 * Searches in order:
 * 1. GEMINI_WORKER_ROOT/.env (if env var set)
 * 2. <projectRoot>/.env (if different from baseDir)
 * 3. <baseDir>/.env
 * 4. ~/.env.gemini
 *
 * System environment variables take precedence.
 *
 * @param {string} [baseDir] - Base directory to search from
 * @param {string} [projectRoot] - Project root directory (for system-wide MCP use)
 * @returns {Object} - Loaded environment variables
 */
export function loadEnvFileSync(baseDir = process.cwd(), projectRoot = null) {
  // Generate cache key based on search paths
  const cacheKey = `${baseDir}:${projectRoot || ''}`;

  // Check cache first
  const cached = envCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ENV_CACHE_TTL) {
    return cached.env;
  }

  const paths = getEnvFilePaths(baseDir, projectRoot);
  let env = {};

  for (const envPath of paths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        env = { ...env, ...parseEnvContent(content) };
      } catch (e) {
        // Ignore read errors
      }
    }
  }

  // Cache the result
  envCache.set(cacheKey, { env, timestamp: Date.now() });

  return env;
}

/**
 * Load environment variables from .env file (asynchronous)
 *
 * Searches in order:
 * 1. GEMINI_WORKER_ROOT/.env (if env var set)
 * 2. <projectRoot>/.env (if different from baseDir)
 * 3. <baseDir>/.env
 * 4. ~/.env.gemini
 *
 * System environment variables take precedence.
 *
 * @param {string} [baseDir] - Base directory to search from
 * @param {string} [projectRoot] - Project root directory (for system-wide MCP use)
 * @returns {Promise<Object>} - Loaded environment variables
 */
export async function loadEnvFile(baseDir = process.cwd(), projectRoot = null) {
  const paths = getEnvFilePaths(baseDir, projectRoot);
  let env = {};

  for (const envPath of paths) {
    try {
      const content = await readFile(envPath, 'utf-8');
      env = { ...env, ...parseEnvContent(content) };
    } catch (e) {
      // File doesn't exist or can't be read, continue
    }
  }

  return env;
}

/**
 * Get a specific environment variable with fallback to .env file
 * @param {string} key - Environment variable name
 * @param {string} [defaultValue] - Default value if not found
 * @param {string} [baseDir] - Base directory for .env search
 * @param {string} [projectRoot] - Project root directory
 * @returns {string|undefined} - Value or default
 */
export function getEnvVar(key, defaultValue = undefined, baseDir = process.cwd(), projectRoot = null) {
  // System env takes precedence
  if (process.env[key]) {
    return process.env[key];
  }

  // Check .env files
  const env = loadEnvFileSync(baseDir, projectRoot);
  return env[key] || defaultValue;
}

/**
 * Load .env and merge with process.env (system env takes precedence)
 * @param {string} [baseDir] - Base directory for .env search
 * @param {string} [projectRoot] - Project root directory
 * @returns {Object} - Merged environment
 */
export function getMergedEnv(baseDir = process.cwd(), projectRoot = null) {
  const fileEnv = loadEnvFileSync(baseDir, projectRoot);
  return { ...fileEnv, ...process.env };
}

/**
 * Load .env file and apply to process.env (system env takes precedence)
 * This modifies process.env in place.
 *
 * @param {string} [baseDir] - Base directory for .env search
 * @param {Object} [options] - Options
 * @param {boolean} [options.silent] - Don't log which files are loaded
 * @param {string} [options.projectRoot] - Project root directory (for system-wide MCP use)
 * @returns {string[]} - List of files that were loaded
 */
export function applyEnvFile(baseDir = process.cwd(), options = {}) {
  const { silent = false, projectRoot = null } = options;
  const paths = getEnvFilePaths(baseDir, projectRoot);
  const loadedFiles = [];

  for (const envPath of paths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        const env = parseEnvContent(content);

        // Apply to process.env (system env takes precedence)
        for (const [key, value] of Object.entries(env)) {
          if (process.env[key] === undefined) {
            process.env[key] = value;
          }
        }

        loadedFiles.push(envPath);
        if (!silent) {
          console.error(`[env] Loaded: ${envPath}`);
        }
      } catch (e) {
        // Silently ignore read errors
      }
    }
  }

  return loadedFiles;
}

// Legacy alias for backwards compatibility
export { loadEnvFileSync as loadEnvFile_sync };

export default {
  loadEnvFile,
  loadEnvFileSync,
  getEnvVar,
  getMergedEnv,
  getEnvFilePaths,
  applyEnvFile,
};
