/**
 * Base utilities for tool handlers
 * Provides shared functionality and types for all tool handlers
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { OUTPUT_LIMITS } from '../../config/timeouts.js';

/**
 * Estimate token count from text length
 * Uses conservative estimate of ~4 characters per token
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / OUTPUT_LIMITS.CHARS_PER_TOKEN);
}

/**
 * Estimate character count from token limit
 * @param {number} tokens - Token limit
 * @returns {number} Estimated character limit
 */
export function tokensToChars(tokens) {
  return tokens * OUTPUT_LIMITS.CHARS_PER_TOKEN;
}

/**
 * Check if text exceeds token limit
 * @param {string} text - Text to check
 * @param {number} tokenLimit - Token limit to check against
 * @returns {boolean} True if exceeds limit
 */
export function exceedsTokenLimit(text, tokenLimit) {
  return estimateTokens(text) > tokenLimit;
}

/**
 * Create a successful tool response
 * @param {string} text - Response text
 * @returns {Object} MCP tool response
 */
export function success(text) {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Create an error tool response
 * @param {string} message - Error message
 * @returns {Object} MCP error response
 */
export function error(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Create a formatted response with a header
 * @param {string} header - Header text (e.g., "[Code Review]")
 * @param {string} body - Response body
 * @returns {Object} MCP tool response
 */
export function formatted(header, body) {
  return {
    content: [{ type: 'text', text: `${header}\n\n${body}` }],
  };
}

/**
 * Validate required arguments
 * @param {Object} args - Arguments object
 * @param {string[]} required - Required field names
 * @returns {string|null} Error message or null if valid
 */
export function validateRequired(args, required) {
  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === '') {
      return `Missing required argument: ${field}`;
    }
  }
  return null;
}

/**
 * Execute git diff with timeout
 * @param {Object} options - Options object
 * @param {Function} options.spawn - Node spawn function
 * @param {Function} options.safeSpawn - Safe spawn wrapper
 * @param {string[]} [options.patterns=[]] - File patterns to diff
 * @param {boolean} [options.staged=true] - Whether to diff staged changes
 * @param {number} [options.timeout=10000] - Timeout in milliseconds
 * @returns {Promise<string>} Git diff output
 */
export function runGitDiff({ spawn, safeSpawn, patterns = [], staged = true, timeout = 10000 }) {
  return new Promise((resolve) => {
    const args = ['diff'];
    if (staged) args.push('--staged');
    if (patterns.length > 0) args.push(...patterns);

    const proc = safeSpawn(spawn, 'git', args, {});
    let stdout = '';
    let killed = false;

    const timeoutId = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      resolve('Git diff timed out');
    }, timeout);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timeoutId);
      if (!killed) resolve(stdout || (staged ? 'No staged changes' : 'No changes'));
    });
    proc.on('error', () => {
      clearTimeout(timeoutId);
      if (!killed) resolve('Failed to get git diff');
    });
  });
}

/**
 * Fetch with timeout using AbortController
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} [timeout=60000] - Timeout in milliseconds
 * @returns {Promise<Response>} Fetch response
 */
