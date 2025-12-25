import { spawn } from 'child_process';
import { BaseAdapter } from './base.js';
import { safeSpawn } from '../utils/security.js';
import { GEMINI_PRICING } from '../config/index.js';

/**
 * Authentication Methods:
 *
 * 1. OAuth (Google Pro/Ultra subscription) - RECOMMENDED
 *    Run: gemini auth login
 *    Benefits: 60 RPM, 1000 RPD FREE, access to latest models
 *
 * 2. Standard API Key
 *    Set: GEMINI_API_KEY=your-key
 *    Get key: https://makersuite.google.com/app/apikey
 *
 * 3. Vertex AI (for Gemini 3 Pro without restrictions)
 *    Set: VERTEX_API_KEY=your-vertex-key
 *    Or use Application Default Credentials (ADC)
 */

/**
 * Gemini CLI Adapter
 * Wraps the `gemini` CLI tool for programmatic access
 *
 * With OAuth (Pro subscription): 60 RPM, 1000 RPD - effectively FREE
 * With API key: Standard rate limits apply
 */
export class GeminiCliAdapter extends BaseAdapter {
  constructor(config = {}) {
    super(config);
    this.name = 'gemini-cli';
    this.processes = new Map();

    // Authentication configuration
    this.auth = {
      method: config.authMethod || this.detectAuthMethod(),
      apiKey: config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      vertexKey: config.vertexKey || process.env.VERTEX_API_KEY,
      vertexProject: config.vertexProject || process.env.VERTEX_PROJECT,
      vertexLocation: config.vertexLocation || process.env.VERTEX_LOCATION || 'us-central1',
    };

    // Pricing per 1M tokens - imported from centralized config
    // Note: OAuth users get FREE tier
    this.pricing = GEMINI_PRICING;
  }

  /**
   * Detect which authentication method is available
   */
  detectAuthMethod() {
    if (process.env.VERTEX_API_KEY) return 'vertex';
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'api-key';
    return 'oauth'; // Default to OAuth (gemini auth login)
  }

