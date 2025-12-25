/**
 * Tests for tool-handlers base utilities
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, unlinkSync, readFileSync, mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  success,
  error,
  formatted,
  validateRequired,
  cleanCodeOutput,
  fetchWithTimeout,
  withHandler,
  runGitDiff,
  saveOutputToFile,
  saveDualOutputFiles,
  smartTruncate,
  processLargeOutput,
  estimateTokens,
  tokensToChars,
  exceedsTokenLimit,
} from '../src/mcp/tool-handlers/base.js';
import { OUTPUT_LIMITS } from '../src/config/timeouts.js';

describe('success', () => {
  it('should create successful response', () => {
    const result = success('test message');
    assert.deepStrictEqual(result, {
      content: [{ type: 'text', text: 'test message' }],
    });
  });

  it('should not have isError property', () => {
    const result = success('test');
    assert.strictEqual(result.isError, undefined);
  });
});

describe('error', () => {
  it('should create error response', () => {
    const result = error('test error');
    assert.deepStrictEqual(result, {
      content: [{ type: 'text', text: 'Error: test error' }],
      isError: true,
    });
  });

  it('should prefix with Error:', () => {
    const result = error('something went wrong');
    assert.ok(result.content[0].text.startsWith('Error:'));
  });
});

describe('formatted', () => {
  it('should create formatted response with header', () => {
    const result = formatted('[Test Header]', 'body content');
    assert.deepStrictEqual(result, {
      content: [{ type: 'text', text: '[Test Header]\n\nbody content' }],
    });
  });
});

describe('validateRequired', () => {
  it('should return null for valid args', () => {
    const result = validateRequired({ a: 'value', b: 123 }, ['a', 'b']);
    assert.strictEqual(result, null);
  });

  it('should return error for missing field', () => {
    const result = validateRequired({ a: 'value' }, ['a', 'b']);
    assert.strictEqual(result, 'Missing required argument: b');
  });

  it('should return error for null field', () => {
    const result = validateRequired({ a: null }, ['a']);
    assert.strictEqual(result, 'Missing required argument: a');
  });

  it('should return error for undefined field', () => {
    const result = validateRequired({ a: undefined }, ['a']);
    assert.strictEqual(result, 'Missing required argument: a');
  });

  it('should return error for empty string field', () => {
    const result = validateRequired({ a: '' }, ['a']);
    assert.strictEqual(result, 'Missing required argument: a');
  });

  it('should accept 0 as valid', () => {
    const result = validateRequired({ a: 0 }, ['a']);
    assert.strictEqual(result, null);
  });

  it('should accept false as valid', () => {
    const result = validateRequired({ a: false }, ['a']);
    assert.strictEqual(result, null);
  });
});

describe('cleanCodeOutput', () => {
  it('should remove markdown code blocks', () => {
    const input = '```javascript\nconst x = 1;\n```';
    const result = cleanCodeOutput(input);
    assert.strictEqual(result, 'const x = 1;');
  });

  it('should remove cached response suffix', () => {
    const input = 'const x = 1;_[cached response]_';
    const result = cleanCodeOutput(input);
    assert.strictEqual(result, 'const x = 1;');
  });

  it('should remove preamble before code', () => {
    const input = 'Here is the code:\n\nconst x = 1;';
    const result = cleanCodeOutput(input);
    assert.strictEqual(result, 'const x = 1;');
  });

  it('should detect JSDoc start', () => {
    const input = 'Some preamble\n/** Documentation */\nfunction test() {}';
    const result = cleanCodeOutput(input);
    assert.ok(result.startsWith('/**'));
  });

  it('should detect import statement', () => {
    const input = 'Let me create this:\nimport fs from "fs";\nconst x = 1;';
    const result = cleanCodeOutput(input);
    assert.ok(result.startsWith('import'));
  });

  it('should detect Python def', () => {
    const input = 'Here is the function:\ndef hello():\n    pass';
    const result = cleanCodeOutput(input);
    assert.ok(result.startsWith('def'));
  });

  it('should detect Rust fn', () => {
    const input = 'Implementation:\nfn main() {\n}';
    const result = cleanCodeOutput(input);
    assert.ok(result.startsWith('fn'));
  });

  it('should handle already clean code', () => {
    const input = 'const x = 1;\nconst y = 2;';
    const result = cleanCodeOutput(input);
    assert.strictEqual(result, input);
  });

  it('should trim whitespace', () => {
    const input = '  \n  const x = 1;  \n  ';
    const result = cleanCodeOutput(input);
    assert.strictEqual(result, 'const x = 1;');
  });
});