export async function fetchWithTimeout(url, options = {}, timeout = 60000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Clean LLM code output by removing markdown and preamble
 * @param {string} code - Raw code from LLM
 * @returns {string} Cleaned code
 */
export function cleanCodeOutput(code) {
  let cleanCode = code
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/```$/gm, '')
    .replace(/_\[cached response\]_$/g, '')
    .trim();

  // Patterns that indicate actual code start
  const codeStartPatterns = [
    /^\/\*\*/m,
    /^\/\//m,
    /^["']use strict["']/m,
    /^import\s/m,
    /^export\s/m,
    /^const\s/m,
    /^let\s/m,
    /^var\s/m,
    /^function\s/m,
    /^class\s/m,
    /^#!\/.*\n/m,
    /^def\s/m,           // Python
    /^from\s/m,          // Python imports
    /^package\s/m,       // Go/Java
    /^use\s/m,           // Rust
    /^fn\s/m,            // Rust
    /^struct\s/m,        // Rust/Go
    /^pub\s/m,           // Rust
  ];

  for (const pattern of codeStartPatterns) {
    const match = cleanCode.match(pattern);
    if (match) {
      const startIndex = cleanCode.indexOf(match[0]);
      if (startIndex > 0) {
        cleanCode = cleanCode.substring(startIndex);
      }
      break;
    }
  }

  return cleanCode;
}

/**
 * Higher-order function to wrap handlers with error handling
 * @param {Function} handlerFn - The handler function to wrap
 * @param {string} toolName - Name of the tool for error messages
 * @returns {Function} Wrapped handler function
 */
export function withHandler(handlerFn, toolName) {
  return async function wrappedHandler(args, context) {
    try {
      return await handlerFn(args, context);
    } catch (err) {
      return error(`${toolName} failed: ${err.message}`);
    }
  };
}

/**
 * Tool handler result type
 * @typedef {Object} HandlerResult
 * @property {Array<{type: string, text: string}>} content - Response content
 * @property {boolean} [isError] - Whether this is an error response
 */

/**
 * Tool handler context - shared dependencies injected into handlers
 * @typedef {Object} HandlerContext
 * @property {Function} runGeminiCli - Execute Gemini CLI
 * @property {Function} getResponseCache - Get response cache instance
 * @property {Function} getConversationManager - Get conversation manager
 * @property {Function} readFilesFromPatterns - Read files from glob patterns
 * @property {Object} AUTH_CONFIG - Authentication configuration
 * @property {Object} TIMEOUTS - Timeout constants
 * @property {Function} sanitizePath - Path sanitization
 * @property {Function} sanitizeGlobPatterns - Glob pattern sanitization
 * @property {Function} isWriteAllowed - File write validation
 * @property {Function} safeSpawn - Safe process spawn
 */

/**
 * Get the output directory for saving large tool results
 * @returns {string} Path to output directory
 */
function getOutputDir() {
  const baseDir = join(homedir(), '.claude', 'gemini-worker-outputs');
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }
  return baseDir;
}

/**
 * Save large output to file and return file path
 * @param {string} content - Content to save
 * @param {string} prefix - Filename prefix
 * @returns {string} Path to saved file
 */
export function saveOutputToFile(content, prefix = 'agent-output') {
  const outputDir = getOutputDir();
  const timestamp = Date.now();
  const filename = `${prefix}-${timestamp}.txt`;
  const filepath = join(outputDir, filename);

  writeFileSync(filepath, content, 'utf8');
  return filepath;
}

/**
 * Save both full output and a summary file that fits within Read tool limits
 * @param {string} content - Full content to save
 * @param {string} summaryContent - Truncated summary content
 * @param {string} prefix - Filename prefix
 * @returns {Object} Paths to both files
 */
export function saveDualOutputFiles(content, summaryContent, prefix = 'agent-output') {
  const outputDir = getOutputDir();
  const timestamp = Date.now();

  // Save full output
  const fullFilename = `${prefix}-${timestamp}-full.txt`;
  const fullPath = join(outputDir, fullFilename);
  writeFileSync(fullPath, content, 'utf8');

  // Save summary that fits within Read tool limits
  const summaryFilename = `${prefix}-${timestamp}-summary.txt`;
  const summaryPath = join(outputDir, summaryFilename);

  // Build summary file with metadata
  const summaryWithMeta = [
    '# Output Summary',
    '',
    `**Full output:** \`${fullPath}\``,
    `**Full size:** ${(content.length / 1024).toFixed(1)}KB (~${estimateTokens(content).toLocaleString()} tokens)`,
    `**Summary size:** ${(summaryContent.length / 1024).toFixed(1)}KB (~${estimateTokens(summaryContent).toLocaleString()} tokens)`,
    '',
    '---',
    '',
    summaryContent
  ].join('\n');

  writeFileSync(summaryPath, summaryWithMeta, 'utf8');

  return {
    fullPath,
    summaryPath,
    fullSize: content.length,
    summarySize: summaryWithMeta.length
  };
}

