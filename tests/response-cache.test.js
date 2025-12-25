/**
 * Tests for ResponseCache service
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import ResponseCache from '../src/services/response-cache.js';

describe('ResponseCache', () => {
  let cache;
  let testDir;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testDir = join(tmpdir(), `cache-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
    // Clean up temp directory
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Constructor & Configuration', () => {
    it('should initialize with default configuration', () => {
      cache = new ResponseCache();
      const stats = cache.getStats();

      assert.strictEqual(stats.size, 0);
      assert.strictEqual(stats.hits, 0);
      assert.strictEqual(stats.misses, 0);
      assert.strictEqual(stats.maxEntries, 1000); // Default from code
    });

    it('should accept custom configuration', () => {
      cache = new ResponseCache({
        maxEntries: 50,
        defaultTTL: 1000
      });
      const stats = cache.getStats();

      assert.strictEqual(stats.maxEntries, 50);
      assert.strictEqual(stats.defaultTTL, 1000);
    });

    it('should NOT load from disk if persistPath is not set', async () => {
      cache = new ResponseCache({ persistPath: null });

      // Wait briefly for any async init
      await new Promise(resolve => setTimeout(resolve, 10));

      // Cache should be empty
      assert.strictEqual(cache.getStats().size, 0);
    });
  });

  describe('get/set operations', () => {
    beforeEach(() => {
      cache = new ResponseCache();
    });

    it('should store and retrieve items', () => {
      const prompt = 'hello world';
      const response = 'hello there';

      cache.set(prompt, response);
      const result = cache.get(prompt);

      assert.strictEqual(result, response);
      assert.strictEqual(cache.getStats().hits, 1);
    });

    it('should return null for non-existent keys (cache miss)', () => {
      const result = cache.get('non-existent');

      assert.strictEqual(result, null);
      assert.strictEqual(cache.getStats().misses, 1);
    });

    it('should return null for expired items and update stats', async () => {
      const prompt = 'expired';
      const response = 'value';
      const ttl = 50; // 50ms TTL

      cache.set(prompt, response, { ttl });

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, ttl + 20));

      const result = cache.get(prompt);

      assert.strictEqual(result, null);
      assert.strictEqual(cache.getStats().expirations, 1);
      assert.strictEqual(cache.getStats().misses, 1);
    });

    it('should update value when setting same key', () => {
      const prompt = 'update me';
      cache.set(prompt, 'value 1');
      assert.strictEqual(cache.get(prompt), 'value 1');

      cache.set(prompt, 'value 2');
      assert.strictEqual(cache.get(prompt), 'value 2');
      assert.strictEqual(cache.getStats().size, 1);
    });

    it('should handle different models as different cache entries', () => {
      const prompt = 'same prompt';
      cache.set(prompt, 'response 1', { model: 'model-a' });
      cache.set(prompt, 'response 2', { model: 'model-b' });

      assert.strictEqual(cache.get(prompt, { model: 'model-a' }), 'response 1');
      assert.strictEqual(cache.get(prompt, { model: 'model-b' }), 'response 2');
      assert.strictEqual(cache.getStats().size, 2);
    });
  });

  describe('has/invalidate/clear', () => {
    beforeEach(() => {
      cache = new ResponseCache();
    });

    it('has should return true for existing non-expired entries', () => {
      cache.set('key', 'val');
      assert.strictEqual(cache.has('key'), true);
    });

    it('has should return falsy for missing entries', () => {
      assert.ok(!cache.has('missing'));
    });

    it('has should return falsy for expired entries', async () => {
      cache.set('key', 'val', { ttl: 30 });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(!cache.has('key'));
    });

    it('invalidate should remove specific entry', () => {
      cache.set('key', 'val');
      const removed = cache.invalidate('key');

      assert.strictEqual(removed, true);
      assert.ok(!cache.has('key'));
      assert.strictEqual(cache.getStats().size, 0);
    });

    it('invalidate should return false for non-existent key', () => {
      const removed = cache.invalidate('non-existent');
      assert.strictEqual(removed, false);
    });

    it('clear should empty the cache', () => {
      cache.set('k1', 'v1');
      cache.set('k2', 'v2');

      assert.strictEqual(cache.getStats().size, 2);

      const count = cache.clear();

      assert.strictEqual(count, 2);
      assert.strictEqual(cache.getStats().size, 0);
      assert.ok(!cache.has('k1'));
    });
  });

  describe('LRU Eviction', () => {
    it('should evict oldest entry when cache is full', () => {
      cache = new ResponseCache({ maxEntries: 2 });

      cache.set('1', 'one');
      cache.set('2', 'two');

      // Cache is full [1, 2]
      assert.strictEqual(cache.getStats().size, 2);

      // Add third item
      cache.set('3', 'three');

      // Should have evicted '1' (oldest inserted)
      assert.strictEqual(cache.getStats().size, 2);
      assert.ok(!cache.has('1'));
      assert.ok(cache.has('2'));
      assert.ok(cache.has('3'));
      assert.strictEqual(cache.getStats().evictions, 1);
    });

    it('should update access order so recently accessed items are not evicted', () => {
      cache = new ResponseCache({ maxEntries: 2 });

      cache.set('1', 'one');
      cache.set('2', 'two');

      // Access '1', making it the most recently used
      cache.get('1');
      // Order is now [2, 1]

      // Add '3'
      cache.set('3', 'three');

      // Should have evicted '2' (LRU), kept '1'
      assert.ok(!cache.has('2'));
      assert.ok(cache.has('1'));
      assert.ok(cache.has('3'));
    });

    it('should handle multiple evictions', () => {
      cache = new ResponseCache({ maxEntries: 3 });

      cache.set('1', 'one');
      cache.set('2', 'two');
      cache.set('3', 'three');
      cache.set('4', 'four');
      cache.set('5', 'five');

      assert.strictEqual(cache.getStats().size, 3);
      assert.strictEqual(cache.getStats().evictions, 2);
      assert.ok(!cache.has('1'));
      assert.ok(!cache.has('2'));
      assert.ok(cache.has('3'));
    });
  });

  describe('Stats', () => {
    beforeEach(() => {
      cache = new ResponseCache();
    });

    it('should calculate stats correctly', () => {
      cache.set('hit', 'val');

      cache.get('hit'); // hit
      cache.get('hit'); // hit
      cache.get('miss'); // miss
      cache.get('miss'); // miss

      const stats = cache.getStats();

      assert.strictEqual(stats.hits, 2);
      assert.strictEqual(stats.misses, 2);
      assert.strictEqual(stats.hitRate, '50.0%');
      assert.strictEqual(stats.size, 1);
    });

    it('should handle zero hits/misses for hitRate', () => {
      const stats = cache.getStats();
      assert.ok(stats.hitRate === '0%' || stats.hitRate === 'N/A');
    });

    it('should include all expected stat fields', () => {
      const stats = cache.getStats();

      assert.ok('hits' in stats);
      assert.ok('misses' in stats);
      assert.ok('expirations' in stats);
      assert.ok('evictions' in stats);
      assert.ok('size' in stats);
      assert.ok('maxEntries' in stats);
      assert.ok('hitRate' in stats);
    });
  });

  describe('Persistence', () => {
    it('saveToDisk should write cache to file', async () => {
      cache = new ResponseCache({ persistPath: testDir });
      cache.set('key', 'value');

      await cache.saveToDisk();

      const cacheFile = join(testDir, 'response-cache.json');
      assert.ok(existsSync(cacheFile));

      const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
      assert.strictEqual(data.version, 1);
      assert.strictEqual(data.entries.length, 1);
      assert.strictEqual(data.entries[0][1].response, 'value');
    });

    it('loadFromDisk should populate cache from file', async () => {
      // First, create a cache and save it
      cache = new ResponseCache({ persistPath: testDir });
      cache.set('loaded', 'from disk');
      await cache.saveToDisk();
      await cache.destroy();
      cache = null;

      // Create new cache instance and load
      cache = new ResponseCache({ persistPath: testDir });
      await cache.loadFromDisk();

      assert.strictEqual(cache.get('loaded'), 'from disk');
      assert.strictEqual(cache.getStats().size, 1);
    });

    it('loadFromDisk should skip expired entries', async () => {
      // Create cache file with expired entry
      const cacheFile = join(testDir, 'response-cache.json');
      const now = Date.now();
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        entries: [
          ['key1', { prompt: 'valid', response: 'res1', createdAt: now, expiresAt: now + 60000, model: 'default' }],
          ['key2', { prompt: 'expired', response: 'res2', createdAt: now - 5000, expiresAt: now - 1000, model: 'default' }]
        ]
      };
      writeFileSync(cacheFile, JSON.stringify(data));

      cache = new ResponseCache({ persistPath: testDir });
      await cache.loadFromDisk();

      // Only the non-expired entry should be loaded (size = 1)
      assert.strictEqual(cache.getStats().size, 1);
    });

    it('loadFromDisk should handle missing file gracefully', async () => {
      cache = new ResponseCache({ persistPath: testDir });

      // Should not throw
      await assert.doesNotReject(cache.loadFromDisk());
      assert.strictEqual(cache.getStats().size, 0);
    });

    it('loadFromDisk should handle invalid JSON gracefully', async () => {
      const cacheFile = join(testDir, 'response-cache.json');
      writeFileSync(cacheFile, 'not valid json {{{');

      cache = new ResponseCache({ persistPath: testDir });

      // Should not throw
      await assert.doesNotReject(cache.loadFromDisk());
      assert.strictEqual(cache.getStats().size, 0);
    });

    it('persistSync should write synchronously', () => {
      cache = new ResponseCache({ persistPath: testDir });
      cache.set('k', 'v');

      cache.persistSync();

      const cacheFile = join(testDir, 'response-cache.json');
      assert.ok(existsSync(cacheFile));

      const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
      assert.ok(data.entries.length > 0);
    });
  });

  describe('generateKey', () => {
    beforeEach(() => {
      cache = new ResponseCache();
    });

    it('should generate consistent keys for same prompt+model', () => {
      const k1 = cache.generateKey('test', { model: 'gpt' });
      const k2 = cache.generateKey('test', { model: 'gpt' });
      assert.strictEqual(k1, k2);
    });

    it('should generate different keys for different prompts', () => {
      const k1 = cache.generateKey('test1');
      const k2 = cache.generateKey('test2');
      assert.notStrictEqual(k1, k2);
    });

    it('should generate different keys for different models', () => {
      const k1 = cache.generateKey('test', { model: 'v1' });
      const k2 = cache.generateKey('test', { model: 'v2' });
      assert.notStrictEqual(k1, k2);
    });

    it('should trim prompts before generating key', () => {
      const k1 = cache.generateKey('  test  ');
      const k2 = cache.generateKey('test');
      assert.strictEqual(k1, k2);
    });

    it('should handle empty options', () => {
      const k1 = cache.generateKey('test');
      const k2 = cache.generateKey('test', {});
      assert.strictEqual(k1, k2);
    });
  });

  describe('destroy', () => {
    it('should clear the cleanup timer', async () => {
      cache = new ResponseCache({ persistPath: testDir });

      await cache.destroy();

      // After destroy, further operations should still work but no auto-cleanup
      assert.strictEqual(cache.getStats().size, 0);
    });
  });
});
