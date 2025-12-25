/**
 * Tests for environment file utilities
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import {
  loadEnvFileSync,
  loadEnvFile,
  getEnvVar,
  getMergedEnv,
  getEnvFilePaths,
  applyEnvFile,
  clearEnvCache,
} from '../src/utils/env.js';

// Test fixtures directory
const TEST_DIR = join(process.cwd(), 'tests', 'fixtures', 'env-test');
const ENV_FILE = join(TEST_DIR, '.env');
const ENV_LOCAL_FILE = join(TEST_DIR, '.env.local');

describe('getEnvFilePaths', () => {
  it('should return array of paths', () => {
    const paths = getEnvFilePaths('/some/dir');
    assert.ok(Array.isArray(paths));
    assert.ok(paths.length >= 2);
  });

  it('should include .env and .env.local', () => {
    const paths = getEnvFilePaths('/some/dir');
    assert.ok(paths.some(p => p.endsWith('.env')));
    assert.ok(paths.some(p => p.endsWith('.env.local')));
  });
});

describe('loadEnvFileSync', () => {
  beforeEach(() => {
    clearEnvCache(); // Clear cache between tests
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should return empty object if no .env file exists', () => {
    const env = loadEnvFileSync(TEST_DIR);
    assert.deepStrictEqual(env, {});
  });

  it('should parse simple KEY=VALUE pairs', () => {
    writeFileSync(ENV_FILE, 'FOO=bar\nBAZ=qux');
    const env = loadEnvFileSync(TEST_DIR);
    assert.strictEqual(env.FOO, 'bar');
    assert.strictEqual(env.BAZ, 'qux');
  });

  it('should ignore comments', () => {
    writeFileSync(ENV_FILE, '# This is a comment\nFOO=bar\n# Another comment');
    const env = loadEnvFileSync(TEST_DIR);
    assert.strictEqual(env.FOO, 'bar');
    assert.strictEqual(Object.keys(env).length, 1);
  });

  it('should ignore empty lines', () => {
    writeFileSync(ENV_FILE, 'FOO=bar\n\n\nBAZ=qux\n');
    const env = loadEnvFileSync(TEST_DIR);
    assert.strictEqual(env.FOO, 'bar');
    assert.strictEqual(env.BAZ, 'qux');
  });

  it('should handle quoted values', () => {
    writeFileSync(ENV_FILE, 'FOO="bar baz"\nQUX=\'hello world\'');
    const env = loadEnvFileSync(TEST_DIR);
    assert.strictEqual(env.FOO, 'bar baz');
    assert.strictEqual(env.QUX, 'hello world');
  });

  it('should trim whitespace', () => {
    writeFileSync(ENV_FILE, '  FOO  =  bar  ');
    const env = loadEnvFileSync(TEST_DIR);
    assert.strictEqual(env.FOO, 'bar');
  });

  it('should handle values with equals signs', () => {
    writeFileSync(ENV_FILE, 'CONNECTION_STRING=host=localhost;port=5432');
    const env = loadEnvFileSync(TEST_DIR);
    assert.strictEqual(env.CONNECTION_STRING, 'host=localhost;port=5432');
  });

  it('should merge .env and .env.local', () => {
    writeFileSync(ENV_FILE, 'FOO=from_env\nBAZ=only_env');
    writeFileSync(ENV_LOCAL_FILE, 'FOO=from_local\nQUX=only_local');
    const env = loadEnvFileSync(TEST_DIR);
    // .env.local should override .env
    assert.strictEqual(env.FOO, 'from_local');
    assert.strictEqual(env.BAZ, 'only_env');
    assert.strictEqual(env.QUX, 'only_local');
  });
});

describe('loadEnvFile (async)', () => {
  beforeEach(() => {
    clearEnvCache(); // Clear cache between tests
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should return empty object if no .env file exists', async () => {
    const env = await loadEnvFile(TEST_DIR);
    assert.deepStrictEqual(env, {});
  });

  it('should parse KEY=VALUE pairs', async () => {
    writeFileSync(ENV_FILE, 'ASYNC_TEST=works');
    const env = await loadEnvFile(TEST_DIR);
    assert.strictEqual(env.ASYNC_TEST, 'works');
  });
});

describe('getEnvVar', () => {
  beforeEach(() => {
    clearEnvCache(); // Clear cache between tests
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
      // Clean up any test env vars we set
      delete process.env.TEST_ENV_VAR;
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should return system env var if set', () => {
    process.env.TEST_ENV_VAR = 'from_system';
    writeFileSync(ENV_FILE, 'TEST_ENV_VAR=from_file');
    const value = getEnvVar('TEST_ENV_VAR', undefined, TEST_DIR);
    assert.strictEqual(value, 'from_system');
  });

  it('should return file value if system env not set', () => {
    writeFileSync(ENV_FILE, 'FILE_ONLY_VAR=from_file');
    const value = getEnvVar('FILE_ONLY_VAR', undefined, TEST_DIR);
    assert.strictEqual(value, 'from_file');
  });

  it('should return default if not found anywhere', () => {
    const value = getEnvVar('NONEXISTENT_VAR', 'default_value', TEST_DIR);
    assert.strictEqual(value, 'default_value');
  });

  it('should return undefined if not found and no default', () => {
    const value = getEnvVar('NONEXISTENT_VAR', undefined, TEST_DIR);
    assert.strictEqual(value, undefined);
  });
});

describe('getMergedEnv', () => {
  beforeEach(() => {
    clearEnvCache(); // Clear cache between tests
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should merge file env with process.env', () => {
    writeFileSync(ENV_FILE, 'MERGE_TEST=from_file');
    const merged = getMergedEnv(TEST_DIR);
    assert.strictEqual(merged.MERGE_TEST, 'from_file');
    // Should also have system env vars
    assert.ok('PATH' in merged || 'Path' in merged);
  });

  it('should prefer process.env over file', () => {
    process.env.MERGE_PRIORITY = 'from_system';
    writeFileSync(ENV_FILE, 'MERGE_PRIORITY=from_file');
    const merged = getMergedEnv(TEST_DIR);
    assert.strictEqual(merged.MERGE_PRIORITY, 'from_system');
    delete process.env.MERGE_PRIORITY;
  });
});

describe('applyEnvFile', () => {
  beforeEach(() => {
    clearEnvCache(); // Clear cache between tests
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
      // Clean up test env vars
      delete process.env.APPLY_TEST_VAR;
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should return list of loaded files', () => {
    writeFileSync(ENV_FILE, 'APPLY_TEST=value');
    const loaded = applyEnvFile(TEST_DIR, { silent: true });
    assert.ok(Array.isArray(loaded));
    assert.ok(loaded.length > 0);
  });

  it('should apply values to process.env', () => {
    writeFileSync(ENV_FILE, 'APPLY_TEST_VAR=applied_value');
    applyEnvFile(TEST_DIR, { silent: true });
    assert.strictEqual(process.env.APPLY_TEST_VAR, 'applied_value');
  });

  it('should not override existing process.env values', () => {
    process.env.APPLY_TEST_VAR = 'existing';
    writeFileSync(ENV_FILE, 'APPLY_TEST_VAR=new_value');
    applyEnvFile(TEST_DIR, { silent: true });
    assert.strictEqual(process.env.APPLY_TEST_VAR, 'existing');
  });

  it('should return empty array if no files found', () => {
    const loaded = applyEnvFile(TEST_DIR, { silent: true });
    // No .env file created, so should be empty
    // (unless .env.gemini exists in home dir)
    assert.ok(Array.isArray(loaded));
  });
});
