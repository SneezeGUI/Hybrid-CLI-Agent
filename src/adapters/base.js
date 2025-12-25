/**
 * Base Adapter Class
 *
 * Abstract base class for all CLI adapters in the hybrid agent system.
 * Provides common interface and utilities for managing AI CLI sessions.
 */

export class BaseAdapter {
  constructor(config = {}) {
    this.config = config;
    this.name = 'base';
    this.sessions = new Map();
  }

  /**
   * Get the command to check if the CLI tool is available
   * @returns {string} Shell command to verify installation
   */
  getCheckCommand() {
    throw new Error('getCheckCommand() must be implemented by subclass');
  }

  /**
   * Check if the CLI tool is available on the system
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return Promise.reject(new Error('isAvailable() must be implemented by subclass'));
  }

  /**
   * Get list of supported models for this adapter
   * @returns {string[]}
   */
  getSupportedModels() {
    return [];
  }

  /**
   * Get the default model for this adapter
   * @returns {string|null}
   */
  getDefaultModel() {
    return null;
  }

  /**
   * Spawn a new session with the CLI tool
   * @param {string} sessionId - Unique session identifier
   * @param {Object} options - Session options (model, workDir, etc.)
   * @returns {Promise<Object>} Session info
   */
  async spawn(sessionId, options = {}) {
    return Promise.reject(new Error('spawn() must be implemented by subclass'));
  }

  /**
   * Send a message to an active session (streaming)
   * @param {string} sessionId - Session identifier
   * @param {string} message - Message to send
   * @param {Object} options - Additional options
   * @yields {Object} Stream events { type, content/data/error }
   */
  async *send(sessionId, message, options = {}) {
    throw new Error('send() must be implemented by subclass');
  }

  /**
   * Send a message and wait for complete response
   * @param {string} sessionId - Session identifier
   * @param {string} message - Message to send
   * @param {Object} options - Additional options
   * @returns {Promise<{text: string, metadata: Object}>}
   */
  async sendAndWait(sessionId, message, options = {}) {
    let text = '';
    let metadata = { inputTokens: 0, outputTokens: 0 };

    for await (const event of this.send(sessionId, message, options)) {
      switch (event.type) {
        case 'text':
          text += event.content || '';
          break;
        case 'metadata':
          metadata = { ...metadata, ...event.data };
          break;
        case 'error':
          throw new Error(event.error);
        case 'complete':
          // Final event, extract any metadata
          if (event.result?.metadata) {
            metadata = { ...metadata, ...event.result.metadata };
          }
          break;
      }
    }

    return { text, metadata };
  }

  /**
   * Terminate a session
   * @param {string} sessionId - Session identifier
   */
  async terminate(sessionId) {
    return Promise.reject(new Error('terminate() must be implemented by subclass'));
  }

  /**
   * Get session info
   * @param {string} sessionId - Session identifier
   * @returns {Object|undefined}
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session status (alias for getSession with null fallback)
   * @param {string} sessionId - Session identifier
   * @returns {Object|null}
   */
  getStatus(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * List all active sessions
   * @returns {Object[]}
   */
  listSessions() {
    return Array.from(this.sessions.values());
  }

  /**
   * Estimate cost for token usage
   * @param {number} inputTokens - Number of input tokens
   * @param {number} outputTokens - Number of output tokens
   * @param {string} model - Model name (optional)
   * @returns {number} Estimated cost in USD
   */
  estimateCost(inputTokens, outputTokens, model = null) {
    // Default: no cost tracking, subclasses should override
    return 0;
  }
}

export default BaseAdapter;
