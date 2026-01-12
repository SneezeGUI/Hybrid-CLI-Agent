/**
 * Agent Tool Handlers
 *
 * Handles gemini_agent_task - autonomous task execution via Gemini's agent mode
 */

import { spawn } from 'child_process';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';
import { success, error, validateRequired, processLargeOutput, withErrorHandling } from '../base.js';
import {
  validatePrompt,
  validateModel,
  validateFilePatterns,
  validatePositiveInteger,
  aggregateValidations,
} from '../../../utils/validation.js';
import {
  getAgentSessionManager,
  SessionStatus,
} from '../../../services/agent-session-manager.js';
import { OUTPUT_LIMITS, AGENT_LIMITS } from '../../../config/timeouts.js';
import { getLogger } from '../../../utils/logger.js';
import { sleep, calculateBackoffDelay, withRetry } from '../../../utils/retry.js';

// Create child logger for agent module
const logger = getLogger().child('Agent');

/**
 * Event emitter for agent progress events
 *
 * Events:
 * - 'session:started' - { sessionId, taskDescription }
 * - 'session:status' - { sessionId, status }
 * - 'session:progress' - { sessionId, iterations, maxIterations, lastTool }
 * - 'session:tool_call' - { sessionId, tool, input }
 * - 'session:text' - { sessionId, text }
 * - 'session:completed' - { sessionId, result }
 * - 'session:failed' - { sessionId, error }
 *
 * @example
 * import { agentEvents } from './agent/index.js';
 * agentEvents.on('session:progress', ({ sessionId, iterations }) => {
 *   console.log(`Session ${sessionId} at iteration ${iterations}`);
 * });
 */
export const agentEvents = new EventEmitter();

// Set max listeners to handle multiple concurrent agent tasks
agentEvents.setMaxListeners(50);

/**
 * Get or create the output directory for full agent output files
 * @returns {string} Path to output directory
 */
function getAgentOutputDir() {
  const baseDir = join(homedir(), '.claude', 'gemini-worker-outputs');
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }
  return baseDir;
}

/** Track last cleanup time to avoid running too frequently */
let lastCleanupTime = 0;

/**
 * Clean up old output files (older than 30 days)
 * Runs asynchronously and doesn't block agent tasks
 */
async function cleanupOldOutputFiles() {
  const now = Date.now();

  // Skip if we ran cleanup recently
  if (now - lastCleanupTime < AGENT_LIMITS.OUTPUT_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCleanupTime = now;

  try {
    const { readdir, stat, unlink } = await import('fs/promises');
    const outputDir = getAgentOutputDir();
    const files = await readdir(outputDir);

    let deletedCount = 0;
    let deletedBytes = 0;

    for (const file of files) {
      // Only clean up agent output files
      if (!file.startsWith('agent-') && !file.startsWith('gemini-')) {
        continue;
      }

      const filePath = join(outputDir, file);
      try {
        const fileStat = await stat(filePath);
        const fileAge = now - fileStat.mtimeMs;

        if (fileAge > AGENT_LIMITS.OUTPUT_MAX_AGE_MS) {
          deletedBytes += fileStat.size;
          await unlink(filePath);
          deletedCount++;
        }
      } catch (e) {
        // Ignore errors for individual files (may be in use, etc.)
      }
    }

    if (deletedCount > 0) {
      logger.info('Cleaned up old output files', {
        event: 'cleanup',
        deletedCount,
        deletedMB: (deletedBytes / 1024 / 1024).toFixed(1),
      });
    }
  } catch (e) {
    // Non-critical operation - log as debug since cleanup failures don't affect functionality
    logger.debug('Cleanup error (non-critical)', { event: 'cleanup_error', error: e.message });
  }
}

/**
 * Detect authentication method for cost tracking
 * @returns {string} 'oauth' (free), 'api-key', or 'vertex' (paid)
 */
function detectAuthMethod() {
  if (process.env.VERTEX_API_KEY) return 'vertex';
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'api-key';
  return 'oauth'; // Default to OAuth (free tier)
}

/**
 * Parse stream-json events from Gemini agent mode
 * @param {string} line - Single line of JSON output
 * @returns {Object} Parsed event object
 */
function parseAgentEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    // Not JSON, treat as plain text
    return { type: 'text', content: line };
  }
}

/**
 * Format successful agent result for display
 * Handles large outputs by truncating and saving to file
 * @param {Object} summary - Session summary from AgentSessionManager
 * @param {Object} [outputInfo] - Information about output files
 * @param {string} [outputInfo.fullOutputPath] - Path to full output file
 * @param {number} [outputInfo.fullOutputSize] - Size of full output in bytes
 * @param {boolean} [outputInfo.truncated] - Whether MCP response was truncated
 * @param {boolean} [verbose=false] - Whether to allow larger output (100k chars)
 * @returns {Object} Formatted result with text and metadata
 */
