/**
 * Response Cache
 *
 * Caches Gemini CLI responses to avoid repeated queries.
 *
 * Features:
 * - TTL-based expiration
 * - LRU eviction when cache is full
 * - Cache key generation from prompt + model
 * - Statistics tracking
 * - Optional persistence (file-based)
 */

import { createHash } from 'crypto';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  maxEntries: 1000,              // Max cached responses
  defaultTTL: 30 * 60 * 1000,    // 30 minutes default TTL
  maxTTL: 24 * 60 * 60 * 1000,   // 24 hours max TTL
  cleanupInterval: 5 * 60 * 1000, // Cleanup every 5 minutes
  persistPath: null,              // Path for persistence (disabled by default)
  persistDebounceMs: 5000,        // Debounce persistence writes (5 seconds)
};

/**
 * Response Cache Class
 */
export class ResponseCache {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new Map();
    this.accessOrder = []; // For LRU eviction
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0,
    };

    // Debounce timer for persistence
    this.persistTimer = null;
    this.persistPending = false;

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);

    // Load persisted cache if configured
    if (this.config.persistPath) {
      this.loadFromDisk().catch(() => {
        // Ignore load errors on startup
      });
    }
  }

  /**
   * Schedule debounced persistence
   * Multiple calls within the debounce window will be coalesced into one write
   */
  schedulePersist() {
    if (!this.config.persistPath) return;

    this.persistPending = true;

    // Clear existing timer
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    // Schedule new write
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.persistPending) {
        this.persistPending = false;
        this.saveToDisk().catch(() => {
          // Ignore save errors
        });
      }
    }, this.config.persistDebounceMs);
  }

  /**
   * Generate cache key from prompt and options
   */
  generateKey(prompt, options = {}) {
    const keyData = JSON.stringify({
      prompt: prompt.trim(),
      model: options.model || 'default',
    });
    return createHash('sha256').update(keyData).digest('hex').slice(0, 16);
  }

  /**
   * Get cached response
   * @param {string} prompt - The prompt
   * @param {Object} options - Options including model
   * @returns {string|null} Cached response or null
   */
  get(prompt, options = {}) {
    const key = this.generateKey(prompt, options);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      this.stats.expirations++;
      this.stats.misses++;
      return null;
    }

    // Update access order for LRU
    this.updateAccessOrder(key);
    this.stats.hits++;

    return entry.response;
  }

  /**
   * Set cached response
   * @param {string} prompt - The prompt
   * @param {string} response - The response to cache
   * @param {Object} options - Options including model and ttl
   */
  set(prompt, response, options = {}) {
    const key = this.generateKey(prompt, options);
    const ttl = Math.min(options.ttl || this.config.defaultTTL, this.config.maxTTL);

    // Evict if at capacity
    while (this.cache.size >= this.config.maxEntries) {
      this.evictOldest();
    }

    const entry = {
      prompt: prompt.slice(0, 200), // Store truncated prompt for debugging
      response,
      model: options.model || 'default',
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
      ttl,
    };

    this.cache.set(key, entry);
    this.updateAccessOrder(key);

    // Schedule debounced persistence
    this.schedulePersist();
  }

  /**
   * Check if a prompt is cached (without updating stats)
   */
  has(prompt, options = {}) {
    const key = this.generateKey(prompt, options);
    const entry = this.cache.get(key);
    return entry && Date.now() <= entry.expiresAt;
  }

  /**
   * Invalidate a specific cache entry
   */
  invalidate(prompt, options = {}) {
    const key = this.generateKey(prompt, options);
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      return true;
    }
    return false;
  }

  /**
   * Clear all cache entries
   */
  clear() {
    const count = this.cache.size;
    this.cache.clear();
    this.accessOrder = [];
    return count;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(1)
      : 0;

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      size: this.cache.size,
      maxEntries: this.config.maxEntries,
      defaultTTL: this.config.defaultTTL,
    };
  }

  /**
   * Update access order for LRU
   */
  updateAccessOrder(key) {
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  /**
   * Remove from access order
   */
  removeFromAccessOrder(key) {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Evict oldest entry (LRU)
   */
  evictOldest() {
    if (this.accessOrder.length === 0) return;

    const oldestKey = this.accessOrder.shift();
    this.cache.delete(oldestKey);
    this.stats.evictions++;
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        this.removeFromAccessOrder(key);
        this.stats.expirations++;
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Save cache to disk (persistence)
   */
  async saveToDisk() {
    if (!this.config.persistPath) return;

    const cacheDir = this.config.persistPath;
    const cacheFile = join(cacheDir, 'response-cache.json');

    try {
      await mkdir(cacheDir, { recursive: true });

      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        entries: Array.from(this.cache.entries()),
      };

      await writeFile(cacheFile, JSON.stringify(data), 'utf-8');
    } catch (error) {
      console.error('[Cache] Failed to save:', error.message);
    }
  }

  /**
   * Synchronous save - used during shutdown
   * Uses sync methods to ensure completion before process exit
   */
  persistSync() {
    if (!this.config.persistPath) return;
    if (this.cache.size === 0) return;

    const cacheDir = this.config.persistPath;
    const cacheFile = join(cacheDir, 'response-cache.json');

    try {
      mkdirSync(cacheDir, { recursive: true });

      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        entries: Array.from(this.cache.entries()),
      };

      writeFileSync(cacheFile, JSON.stringify(data), 'utf-8');
      console.error(`[Cache] Persisted ${this.cache.size} entries to disk`);
    } catch (error) {
      console.error('[Cache] Failed to persist sync:', error.message);
    }
  }

  /**
   * Load cache from disk
   */
  async loadFromDisk() {
    if (!this.config.persistPath) return;

    const cacheFile = join(this.config.persistPath, 'response-cache.json');

    try {
      const content = await readFile(cacheFile, 'utf-8');
      const data = JSON.parse(content);

      if (data.version !== 1) return;

      const now = Date.now();
      for (const [key, entry] of data.entries) {
        // Only load non-expired entries
        if (entry.expiresAt > now) {
          this.cache.set(key, entry);
          this.accessOrder.push(key);
        }
      }

      console.error(`[Cache] Loaded ${this.cache.size} entries from disk`);
    } catch (error) {
      // File doesn't exist or is invalid
    }
  }

  /**
   * Cleanup on shutdown
   */
  async destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    if (this.config.persistPath) {
      await this.saveToDisk();
    }

    this.cache.clear();
    this.accessOrder = [];
  }
}

// Singleton instance
let instance = null;

export function getResponseCache(config = {}) {
  if (!instance) {
    instance = new ResponseCache(config);
  }
  return instance;
}

export default ResponseCache;
