/**
 * Conversation Manager
 *
 * Manages stateful conversations with Gemini CLI.
 * Provides in-memory storage with optional persistence.
 *
 * Features:
 * - Multi-turn conversation tracking
 * - Automatic context management
 * - Token counting and limits
 * - Conversation history export
 */

import { randomUUID } from 'crypto';

/**
 * Message roles
 */
export const MessageRole = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
};

/**
 * Conversation state
 */
export const ConversationState = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
};

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  maxMessages: 100,           // Max messages per conversation
  maxTokensPerMessage: 32000, // Approximate token limit per message
  maxTotalTokens: 1000000,    // Max tokens per conversation (Gemini has 1M+ context)
  expirationMs: 24 * 60 * 60 * 1000, // 24 hours default expiration
  autoCleanupInterval: 60 * 60 * 1000, // Cleanup expired every hour
};

/**
 * Conversation Manager Class
 */
export class ConversationManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.conversations = new Map();
    this.stats = {
      totalConversations: 0,
      activeConversations: 0,
      totalMessages: 0,
      totalTokensEstimated: 0,
    };

    // Auto-cleanup timer (optional)
    if (this.config.autoCleanup !== false) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpired();
      }, this.config.autoCleanupInterval);
    }
  }

  /**
   * Start a new conversation
   */
  startConversation(options = {}) {
    const {
      id = randomUUID(),
      title = `Conversation ${this.stats.totalConversations + 1}`,
      systemPrompt = null,
      model = 'gemini-2.5-pro',
      metadata = {},
    } = options;

    const conversation = {
      id,
      title,
      model,
      systemPrompt,
      state: ConversationState.ACTIVE,
      messages: [],
      metadata: {
        ...metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      stats: {
        messageCount: 0,
        estimatedTokens: 0,
        userMessages: 0,
        assistantMessages: 0,
      },
    };

    // Add system prompt as first message if provided
    if (systemPrompt) {
      conversation.messages.push({
        id: randomUUID(),
        role: MessageRole.SYSTEM,
        content: systemPrompt,
        timestamp: new Date().toISOString(),
        tokens: this.estimateTokens(systemPrompt),
      });
      conversation.stats.estimatedTokens += this.estimateTokens(systemPrompt);
    }

    this.conversations.set(id, conversation);
    this.stats.totalConversations++;
    this.stats.activeConversations++;

    return {
      id: conversation.id,
      title: conversation.title,
      model: conversation.model,
      state: conversation.state,
      createdAt: conversation.metadata.createdAt,
    };
  }

  /**
   * Add a message to a conversation
   */
  addMessage(conversationId, role, content) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    if (conversation.state !== ConversationState.ACTIVE) {
      throw new Error(`Conversation ${conversationId} is ${conversation.state}`);
    }

    // Check limits
    if (conversation.messages.length >= this.config.maxMessages) {
      throw new Error(`Conversation has reached max messages (${this.config.maxMessages})`);
    }

    const tokens = this.estimateTokens(content);
    if (conversation.stats.estimatedTokens + tokens > this.config.maxTotalTokens) {
      throw new Error(`Conversation would exceed token limit`);
    }

    const message = {
      id: randomUUID(),
      role,
      content,
      timestamp: new Date().toISOString(),
      tokens,
    };

    conversation.messages.push(message);
    conversation.metadata.updatedAt = new Date().toISOString();
    conversation.stats.messageCount++;
    conversation.stats.estimatedTokens += tokens;

    if (role === MessageRole.USER) {
      conversation.stats.userMessages++;
    } else if (role === MessageRole.ASSISTANT) {
      conversation.stats.assistantMessages++;
    }

    this.stats.totalMessages++;
    this.stats.totalTokensEstimated += tokens;

    return message;
  }

  /**
   * Get conversation by ID
   */
  getConversation(conversationId) {
    return this.conversations.get(conversationId) || null;
  }

  /**
   * Get conversation history formatted for Gemini
   */
  getHistoryForGemini(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return null;
    }

    // Format messages for Gemini CLI
    // Gemini expects alternating user/assistant format
    return conversation.messages
      .filter(m => m.role !== MessageRole.SYSTEM)
      .map(m => ({
        role: m.role,
        content: m.content,
      }));
  }

  /**
   * Build context prompt including conversation history
   */
  buildContextPrompt(conversationId, newMessage) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return newMessage;
    }

    const history = conversation.messages
      .filter(m => m.role !== MessageRole.SYSTEM)
      .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join('\n\n');

    const systemContext = conversation.systemPrompt
      ? `SYSTEM CONTEXT: ${conversation.systemPrompt}\n\n`
      : '';

    return `${systemContext}CONVERSATION HISTORY:
${history}

[USER]: ${newMessage}

Continue the conversation naturally. Respond as the assistant:`;
  }

  /**
   * List all conversations
   */
  listConversations(options = {}) {
    const { state = null, limit = 50, offset = 0 } = options;

    let conversations = Array.from(this.conversations.values());

    // Filter by state if specified
    if (state) {
      conversations = conversations.filter(c => c.state === state);
    }

    // Sort by updated date (newest first)
    conversations.sort((a, b) =>
      new Date(b.metadata.updatedAt) - new Date(a.metadata.updatedAt)
    );

    // Apply pagination
    const paginated = conversations.slice(offset, offset + limit);

    return {
      conversations: paginated.map(c => ({
        id: c.id,
        title: c.title,
        model: c.model,
        state: c.state,
        messageCount: c.stats.messageCount,
        createdAt: c.metadata.createdAt,
        updatedAt: c.metadata.updatedAt,
      })),
      total: conversations.length,
      limit,
      offset,
    };
  }

  /**
   * Clear/delete a conversation
   */
  clearConversation(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return false;
    }

    if (conversation.state === ConversationState.ACTIVE) {
      this.stats.activeConversations--;
    }

    this.conversations.delete(conversationId);
    return true;
  }

  /**
   * End a conversation (mark as completed)
   */
  endConversation(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return false;
    }

    if (conversation.state === ConversationState.ACTIVE) {
      this.stats.activeConversations--;
    }

    conversation.state = ConversationState.COMPLETED;
    conversation.metadata.completedAt = new Date().toISOString();
    return true;
  }

  /**
   * Get conversation statistics
   */
  getConversationStats(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return null;
    }

    return {
      id: conversation.id,
      title: conversation.title,
      state: conversation.state,
      model: conversation.model,
      stats: { ...conversation.stats },
      metadata: { ...conversation.metadata },
      tokenUsagePercent: (conversation.stats.estimatedTokens / this.config.maxTotalTokens) * 100,
      messageUsagePercent: (conversation.stats.messageCount / this.config.maxMessages) * 100,
    };
  }

  /**
   * Get global statistics
   */
  getGlobalStats() {
    return {
      ...this.stats,
      config: {
        maxMessages: this.config.maxMessages,
        maxTotalTokens: this.config.maxTotalTokens,
        expirationMs: this.config.expirationMs,
      },
    };
  }

  /**
   * Estimate tokens for a string (rough approximation)
   * Gemini uses ~4 characters per token on average
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Cleanup expired conversations
   */
  cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, conversation] of this.conversations) {
      const updatedAt = new Date(conversation.metadata.updatedAt).getTime();
      if (now - updatedAt > this.config.expirationMs) {
        if (conversation.state === ConversationState.ACTIVE) {
          this.stats.activeConversations--;
        }
        this.conversations.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Export conversation history
   */
  exportConversation(conversationId, format = 'json') {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return null;
    }

    if (format === 'markdown') {
      let md = `# ${conversation.title}\n\n`;
      md += `**Model:** ${conversation.model}\n`;
      md += `**Created:** ${conversation.metadata.createdAt}\n`;
      md += `**Messages:** ${conversation.stats.messageCount}\n\n`;
      md += `---\n\n`;

      for (const msg of conversation.messages) {
        const roleLabel = msg.role === MessageRole.USER ? '👤 User' :
                         msg.role === MessageRole.ASSISTANT ? '🤖 Assistant' : '⚙️ System';
        md += `### ${roleLabel}\n\n${msg.content}\n\n`;
      }

      return md;
    }

    // Default: JSON
    return JSON.stringify(conversation, null, 2);
  }

  /**
   * Import conversation from exported data
   */
  importConversation(data) {
    const conversation = typeof data === 'string' ? JSON.parse(data) : data;

    // Generate new ID to avoid conflicts
    conversation.id = randomUUID();
    conversation.metadata.importedAt = new Date().toISOString();

    this.conversations.set(conversation.id, conversation);
    this.stats.totalConversations++;

    if (conversation.state === ConversationState.ACTIVE) {
      this.stats.activeConversations++;
    }

    return conversation.id;
  }

  /**
   * Cleanup on shutdown
   */
  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.conversations.clear();
  }
}

// Singleton instance for MCP server
let instance = null;

export function getConversationManager(config = {}) {
  if (!instance) {
    instance = new ConversationManager(config);
  }
  return instance;
}

export default ConversationManager;