function formatAgentResult(summary, outputInfo = {}, verbose = false) {
  const { fullOutputPath, fullOutputSize, truncated } = outputInfo;

  const headerLines = [
    '## Agent Task Completed',
    '',
    `**Session ID:** \`${summary.id}\``,
    `**Duration:** ${summary.durationFormatted}`,
    `**Iterations:** ${summary.iterations}/${summary.maxIterations}`,
  ];

  // Add full output file info if available
  if (fullOutputPath) {
    headerLines.push(`**Full Output:** \`${fullOutputPath}\` (${(fullOutputSize / 1024).toFixed(1)}KB)`);
    if (truncated) {
      headerLines.push(`**Note:** MCP response truncated - use Read tool on full output file for complete details`);
    }
  }
  headerLines.push('');

  const footerLines = [];

  if (summary.files.created.length > 0) {
    footerLines.push('### Files Created:');
    for (const file of summary.files.created) {
      footerLines.push(`- \`${file}\``);
    }
    footerLines.push('');
  }

  if (summary.files.modified.length > 0) {
    footerLines.push('### Files Modified:');
    for (const file of summary.files.modified) {
      footerLines.push(`- \`${file}\``);
    }
    footerLines.push('');
  }

  if (summary.files.deleted.length > 0) {
    footerLines.push('### Files Deleted:');
    for (const file of summary.files.deleted) {
      footerLines.push(`- \`${file}\``);
    }
    footerLines.push('');
  }

  if (summary.shellCommands > 0) {
    footerLines.push(`### Shell Commands: ${summary.shellCommands} executed`);
    if (summary.shellCommandList.length <= 5) {
      for (const cmd of summary.shellCommandList) {
        footerLines.push(`- \`${cmd}\``);
      }
    }
    footerLines.push('');
  }

  if (summary.tokens.total > 0) {
    footerLines.push(
      `### Tokens: ${summary.tokens.total.toLocaleString()} (in: ${summary.tokens.input.toLocaleString()}, out: ${summary.tokens.output.toLocaleString()})`
    );
    // Show estimated cost for API key users
    if (summary.estimatedCostFormatted) {
      footerLines.push(`**Estimated Cost:** ${summary.estimatedCostFormatted}`);
    }
    footerLines.push('');
  }

  if (summary.resumeCommand) {
    footerLines.push('### Resume Command:');
    footerLines.push(`\`${summary.resumeCommand}\``);
    footerLines.push('');
  }

  footerLines.push('**Review changes with:** `git diff` or `git status`');

  const header = headerLines.join('\n');
  const footer = footerLines.join('\n');

  // Process the agent response for size limits
  if (summary.result && summary.result.trim()) {
    const resultText = summary.result.trim();

    // Calculate available space for result (leave room for header/footer)
    const headerFooterSize = header.length + footer.length + 200; // 200 for separators
    // If verbose, use 100k limit, otherwise use standard MCP hard limit
    const outputLimit = verbose ? OUTPUT_LIMITS.VERBOSE_OUTPUT_MAX : OUTPUT_LIMITS.MCP_HARD_LIMIT;
    const availableForResult = outputLimit - headerFooterSize;

    // Check if result needs truncation
    if (resultText.length > availableForResult) {
      // Process the large output
      const processed = processLargeOutput(resultText, {
        prefix: `agent-task-${summary.id}`,
        forceSave: true
      });

      // Build output with truncated result
      const outputLines = [
        header,
        '### Agent Response:',
        '',
        processed.text,
        '',
        '---',
        '',
        footer
      ];

      return {
        text: outputLines.join('\n'),
        truncated: processed.truncated,
        savedToFile: processed.savedToFile,
        filePath: processed.filePath,
        originalSize: processed.originalSize
      };
    }

    // Result fits within limits
    const outputLines = [
      header,
      '### Agent Response:',
      '',
      resultText,
      '',
      '---',
      '',
      footer
    ];

    return {
      text: outputLines.join('\n'),
      truncated: false,
      savedToFile: false,
      filePath: null,
      originalSize: resultText.length
    };
  }

  // No result content
  return {
    text: header + '\n' + footer,
    truncated: false,
    savedToFile: false,
    filePath: null,
    originalSize: 0
  };
}

/**
 * Format agent error for display with recovery options
 * @param {Object} summary - Session summary from AgentSessionManager
 * @param {Error} err - The error that occurred (may have fullOutputPath property)
 * @returns {string} Formatted error text
 */
