/**
 * Tests for security utilities
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { spawn } from 'child_process';
import {
  sanitizePath,
  sanitizeGlobPatterns,
  sanitizeCommandArg,
  sanitizeGitPatterns,
  spawnWithTimeout,
  safeSpawn,
  isWriteAllowed,
  validateDirectory,
  validateFile,
  TIMEOUTS,
} from '../src/utils/security.js';

describe('sanitizePath', () => {
  // Use process.cwd() for cross-platform testing
  const baseDir = process.cwd();

  it('should allow valid relative paths', () => {
    const result = sanitizePath('src/index.js', baseDir);
    assert.strictEqual(result, join(baseDir, 'src', 'index.js'));
  });

  it('should allow nested paths', () => {
    const result = sanitizePath('src/utils/helper.js', baseDir);
    assert.strictEqual(result, join(baseDir, 'src', 'utils', 'helper.js'));
  });

  it('should reject paths with ..', () => {
    const result = sanitizePath('../etc/passwd', baseDir);
    assert.strictEqual(result, null);
  });

  it('should reject paths that escape via nested ..', () => {
    const result = sanitizePath('src/../../etc/passwd', baseDir);
    assert.strictEqual(result, null);
  });

  it('should reject absolute paths', () => {
    const result = sanitizePath('/etc/passwd', baseDir);
    assert.strictEqual(result, null);
  });

  it('should reject null input', () => {
    const result = sanitizePath(null, baseDir);
    assert.strictEqual(result, null);
  });

  it('should reject non-string input', () => {
    const result = sanitizePath(123, baseDir);
    assert.strictEqual(result, null);
  });

  it('should handle Windows-style path separators', () => {
    // The path should be normalized
    const result = sanitizePath('src\\utils\\helper.js', baseDir);
    // Should not be null (valid path)
    assert.notStrictEqual(result, null);
  });
});

describe('sanitizeGlobPatterns', () => {
  it('should allow valid patterns', () => {
    const patterns = ['src/**/*.js', 'tests/*.test.js'];
    const result = sanitizeGlobPatterns(patterns);
    assert.deepStrictEqual(result, patterns);
  });

  it('should reject patterns with ..', () => {
    const patterns = ['../secret/**/*', 'src/**/*.js'];
    const result = sanitizeGlobPatterns(patterns);
    assert.deepStrictEqual(result, ['src/**/*.js']);
  });

  it('should reject absolute paths', () => {
    const patterns = ['/etc/passwd', 'src/**/*.js'];
    const result = sanitizeGlobPatterns(patterns);
    assert.deepStrictEqual(result, ['src/**/*.js']);
  });

  it('should reject patterns starting with /', () => {
    const patterns = ['/home/user/*', 'src/*.js'];
    const result = sanitizeGlobPatterns(patterns);
    assert.deepStrictEqual(result, ['src/*.js']);
  });

  it('should handle empty array', () => {
    const result = sanitizeGlobPatterns([]);
    assert.deepStrictEqual(result, []);
  });

  it('should handle non-array input', () => {
    const result = sanitizeGlobPatterns('not an array');
    assert.deepStrictEqual(result, []);
  });

  it('should filter non-string patterns', () => {
    const patterns = ['valid.js', 123, null, 'also-valid.js'];
    const result = sanitizeGlobPatterns(patterns);
    assert.deepStrictEqual(result, ['valid.js', 'also-valid.js']);
  });
});

