/**
 * Prompt Processor Utilities
 *
 * Handles @filename syntax and other prompt preprocessing.
 *
 * Features:
 * - @filename replacement with file contents
 * - @directory/* for directory listings
 * - Supports relative and absolute paths
 * - Smart truncation for large files
 */

import { readFile, readdir, stat } from 'fs/promises';
import { resolve, dirname, basename, extname } from 'path';
import { glob } from 'glob';
import { sanitizePath, sanitizeGlobPatterns } from './security.js';

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  maxFileSize: 100000,        // Max characters per file (100K)
  maxTotalSize: 500000,       // Max total characters for all files (500K)
  truncationMessage: '\n... [truncated] ...\n',
  baseDir: process.cwd(),
};

/**
 * Process @filename syntax in a prompt
 *
 * Supported patterns:
 * - @filename.ext - Single file
 * - @path/to/file.ext - File with path
 * - @directory/* - All files in directory
 * - @pattern/*.js - Glob pattern
 *
 * @param {string} prompt - Prompt text with @filename references
 * @param {Object} options - Processing options
 * @returns {Promise<{processed: string, files: Array, errors: Array}>}
 */
export async function processPrompt(prompt, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const result = {
    processed: prompt,
    files: [],
    errors: [],
    totalSize: 0,
  };

  // Find all @references
  const atPattern = /@([^\s,;:'"<>|]+)/g;
  const matches = [...prompt.matchAll(atPattern)];

  if (matches.length === 0) {
    return result;
  }

  // Process each @reference
  for (const match of matches) {
    const fullMatch = match[0];
    const reference = match[1];

    try {
      const fileContent = await resolveReference(reference, config);

      if (fileContent.isGlob) {
        // Multiple files from glob
        let replacement = '';
        for (const file of fileContent.files) {
          const truncated = truncateContent(file.content, config.maxFileSize);
          replacement += `\n--- ${file.path} ---\n${truncated}\n`;
          result.files.push({ path: file.path, size: file.content.length });
          result.totalSize += truncated.length;

          if (result.totalSize > config.maxTotalSize) {
            result.errors.push(`Total size limit reached at ${file.path}`);
            break;
          }
        }
        result.processed = result.processed.replace(fullMatch, replacement);
      } else {
        // Single file
        const truncated = truncateContent(fileContent.content, config.maxFileSize);
        result.processed = result.processed.replace(fullMatch, truncated);
        result.files.push({ path: fileContent.path, size: fileContent.content.length });
        result.totalSize += truncated.length;
      }
    } catch (error) {
      result.errors.push(`Error processing ${fullMatch}: ${error.message}`);
      // Leave the reference as-is if we can't resolve it
    }
  }

  return result;
}

/**
 * Resolve a reference to file content(s)
 * Protected against path traversal attacks
 */
async function resolveReference(reference, config) {
  // Check if it's a glob pattern
  if (reference.includes('*')) {
    // Sanitize glob patterns to prevent traversal
    const sanitizedPatterns = sanitizeGlobPatterns([reference], config.baseDir);
    if (sanitizedPatterns.length === 0) {
      throw new Error(`Invalid glob pattern (path traversal blocked): ${reference}`);
    }

    const matches = await glob(sanitizedPatterns[0], {
      cwd: config.baseDir,
      absolute: true,
      nodir: true,
    });

    const files = [];
    for (const filepath of matches) {
      // Double-check each matched file is within baseDir
      const sanitizedPath = sanitizePath(filepath, config.baseDir);
      if (!sanitizedPath) {
        continue; // Skip files outside baseDir
      }
      try {
        const content = await readFile(sanitizedPath, 'utf-8');
        files.push({
          path: filepath.replace(config.baseDir, '').replace(/^[/\\]/, ''),
          content,
        });
      } catch (e) {
        // Skip unreadable files
      }
    }

    return { isGlob: true, files };
  }

  // Sanitize the path to prevent traversal attacks
  const sanitizedPath = sanitizePath(reference, config.baseDir);
  if (!sanitizedPath) {
    throw new Error(`Invalid path (path traversal blocked): ${reference}`);
  }

  // Check if it's a directory
  try {
    const stats = await stat(sanitizedPath);
    if (stats.isDirectory()) {
      // Return directory listing
      const entries = await readdir(sanitizedPath, { withFileTypes: true });
      const listing = entries
        .map(e => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`))
        .join('\n');
      return {
        isGlob: false,
        path: reference,
        content: `Directory listing for ${reference}:\n${listing}`,
      };
    }
  } catch (e) {
    // Not a directory, try as file
  }

  // Single file
  try {
    const content = await readFile(sanitizedPath, 'utf-8');
    return {
      isGlob: false,
      path: reference,
      content,
    };
  } catch (error) {
    throw new Error(`Cannot read file: ${reference}`);
  }
}

/**
 * Truncate content if it exceeds max size
 */
function truncateContent(content, maxSize) {
  if (content.length <= maxSize) {
    return content;
  }

  const halfSize = Math.floor(maxSize / 2) - 20;
  return (
    content.slice(0, halfSize) +
    `\n... [truncated ${content.length - maxSize} characters] ...\n` +
    content.slice(-halfSize)
  );
}

/**
 * Extract @filename references from text without processing
 */
export function extractReferences(text) {
  const atPattern = /@([^\s,;:'"<>|]+)/g;
  const matches = [...text.matchAll(atPattern)];
  return matches.map(m => ({
    full: m[0],
    reference: m[1],
    index: m.index,
  }));
}

/**
 * Check if a prompt contains @filename references
 */
export function hasFileReferences(text) {
  return /@[^\s,;:'"<>|]+/.test(text);
}

/**
 * Get language from file extension for code highlighting
 */
export function getLanguageFromPath(filepath) {
  const ext = extname(filepath).toLowerCase().slice(1);
  const langMap = {
    js: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    sql: 'sql',
    md: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
  };
  return langMap[ext] || ext || 'text';
}

export default {
  processPrompt,
  extractReferences,
  hasFileReferences,
  getLanguageFromPath,
};