function formatAgentError(summary, err) {
  const lines = [
    '## Agent Task Failed',
    '',
    `**Error:** ${err.message}`,
    `**Session ID:** \`${summary.id}\``,
    `**Iterations completed:** ${summary.iterations}`,
  ];

  // Include full output path if available (for debugging)
  if (err.fullOutputPath) {
    lines.push(`**Full Output:** \`${err.fullOutputPath}\``);
    if (err.fullOutputSize) {
      lines.push(`**Output Size:** ${(err.fullOutputSize / 1024).toFixed(1)}KB`);
    }
  }
  lines.push('');

  if (summary.files.created.length > 0 || summary.files.modified.length > 0) {
    lines.push('### Partial Changes (review carefully):');
    for (const file of [...summary.files.created, ...summary.files.modified]) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  lines.push('### Recovery Options:');
  if (summary.geminiSessionId) {
    lines.push(`1. Resume: \`gemini_agent_task({ session_id: "${summary.id}" })\``);
    lines.push(`2. Manual: \`${summary.resumeCommand}\``);
  }
  lines.push('3. Rollback: `git checkout .`');

  return lines.join('\n');
}

/**
 * Format PENDING_REVIEW response requiring Claude approval
 * @param {Object} summary - Session summary from AgentSessionManager
 * @param {Object} [outputInfo] - Information about output files
 * @param {boolean} [verbose=false] - Whether to allow larger output
 * @returns {string} Formatted pending review text
 */
function formatPendingReviewResult(summary, outputInfo = {}, verbose = false) {
  const { fullOutputPath, fullOutputSize, truncated } = outputInfo;

  const lines = [
    '## ⚠️ PENDING REVIEW - Approval Required',
    '',
    'Agent task completed with file modifications. **You must review and approve these changes.**',
    '',
    `**Session ID:** \`${summary.id}\``,
    `**Duration:** ${summary.durationFormatted}`,
    `**Iterations:** ${summary.iterations}/${summary.maxIterations}`,
  ];

  if (fullOutputPath) {
    lines.push(`**Full Output:** \`${fullOutputPath}\` (${(fullOutputSize / 1024).toFixed(1)}KB)`);
  }
  lines.push('');

  // List files changed
  if (summary.files.created.length > 0) {
    lines.push('### Files Created:');
    for (const file of summary.files.created) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  if (summary.files.modified.length > 0) {
    lines.push('### Files Modified:');
    for (const file of summary.files.modified) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  if (summary.files.deleted.length > 0) {
    lines.push('### Files Deleted:');
    for (const file of summary.files.deleted) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  // Add result preview if available
  if (summary.result) {
    const previewLength = verbose ? 5000 : 2000;
    const preview = summary.result.slice(0, previewLength);
    lines.push('### Agent Response Preview:');
    lines.push('');
    lines.push(preview);
    if (summary.result.length > previewLength) {
      lines.push(`\n... [truncated - see full output file]`);
    }
    lines.push('');
  }

  // Add required action
  lines.push('---');
  lines.push('');
  lines.push('### ⚡ ACTION REQUIRED');
  lines.push('');
  lines.push('Review the changes above, then call `gemini_agent_approve` to apply or reject:');
  lines.push('');
  lines.push('**To approve:**');
  lines.push('```json');
  lines.push(`{ "session_id": "${summary.id}", "approved": true }`);
  lines.push('```');
  lines.push('');
  lines.push('**To reject with feedback:**');
  lines.push('```json');
  lines.push(`{ "session_id": "${summary.id}", "approved": false, "feedback": "reason for rejection" }`);
  lines.push('```');
  lines.push('');
  lines.push('**To approve with inline fixes:**');
  lines.push('```json');
  lines.push('{');
  lines.push(`  "session_id": "${summary.id}",`);
  lines.push('  "approved": true,');
  lines.push('  "fixes": [{ "file": "path/to/file.js", "search": "old text", "replace": "new text" }]');
  lines.push('}');
  lines.push('```');

  return lines.join('\n');
}

/**
 * Kill process gracefully - SIGTERM first, then SIGKILL after grace period
 * @param {ChildProcess} proc - The process to kill
 * @param {number} graceMs - Grace period before SIGKILL (default 5000ms)
 */
function killWithGrace(proc, graceMs = 5000) {
  if (!proc || proc.killed) return;

  proc.kill('SIGTERM');

  const killTimer = setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  }, graceMs);

  proc.once('exit', () => clearTimeout(killTimer));
}

/**
 * Execute Gemini agent process with streaming output parsing
 * @param {Object} options Execution options
 * @param {string[]} options.args CLI arguments
 * @param {string} options.prompt Task prompt
 * @param {Object} options.session Session object
 * @param {Object} options.sessionManager AgentSessionManager instance
 * @param {Object} options.context Handler context
 * @param {string} options.workingDirectory Working directory
 * @param {number} options.timeoutMs Timeout in milliseconds
 * @param {number} [options.stallTimeoutMs] Stall timeout in milliseconds
 * @returns {Promise<Object>} Execution result
 */
async function runAgentProcess({
  args,
  prompt,
  session,
  sessionManager,
  context,
  workingDirectory,
  timeoutMs,
  stallTimeoutMs,
}) {
  return new Promise((resolve, reject) => {
    // Use safeSpawn if available, otherwise spawn directly
    const spawnFn = context.safeSpawn
      ? (cmd, spawnArgs, opts) => context.safeSpawn(spawn, cmd, spawnArgs, opts)
      : (cmd, spawnArgs, opts) => spawn(cmd, spawnArgs, opts);

    const proc = spawnFn('gemini', args, {
      cwd: workingDirectory,
      env: context.buildEnv ? context.buildEnv() : process.env,
    });

    let buffer = '';
    let textOutput = '';
    let textOutputTruncated = false;
    let fullOutputSize = 0;
    let lastEvent = null;
    let timeoutHandle = null;
    let stallCheckHandle = null;
    let lastActivityTime = Date.now();
    let stallWarningEmitted = false;

    // Create write stream for full output (never truncated)
    const outputDir = getAgentOutputDir();
    const fullOutputPath = join(outputDir, `agent-task-${session.id}-${Date.now()}-full.txt`);
    const fullOutputStream = createWriteStream(fullOutputPath, { encoding: 'utf8' });

    // Write header to full output file
    fullOutputStream.write(`# Agent Task Full Output\n`);
    fullOutputStream.write(`Session: ${session.id}\n`);
    fullOutputStream.write(`Started: ${new Date().toISOString()}\n`);
    fullOutputStream.write(`Task: ${session.taskDescription}\n`);
    fullOutputStream.write(`${'='.repeat(80)}\n\n`);

    // Helper to write to full output file
    const writeToFullOutput = (text) => {
      fullOutputStream.write(text);
      fullOutputSize += text.length;
    };

    // Helper to safely append to textOutput with size limits (for MCP response)
    const appendTextOutput = (text) => {
      // Always write to full output file first
      writeToFullOutput(text);

      if (textOutputTruncated) return; // Already at limit for MCP response, skip

      const maxSize = OUTPUT_LIMITS.AGENT_OUTPUT_MAX || OUTPUT_LIMITS.VERBOSE_OUTPUT_MAX;
      if (textOutput.length + text.length > maxSize) {
        // Truncate: keep head and tail for MCP response
        const headTail = OUTPUT_LIMITS.AGENT_OUTPUT_HEAD_TAIL || 20000;
        const head = textOutput.slice(0, headTail);
        const tail = text.slice(-headTail);
        textOutput = head + `\n\n[... output truncated for MCP response - full output: ${fullOutputPath} ...]\n\n` + tail;
        textOutputTruncated = true;
      } else {
        textOutput += text;
      }
    };

    // Helper to update activity timestamp
    const updateActivity = () => { lastActivityTime = Date.now(); };

    // Set up overall timeout
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (stallCheckHandle) clearInterval(stallCheckHandle);
        killWithGrace(proc);
        reject(new Error(`Agent timeout after ${Math.round(timeoutMs / 60000)} minutes`));
      }, timeoutMs);
    }

    // Set up stall detection (kills if no activity for STALL_TIMEOUT_MS)
    stallCheckHandle = setInterval(() => {
      const timeSinceActivity = Date.now() - lastActivityTime;
      const stallTimeout = stallTimeoutMs || AGENT_LIMITS.STALL_TIMEOUT_MS;

      // Warning at 75% of timeout
      if (timeSinceActivity > stallTimeout * 0.75 && !stallWarningEmitted) {
        stallWarningEmitted = true;
        const warningSeconds = Math.round(timeSinceActivity / 1000);
        appendTextOutput(`\n[WARNING] No activity for ${warningSeconds}s - will timeout at ${Math.round(stallTimeout / 1000)}s\n`);
        logger.warn('Agent activity warning', {
          event: 'stall_warning',
          sessionId: session.id,
          inactiveSeconds: warningSeconds,
          timeoutSeconds: Math.round(stallTimeout / 1000)
        });
      }

      if (timeSinceActivity > stallTimeout) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        clearInterval(stallCheckHandle);
        killWithGrace(proc);
        const stallSeconds = Math.round(stallTimeout / 1000);
        reject(new Error(`Agent stalled - no activity for ${stallSeconds} seconds`));
      }
    }, AGENT_LIMITS.STALL_CHECK_INTERVAL_MS);

    // Send prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      // Update activity timestamp for stall detection
      updateActivity();

      buffer += chunk.toString();

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        const event = parseAgentEvent(line);
        lastEvent = event;

        switch (event.type) {
          case 'session':
            // Capture Gemini's session ID for --resume
            if (event.session_id) {
              sessionManager.setGeminiSessionId(session.id, event.session_id);
            }
            break;

          case 'tool_code':
          case 'tool_use':
            // Check iteration limits before proceeding
            const limits = sessionManager.checkLimits(session.id);
            if (limits.exceeded) {
              if (timeoutHandle) clearTimeout(timeoutHandle);
              killWithGrace(proc);
              reject(new Error(limits.reason));
              return;
            }

            // Record the tool call
            const toolName = event.tool_name || event.name;
            sessionManager.recordToolCall(session.id, {
              tool: toolName,
              input: event.tool_input || event.input,
              code: event.tool_code,
            });

            // Detect file mutations for PENDING_REVIEW workflow
            const toolInput = event.tool_input || event.input || {};
            const filePath = toolInput.path || toolInput.file_path || toolInput.filename || toolInput.target || toolInput.file;
            if (filePath) {
              const normalizedTool = toolName?.toLowerCase() || '';
              if (normalizedTool.includes('write_file') || normalizedTool.includes('create_file') ||
                normalizedTool.includes('save_file')) {
                sessionManager.recordFileMutation(session.id, 'create', filePath);
              } else if (normalizedTool.includes('edit_file') || normalizedTool.includes('replace') ||
                normalizedTool.includes('patch') || normalizedTool.includes('modify')) {
                sessionManager.recordFileMutation(session.id, 'modify', filePath);
              } else if (normalizedTool.includes('delete_file') || normalizedTool.includes('remove_file')) {
                sessionManager.recordFileMutation(session.id, 'delete', filePath);
              }
            }

            // Emit tool call event
            agentEvents.emit('session:tool_call', {
              sessionId: session.id,
              tool: toolName,
              input: event.tool_input || event.input,
            });

            // Emit progress event
            agentEvents.emit('session:progress', {
              sessionId: session.id,
              iterations: session.iterations,
              maxIterations: session.maxIterations,
              lastTool: toolName,
            });
            break;

          case 'tool_result':
            // Update last tool call with result if needed
            break;

          case 'text':
          case 'message':
            const textContent = event.content || event.text || '';
            appendTextOutput(textContent + '\n');

            // Emit text event (only for non-empty content)
            if (textContent.trim()) {
              agentEvents.emit('session:text', {
                sessionId: session.id,
                text: textContent,
              });
            }
            break;

          case 'usage':
          case 'stats':
            sessionManager.updateTokens(session.id, {
              input: event.input_tokens || event.metrics?.input_tokens || 0,
              output: event.output_tokens || event.metrics?.output_tokens || 0,
              total: event.total_tokens || event.metrics?.total_tokens || 0,
            });
            break;

          case 'error':
            // Don't reject immediately - let the process finish
            logger.warn('Agent error event', {
              event: 'agent_error',
              sessionId: session.id,
              error: event.error || event.message,
            });
            break;

          case 'result':
          case 'done':
            // Task completed
            break;

          default:
            // Handle any text content in unknown event types
            if (event.text || event.content) {
              appendTextOutput((event.text || event.content) + '\n');
            }
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      updateActivity();
      // Log stderr but don't fail - Gemini outputs progress info to stderr
      const text = chunk.toString();
      if (text.includes('error') || text.includes('Error')) {
        logger.debug('Agent stderr', {
          event: 'stderr',
          sessionId: session.id,
          text: text.trim().slice(0, 500), // Truncate long stderr
        });
      }
    });

    proc.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (stallCheckHandle) clearInterval(stallCheckHandle);

      // Process any remaining buffer
      if (buffer.trim()) {
        const event = parseAgentEvent(buffer);
        if (event.text || event.content) {
          appendTextOutput((event.text || event.content) + '\n');
        }
      }

      // Write footer and close the full output stream
      fullOutputStream.write(`\n${'='.repeat(80)}\n`);
      fullOutputStream.write(`Completed: ${new Date().toISOString()}\n`);
      fullOutputStream.write(`Exit code: ${code}\n`);
      fullOutputStream.write(`Total output size: ${(fullOutputSize / 1024).toFixed(1)}KB\n`);
      fullOutputStream.end();

      if (code === 0) {
        resolve({
          textOutput: textOutput.trim(),
          exitCode: code,
          fullOutputPath,
          fullOutputSize,
          truncated: textOutputTruncated,
        });
      } else {
        // Translate exit codes to meaningful errors
        let errorMessage = `Agent exited with code ${code}`;
        let isRetryable = false;

        switch (code) {
          case 1:
            const iterationInfo = session.iterations > 0
              ? `after ${session.iterations} iterations`
              : 'before completing any iterations';
            const lastToolInfo = session.lastToolCalls && session.lastToolCalls.length > 0
              ? `\nLast tools used: ${session.lastToolCalls.slice(-3).map(t => t.tool || 'unknown').join(', ')}`
              : '';
            errorMessage = `Agent failed ${iterationInfo}.${lastToolInfo}\nSuggestion: Check task description for clarity or increase iterations/timeout.`;
            isRetryable = true; // General failure may be transient
            break;
          case 137:
            errorMessage = 'Agent killed (timeout or memory limit)';
            isRetryable = true; // May succeed with retry
            break;
          case 41:
            errorMessage = 'Authentication failed - run `gemini auth login`';
            break;
          case 44:
            errorMessage = 'File access denied by security restrictions';
            break;
          case 53:
            errorMessage = 'Session too long - start a new session';
            break;
        }

        const agentError = new Error(errorMessage);
        agentError.exitCode = code;
        agentError.isRetryable = isRetryable;
        agentError.fullOutputPath = fullOutputPath;
        agentError.fullOutputSize = fullOutputSize;
        reject(agentError);
      }
    });

    proc.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (stallCheckHandle) clearInterval(stallCheckHandle);
      // Still close the output stream on spawn error
      fullOutputStream.write(`\nProcess error: ${err.message}\n`);
      fullOutputStream.end();
      const spawnError = new Error(`Failed to spawn Gemini CLI: ${err.message}`);
      spawnError.fullOutputPath = fullOutputPath;
      reject(spawnError);
    });
  });
}

