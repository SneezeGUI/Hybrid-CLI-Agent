/**
 * Simple file content cache with mtime-based invalidation
 * Used for caching context files to avoid re-reading unchanged files
 * @module utils/file-cache
 */

import { stat, readFile } from 'fs/promises';
import { join, resolve } from 'path';

/**
 * File cache entry
 * @typedef {Object} FileCacheEntry
 * @property {string} content - File content
 * @property {number} mtime - File modification time (ms since epoch)
 * @property {number} cachedAt - When entry was cached (ms since epoch)
 */

/**
 * Simple file content cache with LRU eviction and mtime-based invalidation
 */
export class FileContentCache {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxEntries=100] - Maximum cache entries
   * @param {number} [options.ttlMs=30000] - Time-to-live in milliseconds (default: 30s)
   */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries || 100;
    this.ttlMs = options.ttlMs || 30000; // 30 seconds default
    /** @type {Map<string, FileCacheEntry>} */
    this.cache = new Map();
  }

  /**
   * Generate a cache key for a file path
   * @param {string} filePath - Absolute file path
   * @returns {string} Cache key
   */
  getCacheKey(filePath) {
    return resolve(filePath).toLowerCase(); // Normalize for Windows
  }

  /**
   * Check if a cached entry is still valid
   * @param {FileCacheEntry} entry - Cache entry
   * @param {number} currentMtime - Current file mtime
   * @returns {boolean} True if entry is valid
   */
  isEntryValid(entry, currentMtime) {
    const now = Date.now();
    // Check TTL
    if (now - entry.cachedAt > this.ttlMs) {
      return false;
    }
    // Check mtime
    if (entry.mtime !== currentMtime) {
      return false;
    }
    return true;
  }

  /**
   * Get file content from cache or read from disk
   * @param {string} filePath - Absolute file path
   * @returns {Promise<{content: string, fromCache: boolean}|null>} File content or null if not found
   */
  async getFile(filePath) {
    const key = this.getCacheKey(filePath);

    try {
      // Get current file stats
      const stats = await stat(filePath);
      if (!stats.isFile()) {
        return null;
      }

      const currentMtime = stats.mtimeMs;

      // Check cache
      const cached = this.cache.get(key);
      if (cached && this.isEntryValid(cached, currentMtime)) {
        // Move to end of map (LRU update)
        this.cache.delete(key);
        this.cache.set(key, cached);
        return { content: cached.content, fromCache: true };
      }

      // Read file
      const content = await readFile(filePath, 'utf-8');

      // Cache the result
      this.set(key, {
        content,
        mtime: currentMtime,
        cachedAt: Date.now(),
      });

      return { content, fromCache: false };
    } catch {
      return null;
    }
  }

  /**
   * Set a cache entry with LRU eviction
   * @param {string} key - Cache key
   * @param {FileCacheEntry} entry - Cache entry
   */
  set(key, entry) {
    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, entry);
  }

  /**
   * Invalidate a specific file
   * @param {string} filePath - File path to invalidate
   */
  invalidate(filePath) {
    const key = this.getCacheKey(filePath);
    this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   * @returns {{size: number, maxEntries: number, ttlMs: number}}
   */
  getStats() {
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
    };
  }
}

// Singleton instance for context file caching
let contextFileCache = null;

/**
 * Get the singleton context file cache
 * @param {Object} [options] - Options (only used on first call)
 * @returns {FileContentCache}
 */
export function getContextFileCache(options) {
  if (!contextFileCache) {
    contextFileCache = new FileContentCache(options);
  }
  return contextFileCache;
}

/**
 * Reset the singleton cache (mainly for testing)
 */
export function resetContextFileCache() {
  if (contextFileCache) {
    contextFileCache.clear();
    contextFileCache = null;
  }
}

export default {
  FileContentCache,
  getContextFileCache,
  resetContextFileCache,
};