  /**
   * Check authentication status
   */
  async checkAuth() {
    return new Promise((resolve) => {
      // SECURITY: Use safeSpawn to prevent command injection
      const proc = safeSpawn(spawn, 'gemini', ['auth', 'status'], {});
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => {
        resolve({
          authenticated: code === 0,
          method: this.auth.method,
          output: output.trim(),
          isProSubscription: output.includes('Pro') || output.includes('Ultra'),
        });
      });
      proc.on('error', () => resolve({ authenticated: false, method: 'none' }));
    });
  }

  getCheckCommand() {
    return 'gemini --version';
  }

  async isAvailable() {
    return new Promise((resolve) => {
      // SECURITY: Use safeSpawn to prevent command injection
      const proc = safeSpawn(spawn, 'gemini', ['--version'], {});
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  getSupportedModels() {
    // Models available depend on auth method
    const baseModels = [
      'gemini-2.5-flash',
      'gemini-2.5-pro', 
    ];
    
    // Vertex AI and Pro subscriptions get access to Gemini 3
    if (this.auth.method === 'vertex' || this.auth.method === 'oauth') {
      return [
        ...baseModels,
        'gemini-3-pro-preview',
        'gemini-3-pro',
      ];
    }
    
    return baseModels;
  }

  getDefaultModel() {
    // Use Gemini 3 Pro if available via Vertex AI, otherwise Pro 2.5
    if (this.auth.method === 'vertex') {
      return 'gemini-3-pro';
    }
    return 'gemini-2.5-pro';
  }

  /**
   * Build environment variables for the CLI process
   */
  buildEnv() {
    const env = { ...process.env };
    
    // Set API key if using that auth method
    if (this.auth.method === 'api-key' && this.auth.apiKey) {
      env.GEMINI_API_KEY = this.auth.apiKey;
    }
    
    // Set Vertex AI credentials if using that method
    if (this.auth.method === 'vertex') {
      if (this.auth.vertexKey) {
        env.VERTEX_API_KEY = this.auth.vertexKey;
      }
      if (this.auth.vertexProject) {
        env.VERTEX_PROJECT = this.auth.vertexProject;
      }
      if (this.auth.vertexLocation) {
        env.VERTEX_LOCATION = this.auth.vertexLocation;
      }
    }
    
    return env;
  }

  async spawn(sessionId, options = {}) {
    const {
      model = this.getDefaultModel(),
      workDir = process.cwd(),
      systemPrompt = null,
      temperature = 0.7,
      topP = 0.9,
    } = options;

    // Check auth status for this session
    const authStatus = await this.checkAuth();

    this.sessions.set(sessionId, {
      id: sessionId,
      adapter: this.name,
      model,
      workDir,
      systemPrompt,
      temperature,
      topP,
      status: 'ready',
      createdAt: new Date().toISOString(),
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      // Cost tracking - FREE with OAuth/Pro subscription
      estimatedCost: 0,
      auth: {
        method: this.auth.method,
        isProSubscription: authStatus.isProSubscription,
        isFree: this.auth.method === 'oauth' || authStatus.isProSubscription,
      },
    });

    return this.sessions.get(sessionId);
  }

  /**
   * Run Gemini CLI synchronously and return full response
   * Used by MCP tools for simpler integration
   */
  async runSync(prompt, options = {}) {
    const {
      model = this.getDefaultModel(),
      workDir = process.cwd(),
    } = options;

    return new Promise((resolve, reject) => {
      // Use stdin to pass prompt (avoids command line length limits on Windows)
      const args = ['--model', model, '--output-format', 'text'];

      // SECURITY: Use safeSpawn to prevent command injection
      const proc = safeSpawn(spawn, 'gemini', args, {
        cwd: workDir,
        env: this.buildEnv(),
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Gemini CLI exited with code ${code}`));
        }
      });

      proc.on('error', reject);

      // Write prompt to stdin and close it to signal end of input
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  async *send(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.status = 'busy';
    session.messageCount++;

    // Use positional prompt (new recommended way) with stream-json for streaming
    const args = [
      '--model', session.model,
      '--output-format', 'stream-json',
      '--yolo', // Non-interactive automation mode
      message,
    ];

    // SECURITY: Use safeSpawn to prevent command injection
    const proc = safeSpawn(spawn, 'gemini', args, {
      cwd: session.workDir,
      env: this.buildEnv(),
    });

    this.processes.set(sessionId, proc);

    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

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
              if (event.content || event.text) {
                yield { type: 'text', content: event.content || event.text };
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
              if (event.text || event.content) {
                yield { type: 'text', content: event.text || event.content };
              }
          }
        } catch (e) {
          if (line.trim()) {
            yield { type: 'text', content: line };
          }
        }
      }
    }

    if (buffer.trim()) {
      yield { type: 'text', content: buffer };
    }

    session.totalInputTokens += inputTokens;
    session.totalOutputTokens += outputTokens;
    session.status = 'ready';

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
    // OAuth with Pro/Ultra subscription = FREE (60 RPM, 1000 RPD)
    // Vertex AI with service account = Billed per token
    // API key = Billed per token (but has free tier)
    
    if (this.auth.method === 'oauth') {
      // Pro subscription users get FREE access via CLI
      return 0;
    }
    
    // For API key and Vertex AI, calculate actual cost
    const pricing = this.pricing[model] || this.pricing[this.getDefaultModel()];
    return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  }

  /**
   * Get authentication info for display
   */
  getAuthInfo() {
    return {
      method: this.auth.method,
      isFree: this.auth.method === 'oauth',
      models: this.getSupportedModels(),
      note: this.auth.method === 'oauth' 
        ? 'Using OAuth - 60 RPM, 1000 RPD FREE with Pro subscription'
        : this.auth.method === 'vertex'
        ? 'Using Vertex AI - billed per token, but no rate limits'
        : 'Using API key - standard rate limits apply',
    };
  }
}

export default GeminiCliAdapter;