describe('sanitizeCommandArg', () => {
  it('should pass through safe strings', () => {
    const result = sanitizeCommandArg('hello-world');
    assert.strictEqual(result, 'hello-world');
  });

  it('should remove shell injection characters using WHITELIST approach', () => {
    // New whitelist approach: only allow alphanumeric, dash, underscore, dot
    const result = sanitizeCommandArg('hello; rm -rf /');
    // Semicolon, spaces, slashes removed (not in whitelist)
    assert.strictEqual(result, 'hellorm-rf');
  });

  it('should remove backticks', () => {
    const result = sanitizeCommandArg('hello `whoami`');
    // Backticks and spaces removed
    assert.strictEqual(result, 'hellowhoami');
  });

  it('should remove dollar signs', () => {
    const result = sanitizeCommandArg('hello $USER');
    // Dollar sign and space removed
    assert.strictEqual(result, 'helloUSER');
  });

  it('should remove pipes', () => {
    const result = sanitizeCommandArg('ls | grep secret');
    // Pipes and spaces removed
    assert.strictEqual(result, 'lsgrepsecret');
  });

  it('should remove ampersands', () => {
    const result = sanitizeCommandArg('cmd1 && cmd2');
    // Ampersands and spaces removed
    assert.strictEqual(result, 'cmd1cmd2');
  });

  it('should handle non-string input', () => {
    const result = sanitizeCommandArg(123);
    assert.strictEqual(result, '');
  });

  it('should allow paths when option enabled', () => {
    const result = sanitizeCommandArg('src/file.js', { allowPaths: true });
    assert.strictEqual(result, 'src/file.js');
  });

  it('should allow globs when option enabled', () => {
    const result = sanitizeCommandArg('src/*.js', { allowPaths: true, allowGlobs: true });
    assert.strictEqual(result, 'src/*.js');
  });

  it('should allow spaces when option enabled', () => {
    const result = sanitizeCommandArg('hello world', { allowSpaces: true });
    assert.strictEqual(result, 'hello world');
  });
});

describe('sanitizeGitPatterns', () => {
  it('should allow safe file patterns', () => {
    const patterns = ['src/*.js', 'tests/test.js', 'README.md'];
    const result = sanitizeGitPatterns(patterns);
    assert.deepStrictEqual(result, patterns);
  });

  it('should reject patterns with shell characters', () => {
    const patterns = ['src/*.js', 'file; rm -rf /', 'tests/*.js'];
    const result = sanitizeGitPatterns(patterns);
    assert.deepStrictEqual(result, ['src/*.js', 'tests/*.js']);
  });

  it('should reject patterns with spaces', () => {
    const patterns = ['src/*.js', 'my file.js', 'tests/*.js'];
    const result = sanitizeGitPatterns(patterns);
    assert.deepStrictEqual(result, ['src/*.js', 'tests/*.js']);
  });

  it('should reject patterns with backticks', () => {
    const patterns = ['`whoami`.js'];
    const result = sanitizeGitPatterns(patterns);
    assert.deepStrictEqual(result, []);
  });

  it('should handle empty array', () => {
    const result = sanitizeGitPatterns([]);
    assert.deepStrictEqual(result, []);
  });
});

describe('TIMEOUTS', () => {
  it('should have correct timeout values', () => {
    assert.strictEqual(TIMEOUTS.QUICK, 30000);
    assert.strictEqual(TIMEOUTS.DEFAULT, 60000);
    assert.strictEqual(TIMEOUTS.LONG, 120000);
    assert.strictEqual(TIMEOUTS.EXTENDED, 300000);
  });
});

describe('spawnWithTimeout', () => {
  it('should resolve with output on successful command', async () => {
    // Use a simple command that works on both Windows and Unix
    const cmd = process.platform === 'win32' ? 'cmd' : 'echo';
    const args = process.platform === 'win32' ? ['/c', 'echo', 'hello'] : ['hello'];

    const result = await spawnWithTimeout(spawn, cmd, args, {}, 5000);

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('hello'));
  });

  it('should capture stderr', async () => {
    // Use node to write to stderr
    const result = await spawnWithTimeout(
      spawn,
      'node',
      ['-e', 'console.error("error message")'],
      {},
      5000
    );

    assert.strictEqual(result.code, 0);
    assert.ok(result.stderr.includes('error message'));
  });

  it('should reject on timeout', async () => {
    // Use a command that sleeps longer than the timeout
    const cmd = process.platform === 'win32' ? 'ping' : 'sleep';
    const args = process.platform === 'win32' ? ['-n', '10', '127.0.0.1'] : ['10'];

    await assert.rejects(
      spawnWithTimeout(spawn, cmd, args, { shell: true }, 100), // 100ms timeout
      /timed out/i
    );
  });

  it('should handle non-zero exit codes', async () => {
    const result = await spawnWithTimeout(
      spawn,
      'node',
      ['-e', 'process.exit(42)'],
      {},
      5000
    );

    assert.strictEqual(result.code, 42);
  });

  it('should handle process errors', async () => {
    await assert.rejects(
      spawnWithTimeout(spawn, 'nonexistent-command-xyz', [], {}, 5000),
      /ENOENT|not found/i
    );
  });
});

