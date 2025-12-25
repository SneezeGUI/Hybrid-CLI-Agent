/**
 * Tests for logger utilities
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Writable } from 'stream';
import {
  LOG_LEVELS,
  Logger,
  createLogger,
  configureLogger,
  getLogger,
  maskSensitiveData,
} from '../src/utils/logger.js';

// Create a mock output stream for testing
function createMockOutput() {
  const lines = [];
  const stream = new Writable({
    write(chunk, encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  stream.getLines = () => lines;
  stream.getLastLine = () => lines[lines.length - 1] || '';
  stream.clear = () => lines.length = 0;
  return stream;
}

describe('LOG_LEVELS', () => {
  it('should have correct priority order', () => {
    assert.ok(LOG_LEVELS.DEBUG < LOG_LEVELS.INFO);
    assert.ok(LOG_LEVELS.INFO < LOG_LEVELS.WARN);
    assert.ok(LOG_LEVELS.WARN < LOG_LEVELS.ERROR);
    assert.ok(LOG_LEVELS.ERROR < LOG_LEVELS.NONE);
  });
});

describe('maskSensitiveData', () => {
  it('should mask API keys', () => {
    const input = 'api_key: AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const result = maskSensitiveData(input);
    assert.ok(result.includes('AIza'));
    assert.ok(result.includes('****'));
    assert.ok(!result.includes('KLMNOPQRSTUVWXYZ123456'));
  });

  it('should mask GEMINI_API_KEY', () => {
    const input = 'GEMINI_API_KEY=sk-proj-abcdefghijklmnop';
    const result = maskSensitiveData(input);
    assert.ok(result.includes('sk-p'));
    assert.ok(result.includes('****'));
  });

  it('should mask passwords', () => {
    const input = 'password: mysecretpassword123';
    const result = maskSensitiveData(input);
    assert.ok(!result.includes('secretpassword'));
  });

  it('should return non-strings unchanged', () => {
    assert.strictEqual(maskSensitiveData(123), 123);
    assert.strictEqual(maskSensitiveData(null), null);
    assert.strictEqual(maskSensitiveData(undefined), undefined);
  });

  it('should handle strings without sensitive data', () => {
    const input = 'Hello, this is a normal message';
    const result = maskSensitiveData(input);
    assert.strictEqual(result, input);
  });

  it('should mask OpenRouter API keys', () => {
    const input = 'OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop1234567890';
    const result = maskSensitiveData(input);
    assert.ok(result.includes('sk-o'));
    assert.ok(result.includes('****'));
    assert.ok(!result.includes('abcdefghijklmnop1234567890'));
  });

  it('should mask standalone OpenRouter API keys', () => {
    const input = 'Key: sk-or-v1-abcdefghijklmnopqrstuvwx';
    const result = maskSensitiveData(input);
    assert.ok(result.includes('sk-o'));
    assert.ok(result.includes('****'));
    assert.ok(!result.includes('abcdefghijklmnopqrstuvwx'));
  });

  it('should mask Google API keys', () => {
    const input = 'Using AIzaSyA1234567890ABCDEFGHIJKLMNOPQRST';
    const result = maskSensitiveData(input);
    assert.ok(result.includes('AIza'));
    assert.ok(result.includes('****'));
    assert.ok(!result.includes('1234567890ABCDEFGHIJKLMNOPQRST'));
  });

  it('should mask Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const result = maskSensitiveData(input);
    assert.ok(!result.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  });

  it('should mask connection string passwords', () => {
    const input = 'mongodb://user:mysecretpassword@localhost:27017/db';
    const result = maskSensitiveData(input);
    assert.ok(!result.includes('mysecretpassword'));
  });

  it('should mask JWT tokens', () => {
    const input = 'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = maskSensitiveData(input);
    assert.ok(result.includes('eyJh'));
    assert.ok(result.includes('****'));
  });
});

describe('Logger', () => {
  let mockOutput;
  let logger;

  beforeEach(() => {
    mockOutput = createMockOutput();
    logger = createLogger({
      output: mockOutput,
      useColors: false,
      level: LOG_LEVELS.DEBUG,
    });
  });

  it('should log debug messages', () => {
    logger.debug('Test debug');
    const line = mockOutput.getLastLine();
    assert.ok(line.includes('[DEBUG]'));
    assert.ok(line.includes('Test debug'));
  });

  it('should log info messages', () => {
    logger.info('Test info');
    const line = mockOutput.getLastLine();
    assert.ok(line.includes('[INFO]'));
    assert.ok(line.includes('Test info'));
  });

  it('should log warn messages', () => {
    logger.warn('Test warn');
    const line = mockOutput.getLastLine();
    assert.ok(line.includes('[WARN]'));
    assert.ok(line.includes('Test warn'));
  });

  it('should log error messages', () => {
    logger.error('Test error');
    const line = mockOutput.getLastLine();
    assert.ok(line.includes('[ERROR]'));
    assert.ok(line.includes('Test error'));
  });

  it('should include timestamp', () => {
    logger.info('Test');
    const line = mockOutput.getLastLine();
    // ISO timestamp format: 2024-01-01T00:00:00.000Z
    assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line));
  });

  it('should include context as JSON', () => {
    logger.info('Test', { key: 'value' });
    const line = mockOutput.getLastLine();
    assert.ok(line.includes('"key":"value"'));
  });

  it('should respect log level', () => {
    const infoLogger = createLogger({
      output: mockOutput,
      useColors: false,
      level: LOG_LEVELS.INFO,
    });

    mockOutput.clear();
    infoLogger.debug('Should not appear');
    assert.strictEqual(mockOutput.getLines().length, 0);

    infoLogger.info('Should appear');
    assert.strictEqual(mockOutput.getLines().length, 1);
  });

  it('should handle Error objects', () => {
    const err = new Error('Test error message');
    err.code = 'TEST_CODE';
    logger.error('An error occurred', err);

    const line = mockOutput.getLastLine();
    assert.ok(line.includes('errorName'));
    assert.ok(line.includes('errorMessage'));
  });

  it('should mask sensitive data in messages', () => {
    logger.info('API key is api_key=sk-abc123456789012345678901234567890');
    const line = mockOutput.getLastLine();
    assert.ok(line.includes('sk-a'));
    assert.ok(line.includes('****'));
  });

  it('should mask sensitive data in context', () => {
    logger.info('Request', { apiKey: 'sk-abc123456789012345678901234567890' });
    const line = mockOutput.getLastLine();
    assert.ok(!line.includes('abc123456789012345678901234567890'));
  });
});

describe('Logger.child', () => {
  it('should create child logger with prefix', () => {
    const mockOutput = createMockOutput();
    const parent = createLogger({
      output: mockOutput,
      useColors: false,
      prefix: 'parent',
    });

    const child = parent.child('child');
    child.info('Test');

    const line = mockOutput.getLastLine();
    assert.ok(line.includes('[parent:child]'));
  });
});

describe('Logger.setLevel', () => {
  it('should change log level by name', () => {
    const mockOutput = createMockOutput();
    const logger = createLogger({
      output: mockOutput,
      useColors: false,
      level: LOG_LEVELS.DEBUG,
    });

    logger.debug('Should appear');
    assert.strictEqual(mockOutput.getLines().length, 1);

    logger.setLevel('ERROR');
    logger.debug('Should not appear');
    logger.info('Should not appear');
    logger.warn('Should not appear');
    assert.strictEqual(mockOutput.getLines().length, 1);

    logger.error('Should appear');
    assert.strictEqual(mockOutput.getLines().length, 2);
  });

  it('should change log level by number', () => {
    const mockOutput = createMockOutput();
    const logger = createLogger({
      output: mockOutput,
      level: LOG_LEVELS.DEBUG,
    });

    logger.setLevel(LOG_LEVELS.WARN);
    assert.strictEqual(logger.shouldLog(LOG_LEVELS.DEBUG), false);
    assert.strictEqual(logger.shouldLog(LOG_LEVELS.WARN), true);
  });
});

describe('Logger.time', () => {
  it('should log duration', async () => {
    const mockOutput = createMockOutput();
    const logger = createLogger({
      output: mockOutput,
      useColors: false,
      level: LOG_LEVELS.DEBUG,
    });

    const timer = logger.time('operation');
    await new Promise(r => setTimeout(r, 10));
    timer.end();

    const line = mockOutput.getLastLine();
    assert.ok(line.includes('operation'));
    assert.ok(line.includes('durationMs'));
  });
});

describe('Global logger', () => {
  it('should be configurable', () => {
    const mockOutput = createMockOutput();
    configureLogger({
      output: mockOutput,
      useColors: false,
      level: LOG_LEVELS.WARN,
    });

    const logger = getLogger();
    logger.info('Should not appear');
    logger.warn('Should appear');

    assert.strictEqual(mockOutput.getLines().length, 1);
    assert.ok(mockOutput.getLastLine().includes('Should appear'));
  });
});

describe('NONE level', () => {
  it('should disable all logging', () => {
    const mockOutput = createMockOutput();
    const logger = createLogger({
      output: mockOutput,
      level: LOG_LEVELS.NONE,
    });

    logger.debug('No');
    logger.info('No');
    logger.warn('No');
    logger.error('No');

    assert.strictEqual(mockOutput.getLines().length, 0);
  });
});
