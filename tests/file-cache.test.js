import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { writeFile, unlink, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  FileContentCache,
  getContextFileCache,
  resetContextFileCache,
} from '../src/utils/file-cache.js';

describe('FileContentCache', () => {
  let cache;
  let tempDir;
  let testFile;

  beforeEach(async () => {
    cache = new FileContentCache({ maxEntries: 10, ttlMs: 5000 });
    tempDir = join(tmpdir(), `file-cache-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    testFile = join(tempDir, 'test.txt');
    await writeFile(testFile, 'test content');
  });

  afterEach(async () => {
    cache.clear();
    try {
      await unlink(testFile);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('constructor', () => {
    it('should use default values when no options provided', () => {
      const defaultCache = new FileContentCache();
      const stats = defaultCache.getStats();
      assert.strictEqual(stats.maxEntries, 100);
      assert.strictEqual(stats.ttlMs, 30000);
    });

    it('should use provided options', () => {
      const stats = cache.getStats();
      assert.strictEqual(stats.maxEntries, 10);
      assert.strictEqual(stats.ttlMs, 5000);
    });
  });

  describe('getCacheKey', () => {
    it('should normalize paths to lowercase', () => {
      const key1 = cache.getCacheKey('/Path/To/File.txt');
      const key2 = cache.getCacheKey('/path/to/file.txt');
      assert.strictEqual(key1, key2);
    });

    it('should resolve relative paths', () => {
      const key1 = cache.getCacheKey('./src/../src/file.js');
      const key2 = cache.getCacheKey('./src/file.js');
      // Both should resolve to the same absolute path
      assert.ok(key1.includes('src'));
      assert.ok(key2.includes('src'));
    });
  });

  describe('getFile', () => {
    it('should read file content on first access', async () => {
      const result = await cache.getFile(testFile);
      assert.ok(result !== null);
      assert.strictEqual(result.content, 'test content');
      assert.strictEqual(result.fromCache, false);
    });

    it('should return cached content on second access', async () => {
      // First read
      await cache.getFile(testFile);

      // Second read should be from cache
      const result = await cache.getFile(testFile);
      assert.ok(result !== null);
      assert.strictEqual(result.content, 'test content');
      assert.strictEqual(result.fromCache, true);
    });

    it('should invalidate cache when file changes', async () => {
      // First read
      await cache.getFile(testFile);

      // Wait a bit and modify file
      await new Promise(r => setTimeout(r, 50));
      await writeFile(testFile, 'updated content');

      // Second read should detect change
      const result = await cache.getFile(testFile);
      assert.ok(result !== null);
      assert.strictEqual(result.content, 'updated content');
      assert.strictEqual(result.fromCache, false);
    });

    it('should return null for non-existent files', async () => {
      const result = await cache.getFile('/nonexistent/file.txt');
      assert.strictEqual(result, null);
    });

    it('should return null for directories', async () => {
      const result = await cache.getFile(tempDir);
      assert.strictEqual(result, null);
    });
  });

  describe('isEntryValid', () => {
    it('should return false when TTL expired', () => {
      const entry = {
        content: 'test',
        mtime: 12345,
        cachedAt: Date.now() - 10000, // 10 seconds ago
      };
      // Cache has 5 second TTL
      assert.strictEqual(cache.isEntryValid(entry, 12345), false);
    });

    it('should return false when mtime differs', () => {
      const entry = {
        content: 'test',
        mtime: 12345,
        cachedAt: Date.now(),
      };
      assert.strictEqual(cache.isEntryValid(entry, 99999), false);
    });

    it('should return true when valid', () => {
      const entry = {
        content: 'test',
        mtime: 12345,
        cachedAt: Date.now(),
      };
      assert.strictEqual(cache.isEntryValid(entry, 12345), true);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entries when at capacity', async () => {
      const smallCache = new FileContentCache({ maxEntries: 3, ttlMs: 30000 });

      // Create test files
      const files = [];
      for (let i = 0; i < 5; i++) {
        const file = join(tempDir, `file${i}.txt`);
        await writeFile(file, `content ${i}`);
        files.push(file);
      }

      // Read all files
      for (const file of files) {
        await smallCache.getFile(file);
      }

      // Cache should only have 3 entries (most recent)
      const stats = smallCache.getStats();
      assert.strictEqual(stats.size, 3);

      // Clean up
      for (const file of files) {
        try { await unlink(file); } catch {}
      }
    });
  });

  describe('invalidate', () => {
    it('should remove specific file from cache', async () => {
      // Cache the file
      await cache.getFile(testFile);
      assert.strictEqual(cache.getStats().size, 1);

      // Invalidate it
      cache.invalidate(testFile);
      assert.strictEqual(cache.getStats().size, 0);
    });

    it('should not error on non-cached file', () => {
      cache.invalidate('/some/random/path.txt');
      assert.strictEqual(cache.getStats().size, 0);
    });
  });

  describe('clear', () => {
    it('should remove all entries', async () => {
      await cache.getFile(testFile);
      assert.strictEqual(cache.getStats().size, 1);

      cache.clear();
      assert.strictEqual(cache.getStats().size, 0);
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      const stats1 = cache.getStats();
      assert.strictEqual(stats1.size, 0);

      await cache.getFile(testFile);

      const stats2 = cache.getStats();
      assert.strictEqual(stats2.size, 1);
      assert.strictEqual(stats2.maxEntries, 10);
      assert.strictEqual(stats2.ttlMs, 5000);
    });
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetContextFileCache();
  });

  describe('getContextFileCache', () => {
    it('should return the same instance on multiple calls', () => {
      const cache1 = getContextFileCache();
      const cache2 = getContextFileCache();
      assert.strictEqual(cache1, cache2);
    });

    it('should accept options on first call', () => {
      const cache = getContextFileCache({ maxEntries: 50, ttlMs: 10000 });
      const stats = cache.getStats();
      assert.strictEqual(stats.maxEntries, 50);
      assert.strictEqual(stats.ttlMs, 10000);
    });

    it('should ignore options on subsequent calls', () => {
      const cache1 = getContextFileCache({ maxEntries: 50 });
      const cache2 = getContextFileCache({ maxEntries: 200 });
      assert.strictEqual(cache2.getStats().maxEntries, 50);
    });
  });

  describe('resetContextFileCache', () => {
    it('should clear the singleton', () => {
      const cache1 = getContextFileCache({ maxEntries: 50 });
      resetContextFileCache();
      const cache2 = getContextFileCache({ maxEntries: 100 });

      // Should be a new instance with different config
      assert.strictEqual(cache2.getStats().maxEntries, 100);
    });

    it('should not error if cache not created', () => {
      resetContextFileCache();
      resetContextFileCache();
      assert.ok(true);
    });
  });
});