/**
 * Run agent process in background (fire-and-forget)
 * Handles completion asynchronously and updates session state
 * @param {Object} options Same as runAgentProcess + verbose
 */
function runAgentProcessBackground(options) {
  const { session, sessionManager, verbose } = options;

  // Start the process asynchronously
  runAgentProcess(options)
    .then((result) => {
      // Check if files were modified
      const session_data = sessionManager.getSession(session.id);
      const filesChanged = session_data.filesCreated.length > 0 ||
        session_data.filesModified.length > 0 ||
        session_data.filesDeleted.length > 0;

      if (filesChanged) {
        // Set to PENDING_REVIEW
        session_data.result = result.textOutput;
        sessionManager.setPendingReview(session.id, {
          filesCreated: [...session_data.filesCreated],
          filesModified: [...session_data.filesModified],
          filesDeleted: [...session_data.filesDeleted],
          summary: result.textOutput?.slice(0, 2000) || 'Agent task completed',
        });

        agentEvents.emit('session:pending_review', {
          sessionId: session.id,
          iterations: session_data.iterations,
          filesCreated: session_data.filesCreated.length,
          filesModified: session_data.filesModified.length,
          fullOutputPath: result.fullOutputPath,
        });

        logger.info('Background task completed, pending review', {
          event: 'background_pending_review',
          sessionId: session.id,
          filesChanged: session_data.filesCreated.length + session_data.filesModified.length,
        });
      } else {
        // No files changed - complete directly
        sessionManager.setResult(session.id, result.textOutput);

        agentEvents.emit('session:completed', {
          sessionId: session.id,
          iterations: session_data.iterations,
          filesCreated: 0,
          filesModified: 0,
          fullOutputPath: result.fullOutputPath,
        });

        logger.info('Background task completed', {
          event: 'background_completed',
          sessionId: session.id,
        });
      }
    })
    .catch((err) => {
      // Handle errors
      sessionManager.setError(session.id, err.message);

      agentEvents.emit('session:failed', {
        sessionId: session.id,
        error: err.message,
        exitCode: err.exitCode,
      });

      logger.error('Background task failed', {
        event: 'background_failed',
        sessionId: session.id,
        error: err.message,
        exitCode: err.exitCode,
      });
    });
}