describe('safeSpawn', () => {
  const mockSpawn = (cmd, args, opts) => ({
    cmd,
    args,
    opts,
    on: () => {},
    kill: () => {},
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    killed: false
  });

  it('should enforce shell: false even if requested', () => {
    const result = safeSpawn(mockSpawn, 'echo', ['test'], { shell: true });
    assert.strictEqual(result.opts.shell, false);
  });

  it('should filter non-string arguments', () => {
    const result = safeSpawn(mockSpawn, 'echo', ['test', 123, null, 'string']);
    assert.deepStrictEqual(result.args, ['test', 'string']);
  });

  if (process.platform === 'win32') {
    it('should wrap known command-files with cmd.exe /c on Windows', () => {
      const result = safeSpawn(mockSpawn, 'npm', ['install']);
      assert.strictEqual(result.cmd, 'cmd.exe');
      assert.deepStrictEqual(result.args, ['/c', 'npm', 'install']);
      assert.strictEqual(result.opts.windowsHide, true);
    });

    it('should not wrap unknown commands on Windows', () => {
      const result = safeSpawn(mockSpawn, 'notepad.exe', []);
      assert.strictEqual(result.cmd, 'notepad.exe');
    });
  } else {
    it('should not wrap commands on non-Windows', () => {
      const result = safeSpawn(mockSpawn, 'npm', ['install']);
      assert.strictEqual(result.cmd, 'npm');
      assert.deepStrictEqual(result.args, ['install']);
    });
  }

  it('should return a process-like object', () => {
    const result = safeSpawn(mockSpawn, 'echo', []);
    assert.ok(result.stdout);
    assert.ok(result.stderr);
    assert.strictEqual(typeof result.on, 'function');
    assert.strictEqual(typeof result.kill, 'function');
  });
});

describe('isWriteAllowed', () => {
  const baseDir = process.cwd();

  it('should allow normal source files', () => {
    const result = isWriteAllowed('src/components/Button.js', baseDir);
    assert.strictEqual(result.allowed, true);
  });

  it('should reject protected files', () => {
    const result = isWriteAllowed('package.json', baseDir);
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason, /Protected file/);
  });

  it('should reject protected directories', () => {
    const result = isWriteAllowed('node_modules/library/index.js', baseDir);
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason, /Protected directory/);
  });

  it('should reject dangerous extensions', () => {
    const result = isWriteAllowed('script.sh', baseDir);
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason, /Dangerous file extension/);
  });

  it('should reject hidden files unless allowed', () => {
    const result = isWriteAllowed('.config', baseDir);
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason, /Hidden\/config file/);
  });

  it('should allow .test hidden files', () => {
    // Use a non-protected directory and safe extension
    const result = isWriteAllowed('temp/.test.helper.js', baseDir);
    assert.strictEqual(result.allowed, true);
  });

  it('should reject path traversal', () => {
    const result = isWriteAllowed('../secrets.txt', baseDir);
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason, /Path traversal/);
  });
});

describe('validateDirectory', () => {
  const baseDir = process.cwd();

  it('should return sanitized path for valid directory', async () => {
    // 'src' guarantees existence in this project
    const result = await validateDirectory('src', baseDir);
    assert.strictEqual(result, join(baseDir, 'src'));
  });

  it('should return null for non-existent path', async () => {
    const result = await validateDirectory('nonexistent-dir-XYZ', baseDir);
    assert.strictEqual(result, null);
  });

  it('should return null for files (not directories)', async () => {
    // 'package.json' guarantees existence as file
    const result = await validateDirectory('package.json', baseDir);
    assert.strictEqual(result, null);
  });

  it('should return null for path traversal attempts', async () => {
    const result = await validateDirectory('../', baseDir);
    assert.strictEqual(result, null);
  });
});

describe('validateFile', () => {
  const baseDir = process.cwd();

  it('should return sanitized path for valid file', async () => {
    // 'package.json' guarantees existence
    const result = await validateFile('package.json', baseDir);
    assert.strictEqual(result, join(baseDir, 'package.json'));
  });

  it('should return null for non-existent paths', async () => {
    const result = await validateFile('nonexistent-file.js', baseDir);
    assert.strictEqual(result, null);
  });

  it('should return null for directories (not files)', async () => {
    // 'src' guarantees existence as dir
    const result = await validateFile('src', baseDir);
    assert.strictEqual(result, null);
  });

  it('should return null for path traversal attempts', async () => {
    const result = await validateFile('../outside.js', baseDir);
    assert.strictEqual(result, null);
  });
});