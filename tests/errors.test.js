/**
 * Tests for error classes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  HybridError,
  ValidationError,
  AuthenticationError,
  TimeoutError,
  ModelError,
  RateLimitError,
  FileSystemError,
  ProcessError,
  ConfigError,
  SessionError,
  BudgetError,
  ERROR_CODES,
  wrapError,
  isErrorCode,
} from '../src/utils/errors.js';

describe('HybridError', () => {
  it('should create error with message', () => {
    const err = new HybridError('Test error');
    assert.strictEqual(err.message, 'Test error');
    assert.strictEqual(err.name, 'HybridError');
  });

  it('should have default code', () => {
    const err = new HybridError('Test');
    assert.strictEqual(err.code, 'HYBRID_ERROR');
  });

  it('should accept custom code and context', () => {
    const err = new HybridError('Test', 'CUSTOM_CODE', { foo: 'bar' });
    assert.strictEqual(err.code, 'CUSTOM_CODE');
    assert.deepStrictEqual(err.context, { foo: 'bar' });
  });

  it('should have timestamp', () => {
    const err = new HybridError('Test');
    assert.ok(err.timestamp);
    assert.ok(new Date(err.timestamp).getTime() > 0);
  });

  it('should convert to JSON', () => {
    const err = new HybridError('Test', 'CODE', { key: 'value' });
    const json = err.toJSON();
    assert.strictEqual(json.name, 'HybridError');
    assert.strictEqual(json.code, 'CODE');
    assert.strictEqual(json.message, 'Test');
    assert.ok(json.timestamp);
  });

  it('should create user message', () => {
    const err = new HybridError('Something failed', 'MY_CODE');
    assert.strictEqual(err.toUserMessage(), 'MY_CODE: Something failed');
  });
});

describe('ValidationError', () => {
  it('should have correct name and code', () => {
    const err = new ValidationError('Invalid input');
    assert.strictEqual(err.name, 'ValidationError');
    assert.strictEqual(err.code, 'VALIDATION_ERROR');
  });

  it('should store field name', () => {
    const err = new ValidationError('Invalid', 'email');
    assert.strictEqual(err.field, 'email');
  });

  it('should not store actual value', () => {
    const err = new ValidationError('Invalid', 'password', 'secret123');
    assert.strictEqual(err.valueType, 'string');
    assert.ok(!JSON.stringify(err).includes('secret123'));
  });

  it('should create user message with field', () => {
    const err = new ValidationError('must be valid', 'email');
    assert.ok(err.toUserMessage().includes('email'));
  });
});

describe('AuthenticationError', () => {
  it('should have correct name and code', () => {
    const err = new AuthenticationError('Not authenticated');
    assert.strictEqual(err.name, 'AuthenticationError');
    assert.strictEqual(err.code, 'AUTH_ERROR');
  });

  it('should store auth method', () => {
    const err = new AuthenticationError('Failed', 'oauth');
    assert.strictEqual(err.method, 'oauth');
  });

  it('should include method in user message', () => {
    const err = new AuthenticationError('Failed', 'api-key');
    assert.ok(err.toUserMessage().includes('api-key'));
  });
});

describe('TimeoutError', () => {
  it('should have correct name and code', () => {
    const err = new TimeoutError('Timed out');
    assert.strictEqual(err.name, 'TimeoutError');
    assert.strictEqual(err.code, 'TIMEOUT_ERROR');
  });

  it('should store operation and timeout', () => {
    const err = new TimeoutError('Timed out', 'gemini_prompt', 60000);
    assert.strictEqual(err.operation, 'gemini_prompt');
    assert.strictEqual(err.timeoutMs, 60000);
  });

  it('should format timeout in seconds in user message', () => {
    const err = new TimeoutError('Timed out', 'test', 30000);
    assert.ok(err.toUserMessage().includes('30s'));
  });
});

describe('ModelError', () => {
  it('should have correct name and code', () => {
    const err = new ModelError('Model failed');
    assert.strictEqual(err.name, 'ModelError');
    assert.strictEqual(err.code, 'MODEL_ERROR');
  });

  it('should store model and provider', () => {
    const err = new ModelError('Failed', 'gemini-2.5-pro', 'gemini');
    assert.strictEqual(err.model, 'gemini-2.5-pro');
    assert.strictEqual(err.provider, 'gemini');
  });
});

describe('RateLimitError', () => {
  it('should have correct name and code', () => {
    const err = new RateLimitError('Too many requests');
    assert.strictEqual(err.name, 'RateLimitError');
    assert.strictEqual(err.code, 'RATE_LIMIT_ERROR');
  });

  it('should store retry after', () => {
    const err = new RateLimitError('Limited', 60);
    assert.strictEqual(err.retryAfter, 60);
  });

  it('should include retry time in user message', () => {
    const err = new RateLimitError('Limited', 30);
    assert.ok(err.toUserMessage().includes('30s'));
  });
});

describe('FileSystemError', () => {
  it('should have correct name and code', () => {
    const err = new FileSystemError('File not found');
    assert.strictEqual(err.name, 'FileSystemError');
    assert.strictEqual(err.code, 'FILESYSTEM_ERROR');
  });

  it('should sanitize path to filename only', () => {
    const err = new FileSystemError('Not found', 'read', '/secret/path/to/file.txt');
    assert.strictEqual(err.context.file, 'file.txt');
  });
});

describe('ProcessError', () => {
  it('should have correct name and code', () => {
    const err = new ProcessError('Process failed');
    assert.strictEqual(err.name, 'ProcessError');
    assert.strictEqual(err.code, 'PROCESS_ERROR');
  });

  it('should store exit code', () => {
    const err = new ProcessError('Failed', 'gemini', 1);
    assert.strictEqual(err.exitCode, 1);
  });

  it('should include exit code in user message', () => {
    const err = new ProcessError('Failed', 'cmd', 127);
    assert.ok(err.toUserMessage().includes('127'));
  });
});

describe('ConfigError', () => {
  it('should have correct name and code', () => {
    const err = new ConfigError('Invalid config');
    assert.strictEqual(err.name, 'ConfigError');
    assert.strictEqual(err.code, 'CONFIG_ERROR');
  });

  it('should include setting in user message', () => {
    const err = new ConfigError('Invalid', 'timeout');
    assert.ok(err.toUserMessage().includes('timeout'));
  });
});

describe('SessionError', () => {
  it('should have correct name and code', () => {
    const err = new SessionError('Session not found');
    assert.strictEqual(err.name, 'SessionError');
    assert.strictEqual(err.code, 'SESSION_ERROR');
  });

  it('should store session state', () => {
    const err = new SessionError('Error', 'sess-123', 'active');
    assert.strictEqual(err.state, 'active');
  });
});

describe('BudgetError', () => {
  it('should have correct name and code', () => {
    const err = new BudgetError('Budget exceeded');
    assert.strictEqual(err.name, 'BudgetError');
    assert.strictEqual(err.code, 'BUDGET_ERROR');
  });

  it('should format amounts in user message', () => {
    const err = new BudgetError('Exceeded', 5.5, 5.0);
    const msg = err.toUserMessage();
    assert.ok(msg.includes('5.5'));
    assert.ok(msg.includes('5.0'));
  });
});

describe('ERROR_CODES', () => {
  it('should have validation codes', () => {
    assert.ok(ERROR_CODES.VALIDATION_ERROR);
    assert.ok(ERROR_CODES.INVALID_PROMPT);
  });

  it('should have auth codes', () => {
    assert.ok(ERROR_CODES.AUTH_ERROR);
    assert.ok(ERROR_CODES.AUTH_EXPIRED);
  });

  it('should have operation codes', () => {
    assert.ok(ERROR_CODES.TIMEOUT_ERROR);
    assert.ok(ERROR_CODES.RATE_LIMIT_ERROR);
  });
});

describe('wrapError', () => {
  it('should return HybridError unchanged', () => {
    const original = new HybridError('Test');
    const wrapped = wrapError(original);
    assert.strictEqual(wrapped, original);
  });

  it('should wrap regular Error', () => {
    const original = new Error('Regular error');
    const wrapped = wrapError(original, 'test-context');
    assert.ok(wrapped instanceof HybridError);
    assert.strictEqual(wrapped.message, 'Regular error');
    assert.strictEqual(wrapped.code, 'WRAPPED_ERROR');
  });

  it('should wrap string', () => {
    const wrapped = wrapError('String error');
    assert.ok(wrapped instanceof HybridError);
    assert.strictEqual(wrapped.message, 'String error');
  });
});

describe('isErrorCode', () => {
  it('should return true for matching code', () => {
    const err = new ValidationError('Test');
    assert.strictEqual(isErrorCode(err, 'VALIDATION_ERROR'), true);
  });

  it('should return false for non-matching code', () => {
    const err = new ValidationError('Test');
    assert.strictEqual(isErrorCode(err, 'AUTH_ERROR'), false);
  });

  it('should return false for non-HybridError', () => {
    const err = new Error('Regular');
    assert.strictEqual(isErrorCode(err, 'VALIDATION_ERROR'), false);
  });
});