/**
 * Handle gemini_agent_task tool
 *
 * Delegates complete tasks to Gemini's agent mode with native file/shell access
 *
 * @param {Object} args Tool arguments
 * @param {string} args.task_description Task to accomplish
 * @param {string} [args.working_directory] Working directory
 * @param {string} [args.session_id] Resume previous session
 * @param {string[]} [args.context_files] Glob patterns for reference files
 * @param {number} [args.max_iterations=20] Safety limit
 * @param {number} [args.timeout_minutes=10] Timeout
 * @param {string} [args.model] Model to use
 * @param {Object} context Handler context
 * @returns {Promise<Object>} Tool response
 */
async function handleGeminiAgentTask(args, context) {
  // Trigger cleanup of old output files (runs in background, at most once per day)
  cleanupOldOutputFiles().catch(() => { }); // Fire and forget

  const {
    task_description,
    working_directory,
    session_id,
    context_files = [],
    max_iterations = AGENT_LIMITS.DEFAULT_MAX_ITERATIONS,
    timeout_minutes = AGENT_LIMITS.DEFAULT_TIMEOUT_MINUTES,
    stall_timeout_seconds = 300,
    verbose = false,
    max_retries = 0,
    background = false,
    model,
  } = args;

  // Comprehensive input validation
  const validations = {
    task_description: validatePrompt(task_description),
    model: validateModel(model),
    max_iterations: validatePositiveInteger(max_iterations, 'max_iterations', 1, 100),
    max_retries: validatePositiveInteger(max_retries, 'max_retries', 0, 10),
    timeout_minutes: validatePositiveInteger(timeout_minutes, 'timeout_minutes', 1, 60),
    stall_timeout_seconds: validatePositiveInteger(stall_timeout_seconds, 'stall_timeout_seconds', 30, 600),
  };

  // Validate context_files if provided
  if (context_files && context_files.length > 0) {
    validations.context_files = validateFilePatterns(context_files, 50);
  }

  const validation = aggregateValidations(validations);
  if (!validation.valid) {
    return error(`Validation failed:\n- ${validation.errors.join('\n- ')}`);
  }

  // Check if agent mode is enabled
  const agentModeEnabled = process.env.GEMINI_AGENT_MODE === 'true';
  if (!agentModeEnabled) {
    return error(
      'Agent mode is disabled for security.\n\n' +
      'To enable, set GEMINI_AGENT_MODE=true in your .env file.\n\n' +
      'WARNING: This allows Gemini to execute shell commands and modify files directly.'
    );
  }

  const sessionManager = getAgentSessionManager();
  let session;

  // Resume existing session or create new
  if (session_id) {
    session = sessionManager.getSession(session_id);
    if (!session) {
      return error(`Session not found: ${session_id}`);
    }
    if (!session.geminiSessionId) {
      return error(
        'Session has no Gemini session ID - cannot resume.\n' +
        'The previous session may not have started successfully.'
      );
    }
    // Update session for resume
    sessionManager.setStatus(session_id, SessionStatus.RUNNING);
  } else {
    session = sessionManager.createSession({
      taskDescription: task_description,
      workingDirectory: working_directory || process.cwd(),
      maxIterations: max_iterations,
      timeoutMinutes: timeout_minutes,
      maxAutoRetries: max_retries,
      model,
      authMethod: detectAuthMethod(),
    });

    // Emit session started event
    agentEvents.emit('session:started', {
      sessionId: session.id,
      taskDescription: task_description,
      workingDirectory: session.workingDirectory,
      maxIterations: max_iterations,
      model: session.model,
    });
  }

  // Build CLI arguments
  const cliArgs = [
    '--yolo', // Auto-accept all tool calls
    '--output-format',
    'stream-json', // Structured output
  ];

  // Resume previous Gemini session if available
  if (session_id && session.geminiSessionId) {
    cliArgs.push('--resume', session.geminiSessionId);
  }

  // Set model if specified
  if (model) {
    cliArgs.push('--model', model);
  }

  // Build prompt with context files if provided
  let prompt = task_description;

  if (context_files.length > 0 && context.readFilesFromPatterns) {
    try {
      const files = await context.readFilesFromPatterns(
        context_files,
        session.workingDirectory
      );
      if (files.length > 0) {
        prompt += '\n\n## Reference Files:\n';
        for (const file of files) {
          prompt += `\n### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n`;
        }
      }
    } catch (err) {
      logger.warn('Failed to read context files', {
        event: 'context_read_error',
        sessionId: session.id,
        patterns: context_files,
        error: err.message,
      });
      // Continue without context files
    }
  }

  // Execute agent with automatic retry for transient failures
  sessionManager.setStatus(session.id, SessionStatus.RUNNING);

  // BACKGROUND MODE: Start process and return immediately
  if (background) {
    // Start the agent process asynchronously
    runAgentProcessBackground({
      args: cliArgs,
      prompt,
      session,
      sessionManager,
      context,
      workingDirectory: session.workingDirectory,
      timeoutMs: session.timeoutMs,
      stallTimeoutMs: stall_timeout_seconds * 1000,
      verbose,
    });

    // Return immediately with session info for polling
    return success(`## 🚀 Background Task Started

**Session ID:** \`${session.id}\`
**Status:** RUNNING
**Task:** ${task_description.slice(0, 200)}${task_description.length > 200 ? '...' : ''}

### Poll Status:
\`\`\`json
{ "status": "running" }  // via gemini_agent_list
\`\`\`

### When Complete:
- Task returns PENDING_REVIEW if files changed
- Use \`gemini_agent_approve\` to finalize

### Check Progress:
\`gemini_agent_list\` to see current status and iteration count.`);
  }

  let result = null;

  // Execute agent with retry using centralized withRetry utility
  try {
    result = await withRetry(
      () => runAgentProcess({
        args: cliArgs,
        prompt,
        session,
        sessionManager,
        context,
        workingDirectory: session.workingDirectory,
        timeoutMs: session.timeoutMs,
        stallTimeoutMs: stall_timeout_seconds * 1000,
      }),
      {
        maxRetries: max_retries,
        baseDelayMs: 5000,
        maxDelayMs: 60000,
        addJitter: true,
        shouldRetry: (err) => err.isRetryable && sessionManager.canAutoRetry(session.id),
        onRetry: async ({ attempt, delayMs, error: err }) => {
          sessionManager.incrementRetry(session.id);
          logger.warn('Agent failed with retryable error, auto-retrying', {
            event: 'auto_retry',
            sessionId: session.id,
            attempt,
            maxRetries: max_retries,
            exitCode: err.exitCode,
            delayMs,
          });
          // Set status back to RUNNING after the delay (withRetry handles the sleep)
          sessionManager.setStatus(session.id, SessionStatus.RUNNING);
        },
      }
    );
  } catch (err) {
    // Not retryable or max retries reached - fail
    sessionManager.setError(session.id, err.message);

    // Emit session failed event
    agentEvents.emit('session:failed', {
      sessionId: session.id,
      error: err.message,
      exitCode: err.exitCode,
      iterations: session.iterations,
    });

    const summary = sessionManager.getSummary(session.id);
    return error(formatAgentError(summary, err));
  }

  // Check if any files were modified during the task
  const session_data = sessionManager.getSession(session.id);
  const filesChanged = session_data.filesCreated.length > 0 ||
    session_data.filesModified.length > 0 ||
    session_data.filesDeleted.length > 0;

  // If files were changed, set to PENDING_REVIEW instead of COMPLETED
  if (filesChanged) {
    // Store the result but don't complete - require approval
    session_data.result = result.textOutput;

    // Set session to pending review
    sessionManager.setPendingReview(session.id, {
      filesCreated: [...session_data.filesCreated],
      filesModified: [...session_data.filesModified],
      filesDeleted: [...session_data.filesDeleted],
      summary: result.textOutput?.slice(0, 2000) || 'Agent task completed',
    });

    // Emit session pending review event
    agentEvents.emit('session:pending_review', {
      sessionId: session.id,
      iterations: session_data.iterations,
      filesCreated: session_data.filesCreated.length,
      filesModified: session_data.filesModified.length,
      filesDeleted: session_data.filesDeleted.length,
      fullOutputPath: result.fullOutputPath,
    });

    // Return PENDING_REVIEW response - requires approval
    const summary_data = sessionManager.getSummary(session.id);
    return success(formatPendingReviewResult(summary_data, {
      fullOutputPath: result.fullOutputPath,
      fullOutputSize: result.fullOutputSize,
      truncated: result.truncated,
    }, verbose));
  }

  // No files changed - auto-complete (no review needed for read-only tasks)
  sessionManager.setResult(session.id, result.textOutput);

  // Emit session completed event
  agentEvents.emit('session:completed', {
    sessionId: session.id,
    iterations: session_data.iterations,
    filesCreated: 0,
    filesModified: 0,
    fullOutputPath: result.fullOutputPath,
  });

  const summary_final = sessionManager.getSummary(session.id);
  const formattedResult = formatAgentResult(summary_final, {
    fullOutputPath: result.fullOutputPath,
    fullOutputSize: result.fullOutputSize,
    truncated: result.truncated,
  }, verbose);

  // Log if output was truncated
  if (result.truncated) {
    logger.info('Output truncated for MCP response', {
      event: 'output_truncated',
      sessionId: session.id,
      fullOutputPath: result.fullOutputPath,
      fullOutputSizeKB: (result.fullOutputSize / 1024).toFixed(1),
    });
  }

  return success(formattedResult.text);
}

