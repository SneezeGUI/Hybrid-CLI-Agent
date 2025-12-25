/**
 * Tests for input validation utilities
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  LIMITS,
  validatePrompt,
  validateModel,
  validateFilePatterns,
  validateSources,
  validatePositiveInteger,
  validateEnum,
  validateObject,
  validateTemperature,
  validateConversationId,
  aggregateValidations,
} from '../src/utils/validation.js';

describe('LIMITS constants', () => {
  it('should have correct limit values', () => {
    assert.strictEqual(LIMITS.MAX_PROMPT_LENGTH, 500000);
    assert.strictEqual(LIMITS.MIN_PROMPT_LENGTH, 1);
    assert.strictEqual(LIMITS.MAX_FILE_SIZE, 10 * 1024 * 1024);
    assert.strictEqual(LIMITS.MAX_FILES_PER_REQUEST, 100);
    assert.strictEqual(LIMITS.MAX_SOURCES_COMPARISON, 10);
    assert.strictEqual(LIMITS.MAX_ROUNDS, 10);
  });

  it('should have valid model list', () => {
    assert.ok(LIMITS.VALID_MODELS.includes('gemini-2.5-flash'));
    assert.ok(LIMITS.VALID_MODELS.includes('gemini-2.5-pro'));
    assert.ok(LIMITS.VALID_MODELS.includes('gemini-3-pro'));
  });
});

describe('validatePrompt', () => {
  it('should accept valid prompts', () => {
    const result = validatePrompt('Hello, world!');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.sanitized, 'Hello, world!');
  });

  it('should trim whitespace', () => {
    const result = validatePrompt('  Hello  ');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.sanitized, 'Hello');
  });

  it('should reject null input', () => {
    const result = validatePrompt(null);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('required'));
  });

  it('should reject undefined input', () => {
    const result = validatePrompt(undefined);
    assert.strictEqual(result.valid, false);
  });

  it('should reject non-string input', () => {
    const result = validatePrompt(123);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('string'));
  });

  it('should reject empty string', () => {
    const result = validatePrompt('');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('empty'));
  });

  it('should reject whitespace-only string', () => {
    const result = validatePrompt('   ');
    assert.strictEqual(result.valid, false);
  });

  it('should reject prompts exceeding max length', () => {
    const longPrompt = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1);
    const result = validatePrompt(longPrompt);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('exceeds'));
  });

  it('should accept prompts at max length', () => {
    const maxPrompt = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH);
    const result = validatePrompt(maxPrompt);
    assert.strictEqual(result.valid, true);
  });
});

describe('validateModel', () => {
  it('should accept valid models', () => {
    const result = validateModel('gemini-2.5-pro');
    assert.strictEqual(result.valid, true);
  });

  it('should accept null (optional field)', () => {
    const result = validateModel(null);
    assert.strictEqual(result.valid, true);
  });

  it('should accept undefined (optional field)', () => {
    const result = validateModel(undefined);
    assert.strictEqual(result.valid, true);
  });

  it('should reject invalid model names', () => {
    const result = validateModel('gpt-4');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Invalid model'));
  });

  it('should reject non-string input', () => {
    const result = validateModel(123);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('string'));
  });

  it('should accept custom valid models list', () => {
    const result = validateModel('custom-model', ['custom-model', 'other-model']);
    assert.strictEqual(result.valid, true);
  });
});

describe('validateFilePatterns', () => {
  it('should accept valid patterns', () => {
    const result = validateFilePatterns(['src/**/*.js', 'tests/*.test.js']);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.patterns, ['src/**/*.js', 'tests/*.test.js']);
  });

  it('should reject null input', () => {
    const result = validateFilePatterns(null);
    assert.strictEqual(result.valid, false);
  });

  it('should reject non-array input', () => {
    const result = validateFilePatterns('not-an-array');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('array'));
  });

  it('should reject empty array', () => {
    const result = validateFilePatterns([]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('At least one'));
  });

  it('should reject too many patterns', () => {
    const patterns = Array(101).fill('*.js');
    const result = validateFilePatterns(patterns);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Too many'));
  });

  it('should filter out non-string patterns', () => {
    const result = validateFilePatterns(['valid.js', 123, null, 'also-valid.js']);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.patterns, ['valid.js', 'also-valid.js']);
  });

  it('should filter out empty strings', () => {
    const result = validateFilePatterns(['valid.js', '', '  ', 'also-valid.js']);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.patterns, ['valid.js', 'also-valid.js']);
  });

  it('should fail if all patterns are invalid', () => {
    const result = validateFilePatterns([123, null, '']);
    assert.strictEqual(result.valid, false);
  });
});

describe('validateSources', () => {
  it('should accept valid sources', () => {
    const result = validateSources(['source1', 'source2']);
    assert.strictEqual(result.valid, true);
  });

  it('should reject null input', () => {
    const result = validateSources(null);
    assert.strictEqual(result.valid, false);
  });

  it('should reject non-array input', () => {
    const result = validateSources('not-an-array');
    assert.strictEqual(result.valid, false);
  });

  it('should reject less than 2 sources', () => {
    const result = validateSources(['only-one']);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('At least 2'));
  });

  it('should reject too many sources', () => {
    const sources = Array(11).fill('source');
    const result = validateSources(sources);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Too many'));
  });

  it('should reject non-string sources', () => {
    const result = validateSources(['valid', 123]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('string'));
  });

  it('should reject empty string sources', () => {
    const result = validateSources(['valid', '']);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('empty'));
  });
});

describe('validatePositiveInteger', () => {
  it('should accept valid integers', () => {
    const result = validatePositiveInteger(5, 'count');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.value, 5);
  });

  it('should accept null (optional field)', () => {
    const result = validatePositiveInteger(null, 'count');
    assert.strictEqual(result.valid, true);
  });

  it('should accept undefined (optional field)', () => {
    const result = validatePositiveInteger(undefined, 'count');
    assert.strictEqual(result.valid, true);
  });

  it('should reject non-integers', () => {
    const result = validatePositiveInteger(3.14, 'count');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('integer'));
  });

  it('should reject values below minimum', () => {
    const result = validatePositiveInteger(0, 'count', 1);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('at least'));
  });

  it('should reject values above maximum', () => {
    const result = validatePositiveInteger(100, 'count', 1, 10);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('at most'));
  });

  it('should coerce string numbers', () => {
    const result = validatePositiveInteger('5', 'count');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.value, 5);
  });
});

describe('validateEnum', () => {
  const validValues = ['option1', 'option2', 'option3'];

  it('should accept valid enum values', () => {
    const result = validateEnum('option1', validValues, 'field');
    assert.strictEqual(result.valid, true);
  });

  it('should accept null (optional field)', () => {
    const result = validateEnum(null, validValues, 'field');
    assert.strictEqual(result.valid, true);
  });

  it('should reject invalid values', () => {
    const result = validateEnum('invalid', validValues, 'field');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Invalid'));
  });

  it('should reject non-string values', () => {
    const result = validateEnum(123, validValues, 'field');
    assert.strictEqual(result.valid, false);
  });
});

describe('validateObject', () => {
  it('should accept valid objects', () => {
    const result = validateObject({ name: 'test' });
    assert.strictEqual(result.valid, true);
  });

  it('should reject null', () => {
    const result = validateObject(null);
    assert.strictEqual(result.valid, false);
  });

  it('should reject arrays', () => {
    const result = validateObject([1, 2, 3]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('array'));
  });

  it('should check required fields', () => {
    const result = validateObject({ name: 'test' }, ['name', 'age']);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.missingFields, ['age']);
  });

  it('should pass when all required fields present', () => {
    const result = validateObject({ name: 'test', age: 25 }, ['name', 'age']);
    assert.strictEqual(result.valid, true);
  });

  it('should treat empty string as missing', () => {
    const result = validateObject({ name: '' }, ['name']);
    assert.strictEqual(result.valid, false);
  });
});

describe('validateTemperature', () => {
  it('should accept valid temperatures', () => {
    const result = validateTemperature(0.7);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.value, 0.7);
  });

  it('should accept null (optional)', () => {
    const result = validateTemperature(null);
    assert.strictEqual(result.valid, true);
  });

  it('should accept 0', () => {
    const result = validateTemperature(0);
    assert.strictEqual(result.valid, true);
  });

  it('should accept 2', () => {
    const result = validateTemperature(2);
    assert.strictEqual(result.valid, true);
  });

  it('should reject negative values', () => {
    const result = validateTemperature(-0.5);
    assert.strictEqual(result.valid, false);
  });

  it('should reject values above 2', () => {
    const result = validateTemperature(2.5);
    assert.strictEqual(result.valid, false);
  });
});

describe('validateConversationId', () => {
  it('should accept valid IDs', () => {
    const result = validateConversationId('abc-123-def');
    assert.strictEqual(result.valid, true);
  });

  it('should reject null', () => {
    const result = validateConversationId(null);
    assert.strictEqual(result.valid, false);
  });

  it('should reject empty string', () => {
    const result = validateConversationId('');
    assert.strictEqual(result.valid, false);
  });

  it('should reject IDs with special characters', () => {
    const result = validateConversationId('id@with#special');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('invalid characters'));
  });

  it('should accept alphanumeric with hyphens', () => {
    const result = validateConversationId('Conv-123-ABC');
    assert.strictEqual(result.valid, true);
  });
});

describe('aggregateValidations', () => {
  it('should pass when all validations pass', () => {
    const result = aggregateValidations({
      prompt: { valid: true },
      model: { valid: true },
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should collect all errors', () => {
    const result = aggregateValidations({
      prompt: { valid: false, error: 'Prompt error' },
      model: { valid: false, error: 'Model error' },
      temp: { valid: true },
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length, 2);
  });

  it('should format errors with field names', () => {
    const result = aggregateValidations({
      myField: { valid: false, error: 'Something wrong' },
    });
    assert.ok(result.errors[0].includes('myField'));
  });
});