describe('fetchWithTimeout', () => {
  it('should return response for successful fetch', async () => {
    // Mock a simple response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('ok', { status: 200 });

    try {
      const response = await fetchWithTimeout('https://example.com', {}, 5000);
      assert.strictEqual(response.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should throw AbortError on timeout', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      // Wait longer than timeout
      await new Promise((resolve, reject) => {
        const id = setTimeout(resolve, 10000);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(id);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
      return new Response('ok');
    };

    try {
      await fetchWithTimeout('https://example.com', {}, 50);
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.name, 'AbortError');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('withHandler', () => {
  it('should pass through successful results', async () => {
    const handler = async () => success('worked');
    const wrapped = withHandler(handler, 'test_tool');

    const result = await wrapped({}, {});
    assert.deepStrictEqual(result, success('worked'));
  });

  it('should catch errors and return error response', async () => {
    const handler = async () => {
      throw new Error('something broke');
    };
    const wrapped = withHandler(handler, 'test_tool');

    const result = await wrapped({}, {});
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes('test_tool failed'));
    assert.ok(result.content[0].text.includes('something broke'));
  });

  it('should pass args and context to handler', async () => {
    let receivedArgs, receivedContext;
    const handler = async (args, context) => {
      receivedArgs = args;
      receivedContext = context;
      return success('ok');
    };
    const wrapped = withHandler(handler, 'test_tool');

    const testArgs = { foo: 'bar' };
    const testContext = { helper: () => {} };
    await wrapped(testArgs, testContext);

    assert.strictEqual(receivedArgs, testArgs);
    assert.strictEqual(receivedContext, testContext);
  });
});

describe('runGitDiff', () => {
  // Create a mock spawn and safeSpawn for testing
  const createMockSpawn = (stdout = '', stderr = '', exitCode = 0) => {
    const mockProc = {
      stdout: {
        on: (event, cb) => {
          if (event === 'data') setTimeout(() => cb(stdout), 0);
        }
      },
      stderr: {
        on: (event, cb) => {
          if (event === 'data' && stderr) setTimeout(() => cb(stderr), 0);
        }
      },
      on: (event, cb) => {
        if (event === 'close') setTimeout(() => cb(exitCode), 10);
        if (event === 'error') { /* no error by default */ }
      },
      kill: () => {}
    };
    return () => mockProc;
  };

  // Mock safeSpawn that tracks calls
  const createMockSafeSpawn = (mockSpawn) => {
    const calls = [];
    const fn = (spawn, cmd, args, opts) => {
      calls.push({ spawn, cmd, args, opts });
      return mockSpawn();
    };
    fn.calls = calls;
    return fn;
  };

  it('should pass --staged by default', async () => {
    const mockSpawn = createMockSpawn('diff output');
    const mockSafeSpawn = createMockSafeSpawn(mockSpawn);

    const result = await runGitDiff({
      spawn: {},
      safeSpawn: mockSafeSpawn,
      patterns: [],
      staged: true,
      timeout: 5000
    });

    assert.strictEqual(mockSafeSpawn.calls.length, 1);
    assert.ok(mockSafeSpawn.calls[0].args.includes('--staged'));
    assert.ok(result.includes('diff output'));
  });

  it('should not include --staged when staged is false', async () => {
    const mockSpawn = createMockSpawn('unstaged diff');
    const mockSafeSpawn = createMockSafeSpawn(mockSpawn);

    await runGitDiff({
      spawn: {},
      safeSpawn: mockSafeSpawn,
      patterns: [],
      staged: false,
      timeout: 5000
    });

    assert.strictEqual(mockSafeSpawn.calls[0].args.includes('--staged'), false);
  });

  it('should include file patterns when provided', async () => {
    const mockSpawn = createMockSpawn('pattern diff');
    const mockSafeSpawn = createMockSafeSpawn(mockSpawn);

    await runGitDiff({
      spawn: {},
      safeSpawn: mockSafeSpawn,
      patterns: ['*.js', '*.ts'],
      staged: true,
      timeout: 5000
    });

    assert.ok(mockSafeSpawn.calls[0].args.includes('*.js'));
    assert.ok(mockSafeSpawn.calls[0].args.includes('*.ts'));
  });

  it('should return timeout message when timeout exceeded', async () => {
    // Create a mock that never closes
    const mockProc = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {}
    };
    const mockSafeSpawn = () => mockProc;

    const result = await runGitDiff({
      spawn: {},
      safeSpawn: mockSafeSpawn,
      patterns: [],
      staged: true,
      timeout: 50 // Very short timeout
    });

    assert.ok(result.includes('timed out'));
  });

  it('should return "No staged changes" when staged diff is empty', async () => {
    const mockSpawn = createMockSpawn(''); // Empty output
    const mockSafeSpawn = createMockSafeSpawn(mockSpawn);

    const result = await runGitDiff({
      spawn: {},
      safeSpawn: mockSafeSpawn,
      patterns: [],
      staged: true,
      timeout: 5000
    });

    assert.ok(result.includes('No staged changes'));
  });

  it('should return "No changes" when unstaged diff is empty', async () => {
    const mockSpawn = createMockSpawn(''); // Empty output
    const mockSafeSpawn = createMockSafeSpawn(mockSpawn);

    const result = await runGitDiff({
      spawn: {},
      safeSpawn: mockSafeSpawn,
      patterns: [],
      staged: false,
      timeout: 5000
    });

    assert.ok(result.includes('No changes'));
  });
});

describe('saveOutputToFile', () => {
  const testFiles = [];

  afterEach(() => {
    // Clean up test files
    for (const file of testFiles) {
      try {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    testFiles.length = 0;
  });

  it('should save content to file and return path', () => {
    const content = 'Test content for saving';
    const filePath = saveOutputToFile(content, 'test-output');
    testFiles.push(filePath);

    assert.ok(existsSync(filePath), 'File should exist');
    assert.ok(filePath.includes('test-output'), 'Filename should include prefix');
    assert.ok(filePath.endsWith('.txt'), 'File should have .txt extension');

    const savedContent = readFileSync(filePath, 'utf8');
    assert.strictEqual(savedContent, content);
  });

  it('should create output directory if it does not exist', () => {
    const content = 'Test content';
    const filePath = saveOutputToFile(content, 'test-dir-creation');
    testFiles.push(filePath);

    const outputDir = join(homedir(), '.claude', 'gemini-worker-outputs');
    assert.ok(existsSync(outputDir), 'Output directory should exist');
  });

  it('should generate unique filenames with timestamps', async () => {
    const content1 = 'Content 1';
    const content2 = 'Content 2';

    const file1 = saveOutputToFile(content1, 'unique-test');
    // Small delay to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 5));
    const file2 = saveOutputToFile(content2, 'unique-test');
    testFiles.push(file1, file2);

    assert.notStrictEqual(file1, file2, 'Files should have different paths');
  });

  it('should handle large content', () => {
    const largeContent = 'x'.repeat(500000); // 500KB
    const filePath = saveOutputToFile(largeContent, 'large-test');
    testFiles.push(filePath);

    const savedContent = readFileSync(filePath, 'utf8');
    assert.strictEqual(savedContent.length, 500000);
  });

  it('should use default prefix when not provided', () => {
    const content = 'Default prefix test';
    const filePath = saveOutputToFile(content);
    testFiles.push(filePath);

    assert.ok(filePath.includes('agent-output'), 'Should use default prefix');
  });
});

describe('smartTruncate', () => {
  it('should return text unchanged if within target size', () => {
    const text = 'Short text that fits';
    const result = smartTruncate(text, 1000, '/fake/path.txt');
    assert.strictEqual(result, text);
  });

  it('should include truncation notice when truncating', () => {
    const longText = 'x'.repeat(1000);
    const result = smartTruncate(longText, 500, '/path/to/output.txt');

    assert.ok(result.includes('Output Truncated'), 'Should include truncation notice');
    assert.ok(result.includes('/path/to/output.txt'), 'Should include file path');
  });

  it('should extract and prioritize summary sections', () => {
    const textWithSummary = `
Some intro text

## Summary
This is the important summary that should be preserved.
It contains key information.

## Other Section
This is less important content that might be truncated.
${'x'.repeat(2000)}
`;

    const result = smartTruncate(textWithSummary, 1000, '/fake/path.txt');

    assert.ok(result.includes('Key Summary'), 'Should include key summary header');
    assert.ok(
      result.includes('important summary') || result.includes('Summary'),
      'Should preserve summary content'
    );
  });

  it('should extract recommendations section', () => {
    const textWithRecommendations = `
## Overview
Brief overview

## Recommendations
1. First recommendation
2. Second recommendation
3. Third recommendation

## Details
${'x'.repeat(2000)}
`;

    const result = smartTruncate(textWithRecommendations, 1500, '/fake/path.txt');

    assert.ok(
      result.includes('Recommendation') || result.includes('Key Recommendations'),
      'Should preserve recommendations'
    );
  });

  it('should extract issues/errors section', () => {
    const textWithIssues = `
## Analysis
Some analysis

## Security Concerns
- Critical: SQL injection vulnerability
- Warning: Missing input validation

## Appendix
${'x'.repeat(2000)}
`;

    const result = smartTruncate(textWithIssues, 1500, '/fake/path.txt');

    assert.ok(
      result.includes('Issues Found') || result.includes('Security'),
      'Should preserve issues section'
    );
  });

  it('should include tail of output', () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`Line ${i}: some content`);
    }
    const textWithManyLines = lines.join('\n');

    const result = smartTruncate(textWithManyLines, 2000, '/fake/path.txt');

    assert.ok(result.includes('End of Output'), 'Should include end of output section');
    assert.ok(result.includes('Line 99'), 'Should include last lines');
  });

  it('should include file reading instructions', () => {
    const longText = 'x'.repeat(1000);
    const result = smartTruncate(longText, 500, '/path/to/output.txt');

    assert.ok(result.includes('head'), 'Should include head command');
    assert.ok(result.includes('grep'), 'Should include grep command');
    assert.ok(result.includes('To read full output'), 'Should include instructions');
  });

  it('should show original size in KB', () => {
    const text = 'x'.repeat(10240); // 10KB
    const result = smartTruncate(text, 500, '/fake/path.txt');

    assert.ok(result.includes('10.0KB') || result.includes('10KB'), 'Should show size in KB');
  });
});

describe('processLargeOutput', () => {
  const testFiles = [];

  afterEach(() => {
    // Clean up test files
    for (const file of testFiles) {
      try {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    testFiles.length = 0;
  });

  it('should return unchanged output when within soft limit', () => {
    const smallOutput = 'x'.repeat(1000); // 1KB, well under 80KB limit

    const result = processLargeOutput(smallOutput);

    assert.strictEqual(result.text, smallOutput);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.savedToFile, false);
    assert.strictEqual(result.filePath, null);
    assert.strictEqual(result.summaryPath, null);
    assert.strictEqual(result.originalSize, 1000);
    assert.ok(result.estimatedTokens > 0, 'Should include estimated tokens');
  });

  it('should truncate and save when exceeding soft limit', () => {
    const largeOutput = 'x'.repeat(OUTPUT_LIMITS.MCP_SOFT_LIMIT + 1000);

    const result = processLargeOutput(largeOutput, { prefix: 'test-soft-limit' });
    if (result.filePath) testFiles.push(result.filePath);
    if (result.summaryPath) testFiles.push(result.summaryPath);

    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.savedToFile, true);
    assert.ok(result.filePath, 'Should have full file path');
    assert.ok(result.summaryPath, 'Should have summary file path');
    assert.ok(existsSync(result.filePath), 'Full file should exist');
    assert.ok(existsSync(result.summaryPath), 'Summary file should exist');
    assert.strictEqual(result.originalSize, OUTPUT_LIMITS.MCP_SOFT_LIMIT + 1000);
    assert.ok(result.estimatedTokens > 0, 'Should include estimated tokens');
  });

  it('should aggressively truncate when exceeding hard limit', () => {
    const hugeOutput = 'x'.repeat(OUTPUT_LIMITS.MCP_HARD_LIMIT + 50000);

    const result = processLargeOutput(hugeOutput, { prefix: 'test-hard-limit' });
    if (result.filePath) testFiles.push(result.filePath);
    if (result.summaryPath) testFiles.push(result.summaryPath);

    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.savedToFile, true);
    // The truncated output should be significantly smaller than the original
    // Allow some overhead for notices and instructions (up to 10KB extra)
    assert.ok(
      result.text.length <= OUTPUT_LIMITS.SUMMARY_TARGET + 10000,
      `Should be under summary target + overhead. Got ${result.text.length}, expected <= ${OUTPUT_LIMITS.SUMMARY_TARGET + 10000}`
    );
    assert.ok(
      result.text.length < result.originalSize / 2,
      'Truncated output should be much smaller than original'
    );
  });

  it('should force save when forceSave option is true', () => {
    const smallOutput = 'Small output that normally would not be saved';

    const result = processLargeOutput(smallOutput, { forceSave: true, prefix: 'test-force-save' });
    if (result.filePath) testFiles.push(result.filePath);
    if (result.summaryPath) testFiles.push(result.summaryPath);

    assert.strictEqual(result.savedToFile, true);
    assert.ok(result.filePath, 'Should have full file path');
    assert.ok(result.summaryPath, 'Should have summary file path');
    assert.ok(existsSync(result.filePath), 'Full file should exist');
    assert.ok(existsSync(result.summaryPath), 'Summary file should exist');
  });

  it('should use custom prefix in filename', () => {
    const largeOutput = 'x'.repeat(OUTPUT_LIMITS.MCP_SOFT_LIMIT + 1000);

    const result = processLargeOutput(largeOutput, { prefix: 'custom-prefix-test' });
    if (result.filePath) testFiles.push(result.filePath);
    if (result.summaryPath) testFiles.push(result.summaryPath);

    assert.ok(result.filePath.includes('custom-prefix-test'), 'Full filename should include custom prefix');
    assert.ok(result.summaryPath.includes('custom-prefix-test'), 'Summary filename should include custom prefix');
  });

  it('should preserve key sections in truncated output', () => {
    const outputWithSections = `
## Summary
Important summary content here.

## Recommendations
1. First recommendation
2. Second recommendation

## Raw Data
${'x'.repeat(OUTPUT_LIMITS.MCP_HARD_LIMIT)}
`;

    const result = processLargeOutput(outputWithSections, { prefix: 'test-sections' });
    if (result.filePath) testFiles.push(result.filePath);
    if (result.summaryPath) testFiles.push(result.summaryPath);

    assert.ok(result.truncated, 'Should be truncated');
    assert.ok(
      result.text.includes('Summary') || result.text.includes('Key Summary'),
      'Should preserve summary'
    );
  });

  it('should save full content to file even when truncating response', () => {
    const originalContent = 'Important header\n' + 'x'.repeat(OUTPUT_LIMITS.MCP_SOFT_LIMIT + 5000);

    const result = processLargeOutput(originalContent, { prefix: 'test-full-save' });
    if (result.filePath) testFiles.push(result.filePath);
    if (result.summaryPath) testFiles.push(result.summaryPath);

    assert.ok(result.savedToFile, 'Should save to file');

    const savedContent = readFileSync(result.filePath, 'utf8');
    assert.strictEqual(savedContent.length, originalContent.length, 'Full content should be saved');
    assert.ok(savedContent.startsWith('Important header'), 'Content should be intact');
  });

  it('should return correct metadata', () => {
    const output = 'x'.repeat(OUTPUT_LIMITS.MCP_SOFT_LIMIT + 2000);

    const result = processLargeOutput(output, { prefix: 'test-metadata' });
    if (result.filePath) testFiles.push(result.filePath);
    if (result.summaryPath) testFiles.push(result.summaryPath);

    assert.ok('text' in result, 'Should have text property');
    assert.ok('truncated' in result, 'Should have truncated property');
    assert.ok('savedToFile' in result, 'Should have savedToFile property');
    assert.ok('filePath' in result, 'Should have filePath property');
    assert.ok('summaryPath' in result, 'Should have summaryPath property');
    assert.ok('originalSize' in result, 'Should have originalSize property');
    assert.ok('estimatedTokens' in result, 'Should have estimatedTokens property');
    assert.strictEqual(typeof result.originalSize, 'number', 'originalSize should be number');
    assert.strictEqual(typeof result.estimatedTokens, 'number', 'estimatedTokens should be number');
  });

  it('should include summary file reference in response text', () => {
    const largeOutput = 'x'.repeat(OUTPUT_LIMITS.MCP_SOFT_LIMIT + 1000);

    const result = processLargeOutput(largeOutput, { prefix: 'test-summary-ref' });
    if (result.filePath) testFiles.push(result.filePath);
    if (result.summaryPath) testFiles.push(result.summaryPath);

    assert.ok(
      result.text.includes('Readable summary file'),
      'Response should mention summary file'
    );
    assert.ok(
      result.text.includes(result.summaryPath),
      'Response should include summary file path'
    );
  });

  it('should create summary file that fits within Read tool limits', () => {
    const hugeOutput = 'x'.repeat(OUTPUT_LIMITS.MCP_HARD_LIMIT * 2);

    const result = processLargeOutput(hugeOutput, { prefix: 'test-summary-size' });
    if (result.filePath) testFiles.push(result.filePath);
    if (result.summaryPath) testFiles.push(result.summaryPath);

    const summaryContent = readFileSync(result.summaryPath, 'utf8');
    const summaryTokens = estimateTokens(summaryContent);

    assert.ok(
      summaryTokens <= OUTPUT_LIMITS.READ_TOKEN_LIMIT,
      `Summary should fit in Read tool limit. Got ${summaryTokens} tokens, limit is ${OUTPUT_LIMITS.READ_TOKEN_LIMIT}`
    );
  });
});

describe('OUTPUT_LIMITS config', () => {
  it('should have expected limit values', () => {
    assert.ok(OUTPUT_LIMITS.MCP_SOFT_LIMIT > 0, 'MCP_SOFT_LIMIT should be positive');
    assert.ok(OUTPUT_LIMITS.MCP_HARD_LIMIT > 0, 'MCP_HARD_LIMIT should be positive');
    assert.ok(OUTPUT_LIMITS.SUMMARY_TARGET > 0, 'SUMMARY_TARGET should be positive');
    assert.ok(OUTPUT_LIMITS.SUMMARY_FILE_TARGET > 0, 'SUMMARY_FILE_TARGET should be positive');
    assert.ok(OUTPUT_LIMITS.TRUNCATE_TAIL_LINES > 0, 'TRUNCATE_TAIL_LINES should be positive');
    assert.ok(OUTPUT_LIMITS.CHARS_PER_TOKEN > 0, 'CHARS_PER_TOKEN should be positive');
    assert.ok(OUTPUT_LIMITS.MCP_TOKEN_LIMIT > 0, 'MCP_TOKEN_LIMIT should be positive');
    assert.ok(OUTPUT_LIMITS.READ_TOKEN_LIMIT > 0, 'READ_TOKEN_LIMIT should be positive');
  });

  it('should have logical limit hierarchy', () => {
    assert.ok(
      OUTPUT_LIMITS.SUMMARY_TARGET < OUTPUT_LIMITS.MCP_SOFT_LIMIT,
      'SUMMARY_TARGET should be less than MCP_SOFT_LIMIT'
    );
    assert.ok(
      OUTPUT_LIMITS.MCP_SOFT_LIMIT < OUTPUT_LIMITS.MCP_HARD_LIMIT,
      'MCP_SOFT_LIMIT should be less than MCP_HARD_LIMIT'
    );
    assert.ok(
      OUTPUT_LIMITS.SUMMARY_FILE_TARGET <= OUTPUT_LIMITS.READ_TOKEN_LIMIT * OUTPUT_LIMITS.CHARS_PER_TOKEN,
      'SUMMARY_FILE_TARGET should fit within READ_TOKEN_LIMIT'
    );
  });

  it('should have token limits that correspond to character limits', () => {
    // MCP_SOFT_LIMIT should be approximately MCP_TOKEN_LIMIT * CHARS_PER_TOKEN
    const expectedSoftLimit = OUTPUT_LIMITS.MCP_TOKEN_LIMIT * OUTPUT_LIMITS.CHARS_PER_TOKEN;
    assert.ok(
      Math.abs(OUTPUT_LIMITS.MCP_SOFT_LIMIT - expectedSoftLimit) < 10000,
      'MCP_SOFT_LIMIT should roughly match MCP_TOKEN_LIMIT * CHARS_PER_TOKEN'
    );
  });
});

describe('estimateTokens', () => {
  it('should estimate tokens from text length', () => {
    const text = 'x'.repeat(400); // 400 chars
    const tokens = estimateTokens(text);
    assert.strictEqual(tokens, 100, 'Should estimate ~4 chars per token');
  });

  it('should return 0 for empty string', () => {
    assert.strictEqual(estimateTokens(''), 0);
  });

  it('should return 0 for null input', () => {
    assert.strictEqual(estimateTokens(null), 0);
  });

  it('should return 0 for undefined input', () => {
    assert.strictEqual(estimateTokens(undefined), 0);
  });

  it('should return 0 for non-string input', () => {
    assert.strictEqual(estimateTokens(123), 0);
  });

  it('should round up for partial tokens', () => {
    const text = 'x'.repeat(5); // 5 chars = 1.25 tokens -> 2
    const tokens = estimateTokens(text);
    assert.strictEqual(tokens, 2);
  });
});

describe('tokensToChars', () => {
  it('should convert tokens to characters', () => {
    const chars = tokensToChars(100);
    assert.strictEqual(chars, 400, 'Should multiply by CHARS_PER_TOKEN');
  });

  it('should handle zero', () => {
    assert.strictEqual(tokensToChars(0), 0);
  });
});

describe('exceedsTokenLimit', () => {
  it('should return true when text exceeds token limit', () => {
    const text = 'x'.repeat(1000); // 1000 chars = 250 tokens
    assert.strictEqual(exceedsTokenLimit(text, 200), true);
  });

  it('should return false when text is within token limit', () => {
    const text = 'x'.repeat(400); // 400 chars = 100 tokens
    assert.strictEqual(exceedsTokenLimit(text, 200), false);
  });

  it('should return false for exactly at limit', () => {
    const text = 'x'.repeat(800); // 800 chars = 200 tokens
    assert.strictEqual(exceedsTokenLimit(text, 200), false);
  });
});

describe('saveDualOutputFiles', () => {
  const testFiles = [];

  afterEach(() => {
    for (const file of testFiles) {
      try {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    testFiles.length = 0;
  });

  it('should save both full and summary files', () => {
    const fullContent = 'Full content here';
    const summaryContent = 'Summary content';

    const result = saveDualOutputFiles(fullContent, summaryContent, 'test-dual');
    testFiles.push(result.fullPath, result.summaryPath);

    assert.ok(existsSync(result.fullPath), 'Full file should exist');
    assert.ok(existsSync(result.summaryPath), 'Summary file should exist');
  });

  it('should include -full and -summary suffixes', () => {
    const result = saveDualOutputFiles('full', 'summary', 'test-suffixes');
    testFiles.push(result.fullPath, result.summaryPath);

    assert.ok(result.fullPath.includes('-full.txt'), 'Full path should have -full suffix');
    assert.ok(result.summaryPath.includes('-summary.txt'), 'Summary path should have -summary suffix');
  });

  it('should save correct content to full file', () => {
    const fullContent = 'This is the full content';
    const result = saveDualOutputFiles(fullContent, 'summary', 'test-full-content');
    testFiles.push(result.fullPath, result.summaryPath);

    const savedFull = readFileSync(result.fullPath, 'utf8');
    assert.strictEqual(savedFull, fullContent);
  });

  it('should include metadata in summary file', () => {
    const result = saveDualOutputFiles('full content', 'summary content', 'test-meta');
    testFiles.push(result.fullPath, result.summaryPath);

    const savedSummary = readFileSync(result.summaryPath, 'utf8');
    assert.ok(savedSummary.includes('# Output Summary'), 'Should include header');
    assert.ok(savedSummary.includes('Full output:'), 'Should include full path reference');
    assert.ok(savedSummary.includes('Full size:'), 'Should include size info');
    assert.ok(savedSummary.includes('summary content'), 'Should include summary content');
  });

  it('should return correct sizes', () => {
    const fullContent = 'x'.repeat(1000);
    const summaryContent = 'y'.repeat(100);

    const result = saveDualOutputFiles(fullContent, summaryContent, 'test-sizes');
    testFiles.push(result.fullPath, result.summaryPath);

    assert.strictEqual(result.fullSize, 1000, 'Full size should match content length');
    assert.ok(result.summarySize > 100, 'Summary size should include metadata');
  });
});