/**
 * Handle gemini_agent_list tool - list active agent sessions
 */
async function handleGeminiAgentList(args) {
  const { status } = args;
  const sessionManager = getAgentSessionManager();

  const filter = status ? { status } : {};
  const sessions = sessionManager.listSessions(filter);

  if (sessions.length === 0) {
    return success('No agent sessions found.');
  }

  const lines = ['## Agent Sessions', ''];

  for (const session of sessions) {
    lines.push(`### Session: \`${session.id}\``);
    lines.push(`- **Status:** ${session.status}`);
    lines.push(`- **Duration:** ${session.durationFormatted}`);
    lines.push(`- **Iterations:** ${session.iterations}/${session.maxIterations}`);
    if (session.files.created.length + session.files.modified.length > 0) {
      lines.push(
        `- **Files touched:** ${session.files.created.length + session.files.modified.length}`
      );
    }
    lines.push('');
  }

  return success(lines.join('\n'));
}

/**
 * Handle gemini_agent_clear tool - delete an agent session
 */
async function handleGeminiAgentClear(args) {
  const { session_id } = args;
  const validationError = validateRequired(args, ['session_id']);
  if (validationError) {
    return error(validationError);
  }

  const sessionManager = getAgentSessionManager();
  const deleted = sessionManager.deleteSession(session_id);

  if (deleted) {
    return success(`Session ${session_id} deleted.`);
  } else {
    return error(`Session not found: ${session_id}`);
  }
}

