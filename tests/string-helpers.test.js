import { describe, it } from 'node:test';
import assert from 'node:assert';
import { capitalize, slugify, truncate } from '../src/utils/string-helpers.js';

describe('string-helpers', () => {
  describe('capitalize', () => {
    it('should capitalize the first letter', () => {
      assert.strictEqual(capitalize('hello'), 'Hello');
    });

    it('should handle empty strings', () => {
      assert.strictEqual(capitalize(''), '');
    });

    it('should handle already capitalized strings', () => {
      assert.strictEqual(capitalize('World'), 'World');
    });

    it('should ignore non-string inputs (if strictly typed, otherwise handle gracefully)', () => {
        // Since we didn't enforce types in JS, this is just a sanity check for falsy values
        assert.strictEqual(capitalize(null), null);
    });
  });

  describe('slugify', () => {
    it('should convert spaces to hyphens and lowercase', () => {
      assert.strictEqual(slugify('Hello World'), 'hello-world');
    });

    it('should remove special characters', () => {
      assert.strictEqual(slugify('Hello @ World!'), 'hello-world');
    });

    it('should handle multiple spaces', () => {
      assert.strictEqual(slugify('Hello   World'), 'hello-world');
    });
    
    it('should handle leading/trailing separators', () => {
      assert.strictEqual(slugify('  Hello World  '), 'hello-world');
    });
  });

  describe('truncate', () => {
    it('should truncate string if longer than maxLen', () => {
      assert.strictEqual(truncate('Hello World', 5), 'Hello...');
    });

    it('should not truncate if shorter than maxLen', () => {
      assert.strictEqual(truncate('Hello', 10), 'Hello');
    });

    it('should not truncate if equal to maxLen', () => {
      assert.strictEqual(truncate('Hello', 5), 'Hello');
    });

    it('should handle empty strings', () => {
      assert.strictEqual(truncate('', 5), '');
    });
  });
});
