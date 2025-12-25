import { spawn } from 'child_process';
import { BaseAdapter } from './base.js';
import { safeSpawn } from '../utils/security.js';
import { CLAUDE_PRICING } from '../config/index.js';

/**
 * Claude Code Adapter
 *
 * Wraps the `claude` CLI tool for programmatic access.
 * Used as the "supervisor" in the hybrid agent system.
 *
 * Prerequisites:
 *   npm install -g @anthropic-ai/claude-code
 *   claude auth login
 */
export class ClaudeCodeAdapter extends BaseAdapter {
  constructor(config = {}) {
    super(config);
    this.name = 'claude-code';
    this.processes = new Map();

    // Pricing per 1M tokens - imported from centralized config
    this.pricing = CLAUDE_PRICING;
  }

  getCheckCommand() {
    return 'claude --version';
  }

  async isAvailable() {
    return new Promise((resolve) => {
      // SECURITY: Use safeSpawn to prevent command injection
      const proc = safeSpawn(spawn, 'claude', ['--version'], {});
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  /**
   * Check authentication status
   */
  async checkAuth() {
    return new Promise((resolve) => {
      // Claude Code doesn't have an explicit auth status command
      // We check by seeing if the CLI responds
      // SECURITY: Use safeSpawn to prevent command injection
      const proc = safeSpawn(spawn, 'claude', ['--version'], {});
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => {
        resolve({
          authenticated: code === 0,
          output: output.trim(),
        });
      });
      proc.on('error', () => resolve({ authenticated: false }));
    });
  }

  getSupportedModels() {
    return [
      'claude-sonnet-4-5-20250514',
      'claude-opus-4-5-20250514',
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
    ];
  }

  getDefaultModel() {
    return 'claude-sonnet-4-5-20250514';
  }

  async spawn(sessionId, options = {}) {
    const {
      model = this.getDefaultModel(),
      workDir = process.cwd(),
      systemPrompt = null,
    } = options;

    this.sessions.set(sessionId, {
      id: sessionId,
      adapter: this.name,
      model,
      workDir,
      systemPrompt,
      status: 'ready',
      createdAt: new Date().toISOString(),
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCost: 0,
    });

    return this.sessions.get(sessionId);
  }

  /**
   * Run Claude CLI synchronously and return full response
   * Used for simpler integration patterns
   */
  async runSync(prompt, options = {}) {
    const {
      model = this.getDefaultModel(),
      workDir = process.cwd(),
    } = options;

    return new Promise((resolve, reject) => {
      // Claude Code CLI uses -p for print mode (non-interactive)
      const args = ['-p', prompt];

      // Add model if supported by CLI
      if (model) {
        args.push('--model', model);
      }

      // SECURITY: Use safeSpawn to prevent command injection
      const proc = safeSpawn(spawn, 'claude', args, {
        cwd: workDir,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Claude CLI exited with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.status = 'busy';
    session.messageCount++;

    // Build CLI arguments
    const args = [
      '-p', message,
      '--output-format', 'stream-json',
    ];

    // Add model if specified
    if (session.model) {
      args.push('--model', session.model);
    }

    // SECURITY: Use safeSpawn to prevent command injection
    const proc = safeSpawn(spawn, 'claude', args, {
      cwd: session.workDir,
      env: process.env,
    });

    this.processes.set(sessionId, proc);

    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    // Handle stdout (streaming JSON)
    for await (const chunk of proc.stdout) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);

          switch (event.type) {
            case 'message':
            case 'text':
            case 'assistant':
              if (event.content || event.text || event.message) {
                yield { type: 'text', content: event.content || event.text || event.message };
              }
              break;

            case 'tool_use':
              yield { type: 'tool_use', name: event.name, input: event.input, id: event.id };
              break;

            case 'tool_result':
              yield { type: 'tool_result', toolUseId: event.tool_use_id, content: event.content };
              break;

            case 'usage':
            case 'stats':
              inputTokens = event.input_tokens || event.inputTokens || 0;
              outputTokens = event.output_tokens || event.outputTokens || 0;
              yield { type: 'metadata', data: { inputTokens, outputTokens } };
              break;

            case 'error':
              yield { type: 'error', error: event.error || event.message };
              break;

            case 'result':
            case 'done':
              yield { type: 'complete', result: event };
              break;

            default:
              // Try to extract text from unknown event types
              if (event.text || event.content) {
                yield { type: 'text', content: event.text || event.content };
              }
          }
        } catch (e) {
          // Not JSON, treat as raw text output
          if (line.trim()) {
            yield { type: 'text', content: line };
          }
        }
      }
    }

    // Handle any remaining buffer
    if (buffer.trim()) {
      yield { type: 'text', content: buffer };
    }

    // Update session stats
    session.totalInputTokens += inputTokens;
    session.totalOutputTokens += outputTokens;
    session.status = 'ready';

    // Wait for process to complete
    await new Promise((resolve, reject) => {
      proc.on('close', resolve);
      proc.on('error', reject);
    });

    this.processes.delete(sessionId);
  }

  async terminate(sessionId) {
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(sessionId);
    }
    this.sessions.delete(sessionId);
  }

  estimateCost(inputTokens, outputTokens, model = this.getDefaultModel()) {
    const pricing = this.pricing[model] || this.pricing[this.getDefaultModel()];
    return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  }

  /**
   * Get authentication info for display
   */
  getAuthInfo() {
    return {
      method: 'api-key',
      isFree: false,
      models: this.getSupportedModels(),
      note: 'Claude Code requires authentication - run: claude auth login',
    };
  }
}

export default ClaudeCodeAdapter;