/**
 * Handle gemini_agent_approve tool - approve or reject agent changes
 * 
 * @param {Object} args Tool arguments
 * @param {string} args.session_id Session to approve/reject
 * @param {boolean} args.approved Whether to approve changes
 * @param {Object[]} [args.fixes] Optional inline fixes to apply
 * @param {string} [args.feedback] Feedback if rejected
 * @returns {Promise<Object>} Tool response
 */
async function handleGeminiAgentApprove(args) {
  const { session_id, approved, fixes = [], feedback } = args;

  // Validate required arguments
  const validationError = validateRequired(args, ['session_id']);
  if (validationError) {
    return error(validationError);
  }

  if (typeof approved !== 'boolean') {
    return error('Missing required argument: approved (boolean)');
  }

  const sessionManager = getAgentSessionManager();
  const session = sessionManager.getSession(session_id);

  if (!session) {
    return error(`Session not found: ${session_id}`);
  }

  if (session.status !== SessionStatus.PENDING_REVIEW) {
    return error(
      `Session is not pending review. Current status: ${session.status}\n` +
      'Only sessions with PENDING_REVIEW status can be approved or rejected.'
    );
  }

  // Apply inline fixes if provided
  if (approved && fixes.length > 0) {
    const { readFileSync, writeFileSync } = await import('fs');
    const fixResults = [];

    for (const fix of fixes) {
      if (!fix.file || !fix.search || fix.replace === undefined) {
        fixResults.push({ file: fix.file, success: false, error: 'Invalid fix format' });
        continue;
      }

      try {
        const content = readFileSync(fix.file, 'utf8');
        if (!content.includes(fix.search)) {
          fixResults.push({ file: fix.file, success: false, error: 'Search text not found' });
          continue;
        }

        const newContent = content.replace(fix.search, fix.replace);
        writeFileSync(fix.file, newContent, 'utf8');
        fixResults.push({ file: fix.file, success: true });
      } catch (err) {
        fixResults.push({ file: fix.file, success: false, error: err.message });
      }
    }

    // Log fix results
    const failedFixes = fixResults.filter(r => !r.success);
    if (failedFixes.length > 0) {
      logger.warn('Some inline fixes failed', {
        event: 'fix_partial_failure',
        sessionId: session_id,
        failed: failedFixes,
      });
    }
  }

  // Set approval status
  const result = sessionManager.setApprovalStatus(session_id, approved, {
    reviewedBy: 'claude-opus',
    feedback: feedback || null,
  });

  if (!result) {
    return error('Failed to set approval status');
  }

  // Emit appropriate event
  if (approved) {
    agentEvents.emit('session:approved', {
      sessionId: session_id,
      fixesApplied: fixes.length,
    });

    const summary = sessionManager.getSummary(session_id);
    const lines = [
      '## ✅ Changes Approved',
      '',
      `**Session:** \`${session_id}\``,
      `**Files Created:** ${summary.files.created.length}`,
      `**Files Modified:** ${summary.files.modified.length}`,
    ];

    if (fixes.length > 0) {
      lines.push(`**Inline Fixes Applied:** ${fixes.length}`);
    }

    lines.push('');
    lines.push('Changes have been finalized. Consider committing with `git commit`.');

    return success(lines.join('\n'));
  } else {
    agentEvents.emit('session:rejected', {
      sessionId: session_id,
      feedback,
    });

    const lines = [
      '## ❌ Changes Rejected',
      '',
      `**Session:** \`${session_id}\``,
    ];

    if (feedback) {
      lines.push(`**Reason:** ${feedback}`);
    }

    lines.push('');
    lines.push('The session has been marked as rejected.');
    lines.push('You can run a new agent task with updated requirements,');
    lines.push('or use `git checkout .` to revert file changes.');

    return success(lines.join('\n'));
  }
}

export const handlers = {
  gemini_agent_task: withErrorHandling(handleGeminiAgentTask, 'gemini_agent_task'),
  gemini_agent_list: withErrorHandling(handleGeminiAgentList, 'gemini_agent_list'),
  gemini_agent_clear: withErrorHandling(handleGeminiAgentClear, 'gemini_agent_clear'),
  gemini_agent_approve: withErrorHandling(handleGeminiAgentApprove, 'gemini_agent_approve'),
};

export default handlers;
