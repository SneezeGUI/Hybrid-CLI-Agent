import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AUTH_DEFAULTS, AUTH_FALLBACK_ORDER } from '../src/config/auth.js';

describe('Auth Configuration', () => {
  describe('AUTH_DEFAULTS', () => {
    it('should have correct default values', () => {
      assert.strictEqual(AUTH_DEFAULTS.vertexLocation, 'us-central1');
      assert.strictEqual(AUTH_DEFAULTS.primaryMethod, 'oauth');
    });

    it('should be an object', () => {
      assert.strictEqual(typeof AUTH_DEFAULTS, 'object');
    });
  });

  describe('AUTH_FALLBACK_ORDER', () => {
    it('should be an array', () => {
      assert.ok(Array.isArray(AUTH_FALLBACK_ORDER));
    });

    it('should contain expected auth methods in order', () => {
      assert.strictEqual(AUTH_FALLBACK_ORDER[0], 'oauth');
      assert.strictEqual(AUTH_FALLBACK_ORDER[1], 'api-key');
      assert.strictEqual(AUTH_FALLBACK_ORDER[2], 'vertex');
    });

    it('should have correct length', () => {
      assert.strictEqual(AUTH_FALLBACK_ORDER.length, 3);
    });
  });
});
