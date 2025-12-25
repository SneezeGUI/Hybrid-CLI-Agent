/**
 * Tests for ConversationManager service
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'crypto';

import ConversationManager, { 
  getConversationManager, 
  MessageRole, 
  ConversationState 
} from '../src/services/conversation-manager.js';

describe('ConversationManager', () => {
  let manager;

  beforeEach(() => {
    // Create a fresh instance for each test - disable auto cleanup to avoid timer issues
    manager = new ConversationManager({
      autoCleanup: false // Disable auto cleanup for testing
    });
  });

  afterEach(() => {
    if (manager) {
      manager.destroy();
      manager = null;
    }
  });

  describe('Constructor & Configuration', () => {
    it('should initialize with default configuration', () => {
      assert.strictEqual(manager.config.maxMessages, 100);
      assert.strictEqual(manager.config.maxTokensPerMessage, 32000);
      assert.strictEqual(manager.conversations.size, 0);
      assert.strictEqual(manager.stats.totalConversations, 0);
    });

    it('should accept custom configuration', () => {
      const customManager = new ConversationManager({
        maxMessages: 10,
        maxTotalTokens: 5000
      });
      assert.strictEqual(customManager.config.maxMessages, 10);
      assert.strictEqual(customManager.config.maxTotalTokens, 5000);
      customManager.destroy();
    });

    it('should clear cleanup timer on destroy', (t) => {
      // We can't easily check the timer object directly, but we can verify no errors occur
      // and potentially check if logic works after destroy (it shouldn't crash)
      manager.destroy();
      assert.strictEqual(manager.conversations.size, 0);
    });
  });

  describe('startConversation', () => {
    it('should create conversation with auto-generated ID', () => {
      const { id, title } = manager.startConversation();
      assert.ok(id);
      assert.strictEqual(typeof id, 'string');
      assert.ok(title.includes('Conversation'));
      assert.strictEqual(manager.stats.activeConversations, 1);
    });

    it('should accept custom title and system prompt', () => {
      const customId = randomUUID();
      const options = {
        id: customId,
        title: 'Test Chat',
        systemPrompt: 'Be a pirate',
        model: 'gemini-test'
      };

      const result = manager.startConversation(options);
      const conv = manager.getConversation(customId);

      assert.strictEqual(result.id, customId);
      assert.strictEqual(conv.title, 'Test Chat');
      assert.strictEqual(conv.systemPrompt, 'Be a pirate');
      assert.strictEqual(conv.model, 'gemini-test');
      assert.strictEqual(conv.state, ConversationState.ACTIVE);
      
      // System prompt should be added as the first message
      assert.strictEqual(conv.messages.length, 1);
      assert.strictEqual(conv.messages[0].role, MessageRole.SYSTEM);
      assert.strictEqual(conv.messages[0].content, 'Be a pirate');
    });

    it('should update global stats', () => {
      manager.startConversation();
      manager.startConversation();
      assert.strictEqual(manager.stats.totalConversations, 2);
      assert.strictEqual(manager.stats.activeConversations, 2);
    });
  });

  describe('addMessage', () => {
    let convId;

    beforeEach(() => {
      const result = manager.startConversation();
      convId = result.id;
    });

    it('should add user messages and update stats', () => {
      const content = 'Hello';
      const msg = manager.addMessage(convId, MessageRole.USER, content);

      assert.strictEqual(msg.role, MessageRole.USER);
      assert.strictEqual(msg.content, content);
      
      const conv = manager.getConversation(convId);
      assert.strictEqual(conv.messages.length, 1);
      assert.strictEqual(conv.stats.userMessages, 1);
      assert.strictEqual(manager.stats.totalMessages, 1);
    });

    it('should add assistant messages with token count', () => {
      const content = 'Hi there'; // 8 chars -> ~2 tokens (Math.ceil(8/4))
      const msg = manager.addMessage(convId, MessageRole.ASSISTANT, content);

      assert.strictEqual(msg.role, MessageRole.ASSISTANT);
      assert.strictEqual(msg.tokens, 2);
      
      const conv = manager.getConversation(convId);
      assert.strictEqual(conv.stats.assistantMessages, 1);
      assert.strictEqual(conv.stats.estimatedTokens, 2);
    });

    it('should throw for non-existent conversation', () => {
      assert.throws(() => {
        manager.addMessage('fake-id', MessageRole.USER, 'hi');
      }, /Conversation fake-id not found/);
    });

    it('should throw for non-ACTIVE conversation', () => {
      manager.endConversation(convId);
      assert.throws(() => {
        manager.addMessage(convId, MessageRole.USER, 'hi');
      }, /Conversation .* is completed/);
    });

    it('should enforce message limits', () => {
      const smallManager = new ConversationManager({ maxMessages: 2 });
      const { id } = smallManager.startConversation(); // 0 messages

      smallManager.addMessage(id, MessageRole.USER, '1'); // 1 message
      smallManager.addMessage(id, MessageRole.ASSISTANT, '2'); // 2 messages

      assert.throws(() => {
        smallManager.addMessage(id, MessageRole.USER, '3');
      }, /Conversation has reached max messages/);
      
      smallManager.destroy();
    });

    it('should enforce token limits', () => {
      const limitManager = new ConversationManager({ maxTotalTokens: 10 });
      const { id } = limitManager.startConversation();

      // "12345678" -> 8 chars -> 2 tokens. Safe.
      limitManager.addMessage(id, MessageRole.USER, '12345678'); 
      
      // "1234567890123456789012345678901234567890" -> 40 chars -> 10 tokens.
      // Total 12 tokens > 10. Should fail.
      assert.throws(() => {
        limitManager.addMessage(id, MessageRole.ASSISTANT, '1234567890123456789012345678901234567890');
      }, /Conversation would exceed token limit/);

      limitManager.destroy();
    });
  });

  describe('getHistoryForGemini', () => {
    it('should return formatted message array excluding system prompts', () => {
      const { id } = manager.startConversation({ systemPrompt: 'System' });
      manager.addMessage(id, MessageRole.USER, 'User 1');
      manager.addMessage(id, MessageRole.ASSISTANT, 'AI 1');

      const history = manager.getHistoryForGemini(id);

      assert.strictEqual(history.length, 2); // Should exclude system
      assert.strictEqual(history[0].role, MessageRole.USER);
      assert.strictEqual(history[0].content, 'User 1');
      assert.strictEqual(history[1].role, MessageRole.ASSISTANT);
      assert.strictEqual(history[1].content, 'AI 1');
    });

    it('should return null for invalid ID', () => {
      const history = manager.getHistoryForGemini('bad-id');
      assert.strictEqual(history, null);
    });
  });

  describe('buildContextPrompt', () => {
    it('should include system prompt if present', () => {
      const { id } = manager.startConversation({ systemPrompt: 'You are a helper.' });
      manager.addMessage(id, MessageRole.USER, 'Hi');
      manager.addMessage(id, MessageRole.ASSISTANT, 'Hello');

      const prompt = manager.buildContextPrompt(id, 'New Question');

      assert.ok(prompt.includes('SYSTEM CONTEXT: You are a helper.'));
      assert.ok(prompt.includes('[USER]: Hi'));
      assert.ok(prompt.includes('[ASSISTANT]: Hello'));
      assert.ok(prompt.includes('[USER]: New Question'));
    });

    it('should format correctly without system prompt', () => {
      const { id } = manager.startConversation();
      manager.addMessage(id, MessageRole.USER, 'Hi');

      const prompt = manager.buildContextPrompt(id, 'Next');

      assert.ok(!prompt.includes('SYSTEM CONTEXT'));
      assert.ok(prompt.includes('CONVERSATION HISTORY'));
      assert.ok(prompt.includes('[USER]: Hi'));
      assert.ok(prompt.includes('[USER]: Next'));
    });
  });

  describe('listConversations', () => {
    beforeEach(() => {
      // Create 3 conversations
      const c1 = manager.startConversation({ title: 'C1' });
      const c2 = manager.startConversation({ title: 'C2' });
      const c3 = manager.startConversation({ title: 'C3' });

      // Update timestamps slightly to test sorting
      manager.getConversation(c1.id).metadata.updatedAt = new Date(Date.now() - 3000).toISOString();
      manager.getConversation(c2.id).metadata.updatedAt = new Date(Date.now() - 2000).toISOString();
      manager.getConversation(c3.id).metadata.updatedAt = new Date(Date.now() - 1000).toISOString();
    });

    it('should return all conversations sorted by last update', () => {
      const list = manager.listConversations();
      assert.strictEqual(list.total, 3);
      assert.strictEqual(list.conversations[0].title, 'C3'); // Newest
      assert.strictEqual(list.conversations[2].title, 'C1'); // Oldest
    });

    it('should filter by state', () => {
      const list = manager.listConversations();
      const idToComplete = list.conversations[0].id;
      manager.endConversation(idToComplete);

      const activeList = manager.listConversations({ state: ConversationState.ACTIVE });
      assert.strictEqual(activeList.total, 2); // 3 total, 1 completed -> filter returns array length 2

      const completedList = manager.listConversations({ state: ConversationState.COMPLETED });
      assert.strictEqual(completedList.total, 1);
    });

    it('should paginate results', () => {
      const list = manager.listConversations({ limit: 2, offset: 0 });
      assert.strictEqual(list.conversations.length, 2);
      assert.strictEqual(list.total, 3); // Total count remains 3
      
      const page2 = manager.listConversations({ limit: 2, offset: 2 });
      assert.strictEqual(page2.conversations.length, 1);
    });
  });

  describe('clearConversation / endConversation', () => {
    let convId;

    beforeEach(() => {
      const { id } = manager.startConversation();
      convId = id;
    });

    it('endConversation should set state to COMPLETED and decrease active count', () => {
      assert.strictEqual(manager.stats.activeConversations, 1);
      
      const success = manager.endConversation(convId);
      const conv = manager.getConversation(convId);
      
      assert.strictEqual(success, true);
      assert.strictEqual(conv.state, ConversationState.COMPLETED);
      assert.ok(conv.metadata.completedAt);
      assert.strictEqual(manager.stats.activeConversations, 0);
    });

    it('clearConversation should delete conversation and decrease active count', () => {
      assert.strictEqual(manager.stats.activeConversations, 1);
      
      const success = manager.clearConversation(convId);
      
      assert.strictEqual(success, true);
      assert.strictEqual(manager.getConversation(convId), null);
      assert.strictEqual(manager.stats.activeConversations, 0);
    });

    it('should handle non-existent conversation IDs', () => {
      assert.strictEqual(manager.endConversation('fake'), false);
      assert.strictEqual(manager.clearConversation('fake'), false);
    });
  });

  describe('getConversationStats / getGlobalStats', () => {
    it('should return per-conversation stats', () => {
      const { id } = manager.startConversation();
      manager.addMessage(id, MessageRole.USER, 'test'); // 4 chars -> 1 token

      const stats = manager.getConversationStats(id);
      
      assert.strictEqual(stats.id, id);
      assert.strictEqual(stats.state, ConversationState.ACTIVE);
      assert.strictEqual(stats.stats.messageCount, 1);
      assert.strictEqual(stats.stats.estimatedTokens, 1);
      assert.ok(stats.tokenUsagePercent >= 0);
      assert.ok(stats.messageUsagePercent >= 0);
    });

    it('should return global stats', () => {
      manager.startConversation();
      const stats = manager.getGlobalStats();

      assert.strictEqual(stats.totalConversations, 1);
      assert.strictEqual(stats.activeConversations, 1);
      assert.ok(stats.config);
    });
  });

  describe('exportConversation / importConversation', () => {
    it('exportConversation should produce valid JSON', () => {
      const { id } = manager.startConversation({ title: 'Export Me' });
      manager.addMessage(id, MessageRole.USER, 'Hello');

      const jsonStr = manager.exportConversation(id, 'json');
      const data = JSON.parse(jsonStr);

      assert.strictEqual(data.title, 'Export Me');
      assert.strictEqual(data.messages.length, 1);
    });

    it('exportConversation should produce Markdown', () => {
      const { id } = manager.startConversation({ title: 'Export MD' });
      manager.addMessage(id, MessageRole.USER, 'Hello MD');

      const md = manager.exportConversation(id, 'markdown');

      assert.ok(md.includes('# Export MD'));
      assert.ok(md.includes('### 👤 User'));
      assert.ok(md.includes('Hello MD'));
    });

    it('importConversation should create new conversation with new ID', () => {
      const original = {
        title: 'Imported',
        model: 'gemini-pro',
        state: ConversationState.COMPLETED,
        messages: [{ role: 'user', content: 'Hi' }],
        stats: { messageCount: 1 },
        metadata: { createdAt: new Date().toISOString() }
      };

      const newId = manager.importConversation(original);
      const conv = manager.getConversation(newId);

      assert.ok(newId);
      assert.strictEqual(conv.title, 'Imported');
      assert.strictEqual(conv.messages.length, 1);
      assert.strictEqual(conv.metadata.importedAt !== undefined, true);
      // Stats should reflect the imported state (completed)
      assert.strictEqual(manager.stats.activeConversations, 0); 
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired conversations', () => {
      // Custom manager with very short expiration for manual testing logic
      const expManager = new ConversationManager({ expirationMs: 1000 });
      
      const { id: activeId } = expManager.startConversation();
      const { id: expiredId } = expManager.startConversation();

      // Manually age the expired conversation
      const expiredConv = expManager.getConversation(expiredId);
      expiredConv.metadata.updatedAt = new Date(Date.now() - 2000).toISOString();

      const cleanedCount = expManager.cleanupExpired();

      assert.strictEqual(cleanedCount, 1);
      assert.strictEqual(expManager.getConversation(expiredId), null);
      assert.notStrictEqual(expManager.getConversation(activeId), null);
      
      // Check stats update
      assert.strictEqual(expManager.stats.activeConversations, 1);
      
      expManager.destroy();
    });
  });

  describe('Singleton pattern', () => {
    it('getConversationManager should return same instance', () => {
      const instance1 = getConversationManager();
      const instance2 = getConversationManager();
      assert.strictEqual(instance1, instance2);
      // Clean up singleton to avoid keeping timer alive
      instance1.destroy();
    });
  });
});