/**
 * Extract key sections from agent output (Summary, Recommendations, etc.)
 * @param {string} text - Full output text
 * @returns {Object} Extracted sections
 */
function extractKeySections(text) {
  const sections = {
    summary: '',
    recommendations: '',
    errors: '',
    files: '',
    other: ''
  };

  // Patterns to identify key sections (case insensitive)
  const sectionPatterns = [
    { key: 'summary', patterns: [/^#{1,3}\s*(?:executive\s+)?summary/im, /^#{1,3}\s*overview/im, /^#{1,3}\s*project\s+overview/im] },
    { key: 'recommendations', patterns: [/^#{1,3}\s*recommendations?/im, /^#{1,3}\s*suggestions?/im, /^#{1,3}\s*improvements?/im] },
    { key: 'errors', patterns: [/^#{1,3}\s*errors?/im, /^#{1,3}\s*issues?/im, /^#{1,3}\s*problems?/im, /^#{1,3}\s*security\s+concerns?/im] },
    { key: 'files', patterns: [/^#{1,3}\s*files?\s+(?:created|modified|changed)/im] }
  ];

  const lines = text.split('\n');
  let currentSection = 'other';
  let currentContent = [];

  for (const line of lines) {
    // Check if this line starts a new section
    let foundSection = false;
    for (const { key, patterns } of sectionPatterns) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          // Save previous section
          if (currentContent.length > 0) {
            sections[currentSection] += currentContent.join('\n') + '\n\n';
          }
          currentSection = key;
          currentContent = [line];
          foundSection = true;
          break;
        }
      }
      if (foundSection) break;
    }

    if (!foundSection) {
      currentContent.push(line);
    }
  }

  // Save final section
  if (currentContent.length > 0) {
    sections[currentSection] += currentContent.join('\n');
  }

  return sections;
}

/**
 * Create a smart truncation of large output
 * Preserves key sections and adds truncation notice
 * @param {string} text - Full output text
 * @param {number} targetSize - Target size in characters
 * @param {string} savedFilePath - Path where full output was saved
 * @returns {string} Truncated output
 */
export function smartTruncate(text, targetSize, savedFilePath) {
  if (text.length <= targetSize) {
    return text;
  }

  const sections = extractKeySections(text);
  const lines = text.split('\n');

  // Build truncated output prioritizing key sections
  const parts = [];

  // Always include notice at the top
  parts.push('⚠️ **Output Truncated** - Full output saved to file');
  parts.push(`📁 **Full output:** \`${savedFilePath}\``);
  parts.push(`📊 **Original size:** ${(text.length / 1024).toFixed(1)}KB`);
  parts.push('');
  parts.push('---');
  parts.push('');

  let currentSize = parts.join('\n').length;
  const reserveForTail = 2000; // Reserve space for tail lines
  const availableForSections = targetSize - currentSize - reserveForTail;

  // Add summary section if present (highest priority)
  if (sections.summary.trim()) {
    const summaryTruncated = sections.summary.substring(0, Math.floor(availableForSections * 0.4));
    parts.push('## Key Summary');
    parts.push(summaryTruncated);
    parts.push('');
    currentSize += summaryTruncated.length + 20;
  }

  // Add recommendations if present
  if (sections.recommendations.trim() && currentSize < targetSize - reserveForTail - 1000) {
    const recsAvailable = Math.min(sections.recommendations.length, Math.floor(availableForSections * 0.3));
    const recsTruncated = sections.recommendations.substring(0, recsAvailable);
    parts.push('## Key Recommendations');
    parts.push(recsTruncated);
    parts.push('');
    currentSize += recsTruncated.length + 25;
  }

  // Add errors/issues if present
  if (sections.errors.trim() && currentSize < targetSize - reserveForTail - 500) {
    const errorsAvailable = Math.min(sections.errors.length, Math.floor(availableForSections * 0.2));
    const errorsTruncated = sections.errors.substring(0, errorsAvailable);
    parts.push('## Issues Found');
    parts.push(errorsTruncated);
    parts.push('');
    currentSize += errorsTruncated.length + 20;
  }

  // Add tail of output (last N lines often contain conclusions)
  // Cap tail size to prevent huge single-line outputs from bloating the result
  const maxTailSize = 3000; // 3KB max for tail section
  parts.push('---');
  parts.push('');
  parts.push('## End of Output (last lines)');
  let tailContent = lines.slice(-OUTPUT_LIMITS.TRUNCATE_TAIL_LINES).join('\n');
  if (tailContent.length > maxTailSize) {
    tailContent = '...' + tailContent.slice(-maxTailSize);
  }
  parts.push(tailContent);

  // Add instructions for reading full output
  parts.push('');
  parts.push('---');
  parts.push('');
  parts.push('**To read full output:**');
  parts.push('```bash');
  parts.push(`# Read first 500 lines`);
  parts.push(`head -500 "${savedFilePath}"`);
  parts.push('');
  parts.push(`# Search for specific content`);
  parts.push(`grep -i "recommendation" "${savedFilePath}"`);
  parts.push('```');

  return parts.join('\n');
}

/**
 * Process output that may exceed MCP limits
 * Saves both full output and a readable summary when truncating
 * @param {string} output - Raw output from tool
 * @param {Object} options - Processing options
 * @param {string} [options.prefix='output'] - Filename prefix if saved
 * @param {boolean} [options.forceSave=false] - Always save to file
 * @returns {Object} Processed result with text and metadata
 */
export function processLargeOutput(output, options = {}) {
  const { prefix = 'output', forceSave = false } = options;
  const outputLength = output.length;
  const estimatedTokens = estimateTokens(output);

  // Check if output is within limits (use token-based check as primary)
  const withinTokenLimit = estimatedTokens <= OUTPUT_LIMITS.MCP_TOKEN_LIMIT;
  const withinCharLimit = outputLength <= OUTPUT_LIMITS.MCP_SOFT_LIMIT;

  if (withinTokenLimit && withinCharLimit && !forceSave) {
    return {
      text: output,
      truncated: false,
      savedToFile: false,
      filePath: null,
      summaryPath: null,
      originalSize: outputLength,
      estimatedTokens
    };
  }

  // Create summary content that fits within Read tool limits
  // Target ~20K tokens = ~80KB for the summary file
  const summaryContent = smartTruncate(output, OUTPUT_LIMITS.SUMMARY_FILE_TARGET, '');

  // Save both full output and summary
  const files = saveDualOutputFiles(output, summaryContent, prefix);

  // Create MCP response text (even more truncated to fit in tool response)
  let responseText;
  if (outputLength <= OUTPUT_LIMITS.MCP_HARD_LIMIT) {
    responseText = smartTruncate(output, OUTPUT_LIMITS.MCP_SOFT_LIMIT - 1000, files.fullPath);
  } else {
    responseText = smartTruncate(output, OUTPUT_LIMITS.SUMMARY_TARGET, files.fullPath);
  }

  // Add summary file reference to response
  const responseWithPaths = [
    responseText,
    '',
    '---',
    '',
    '**Readable summary file (fits in Read tool):**',
    `\`${files.summaryPath}\``,
  ].join('\n');

  return {
    text: responseWithPaths,
    truncated: true,
    savedToFile: true,
    filePath: files.fullPath,
    summaryPath: files.summaryPath,
    originalSize: outputLength,
    estimatedTokens
  };
}

export default {
  success,
  error,
  formatted,
  validateRequired,
  runGitDiff,
  fetchWithTimeout,
  cleanCodeOutput,
  withHandler,
  saveOutputToFile,
  saveDualOutputFiles,
  smartTruncate,
  processLargeOutput,
  estimateTokens,
  tokensToChars,
  exceedsTokenLimit,
};
