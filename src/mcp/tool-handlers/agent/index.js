/**
 * Agent Tool Handlers
 *
 * Handles gemini_agent_task - autonomous task execution via Gemini's agent mode
 */

import { spawn } from 'child_process';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { success, error, validateRequired, processLargeOutput } from '../base.js';
import {
  getAgentSessionManager,
  SessionStatus,
} from '../../../services/agent-session-manager.js';
import { OUTPUT_LIMITS } from '../../../config/timeouts.js';

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
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Run at most once per day
const MAX_FILE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Clean up old output files (older than 30 days)
 * Runs asynchronously and doesn't block agent tasks
 */
async function cleanupOldOutputFiles() {
  const now = Date.now();

  // Skip if we ran cleanup recently
  if (now - lastCleanupTime < CLEANUP_INTERVAL_MS) {
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

        if (fileAge > MAX_FILE_AGE_MS) {
          deletedBytes += fileStat.size;
          await unlink(filePath);
          deletedCount++;
        }
      } catch (e) {
        // Ignore errors for individual files (may be in use, etc.)
      }
    }

    if (deletedCount > 0) {
      console.log(`[Agent] Cleaned up ${deletedCount} old output files (${(deletedBytes / 1024 / 1024).toFixed(1)}MB)`);
    }
  } catch (e) {
    // Silently ignore cleanup errors - non-critical operation
    console.error('[Agent] Cleanup error:', e.message);
  }
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
 * @returns {Object} Formatted result with text and metadata
 */
function formatAgentResult(summary, outputInfo = {}) {
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
    const availableForResult = OUTPUT_LIMITS.MCP_HARD_LIMIT - headerFooterSize;

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
 * Execute Gemini agent process with streaming output parsing
 * @param {Object} options Execution options
 * @param {string[]} options.args CLI arguments
 * @param {string} options.prompt Task prompt
 * @param {Object} options.session Session object
 * @param {Object} options.sessionManager AgentSessionManager instance
 * @param {Object} options.context Handler context
 * @param {string} options.workingDirectory Working directory
 * @param {number} options.timeoutMs Timeout in milliseconds
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

      const maxSize = OUTPUT_LIMITS.AGENT_OUTPUT_MAX || 100000;
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

    // Set up timeout
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Agent timeout after ${Math.round(timeoutMs / 60000)} minutes`));
      }, timeoutMs);
    }

    // Send prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
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
              proc.kill('SIGTERM');
              reject(new Error(limits.reason));
              return;
            }

            // Record the tool call
            sessionManager.recordToolCall(session.id, {
              tool: event.tool_name || event.name,
              input: event.tool_input || event.input,
              code: event.tool_code,
            });
            break;

          case 'tool_result':
            // Update last tool call with result if needed
            break;

          case 'text':
          case 'message':
            appendTextOutput((event.content || event.text || '') + '\n');
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
            console.error('[Agent error event]:', event.error || event.message);
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
      // Log stderr but don't fail - Gemini outputs progress info to stderr
      const text = chunk.toString();
      if (text.includes('error') || text.includes('Error')) {
        console.error('[Agent stderr]:', text);
      }
    });

    proc.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);

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

        switch (code) {
          case 1:
            errorMessage = 'Agent failed - check task description for clarity';
            break;
          case 137:
            errorMessage = 'Agent killed (timeout or memory limit)';
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
        agentError.fullOutputPath = fullOutputPath;
        agentError.fullOutputSize = fullOutputSize;
        reject(agentError);
      }
    });

    proc.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
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
  cleanupOldOutputFiles().catch(() => {}); // Fire and forget

  const {
    task_description,
    working_directory,
    session_id,
    context_files = [],
    max_iterations = 20,
    timeout_minutes = 10,
    model,
  } = args;

  // Validate required arguments
  const validationError = validateRequired(args, ['task_description']);
  if (validationError) {
    return error(validationError);
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
      model,
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
      console.error('[Agent] Failed to read context files:', err.message);
      // Continue without context files
    }
  }

  // Execute agent
  sessionManager.setStatus(session.id, SessionStatus.RUNNING);

  try {
    const result = await runAgentProcess({
      args: cliArgs,
      prompt,
      session,
      sessionManager,
      context,
      workingDirectory: session.workingDirectory,
      timeoutMs: session.timeoutMs,
    });

    // Mark session as completed
    sessionManager.setResult(session.id, result.textOutput);

    const summary = sessionManager.getSummary(session.id);
    const formattedResult = formatAgentResult(summary, {
      fullOutputPath: result.fullOutputPath,
      fullOutputSize: result.fullOutputSize,
      truncated: result.truncated,
    });

    // Log if output was truncated
    if (result.truncated) {
      console.log(
        `[Agent] Output truncated for MCP response. Full output: ${result.fullOutputPath} (${(result.fullOutputSize / 1024).toFixed(1)}KB)`
      );
    }

    return success(formattedResult.text);
  } catch (err) {
    // Mark session as failed
    sessionManager.setError(session.id, err.message);

    const summary = sessionManager.getSummary(session.id);
    return error(formatAgentError(summary, err));
  }
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

export const handlers = {
  gemini_agent_task: handleGeminiAgentTask,
  gemini_agent_list: handleGeminiAgentList,
  gemini_agent_clear: handleGeminiAgentClear,
};

export default handlers;
