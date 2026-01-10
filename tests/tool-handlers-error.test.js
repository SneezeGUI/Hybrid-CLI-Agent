import { test } from 'node:test';
import assert from 'node:assert';
import baseHandlers from '../src/mcp/tool-handlers/base.js';
import {
  RateLimitError,
  AuthenticationError,
  TimeoutError,
  ModelError,
  HybridError
} from '../src/utils/errors.js';

const {
  analyzeStderr,
  createTypedError,
  formatErrorResponse,
  withErrorHandling
} = baseHandlers;

test('analyzeStderr', async (t) => {
  await t.test('should detect rate limits', () => {
    const cases = [
      'Error: 429 Too Many Requests',
      'Rate limit exceeded',
      'Quota exceeded for quota metric',
      'RESOURCE_EXHAUSTED: quota exceeded'
    ];
    
    for (const c of cases) {
      const result = analyzeStderr(c);
      assert.strictEqual(result.isRateLimit, true, `Failed for: ${c}`);
      assert.strictEqual(result.isModelError, false);
    }
  });

  await t.test('should detect model errors', () => {
    const cases = [
      'Model not found',
      'Invalid model specified',
      'Unsupported model'
    ];
    
    for (const c of cases) {
      const result = analyzeStderr(c);
      assert.strictEqual(result.isModelError, true, `Failed for: ${c}`);
      assert.strictEqual(result.isRateLimit, false);
    }
  });

  await t.test('should detect auth errors', () => {
    const cases = [
      'Auth error',
      'Invalid credential',
      'Unauthenticated request',
      'Permission denied',
      'Status 401',
      'Status 403'
    ];
    
    for (const c of cases) {
      const result = analyzeStderr(c);
      assert.strictEqual(result.isAuthError, true, `Failed for: ${c}`);
    }
  });

  await t.test('should detect timeouts', () => {
    const cases = [
      'Request timed out',
      'Timeout occurred',
      'DEADLINE_EXCEEDED'
    ];
    
    for (const c of cases) {
      const result = analyzeStderr(c);
      assert.strictEqual(result.isTimeout, true, `Failed for: ${c}`);
    }
  });

  await t.test('should handle unknown errors', () => {
    const result = analyzeStderr('Something went wrong');
    assert.strictEqual(result.isUnknown, true);
    assert.strictEqual(result.isRateLimit, false);
    assert.strictEqual(result.isModelError, false);
  });
});

test('createTypedError', async (t) => {
  await t.test('should create RateLimitError', () => {
    const analysis = { isRateLimit: true };
    const err = createTypedError(analysis, 'Too many requests', { provider: 'gemini' });
    assert.ok(err instanceof RateLimitError);
    assert.strictEqual(err.message, 'Too many requests');
    assert.strictEqual(err.provider, 'gemini');
  });

  await t.test('should create AuthenticationError', () => {
    const analysis = { isAuthError: true };
    const err = createTypedError(analysis, 'Bad token', { authMethod: 'api-key' });
    assert.ok(err instanceof AuthenticationError);
    assert.strictEqual(err.message, 'Bad token');
    assert.strictEqual(err.method, 'api-key');
  });

  await t.test('should create TimeoutError', () => {
    const analysis = { isTimeout: true };
    const err = createTypedError(analysis, 'Took too long', { operation: 'fetch', timeoutMs: 1000 });
    assert.ok(err instanceof TimeoutError);
    assert.strictEqual(err.message, 'Took too long');
    assert.strictEqual(err.operation, 'fetch');
  });

  await t.test('should create ModelError', () => {
    const analysis = { isModelError: true };
    const err = createTypedError(analysis, 'Bad model', { model: 'gpt-4' });
    assert.ok(err instanceof ModelError);
    assert.strictEqual(err.message, 'Bad model');
    assert.strictEqual(err.model, 'gpt-4');
  });

  await t.test('should create HybridError for unknown', () => {
    const analysis = { isUnknown: true };
    const err = createTypedError(analysis, 'Whoops');
    assert.ok(err instanceof HybridError);
    assert.strictEqual(err.message, 'Whoops');
    assert.strictEqual(err.code, 'UNKNOWN_ERROR');
  });
});

test('formatErrorResponse', async (t) => {
  await t.test('should format RateLimitError with hint', () => {
    const err = new RateLimitError('Slow down');
    const response = formatErrorResponse(err, 'test-tool');
    assert.ok(response.isError);
    assert.ok(response.content[0].text.includes('Rate limit exceeded'));
    assert.ok(response.content[0].text.includes('Hint: Wait a moment'));
  });

  await t.test('should format regular Error', () => {
    const err = new Error('Random fail');
    const response = formatErrorResponse(err, 'test-tool');
    assert.ok(response.isError);
    assert.ok(response.content[0].text.includes('Random fail'));
  });
});

test('withErrorHandling', async (t) => {
  await t.test('should pass success result', async () => {
    const handler = async (args) => ({ result: args.val });
    const wrapped = withErrorHandling(handler, 'test-tool');
    const result = await wrapped({ val: 123 }, {});
    assert.strictEqual(result.result, 123);
  });

  await t.test('should catch and format errors', async () => {
    const handler = async () => { throw new Error('Boom'); };
    const wrapped = withErrorHandling(handler, 'test-tool');
    const result = await wrapped({}, {});
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Boom'));
  });
});
