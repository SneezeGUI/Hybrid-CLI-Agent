/**
 * Conversation Tool Handlers
 *
 * Handlers: gemini_start_conversation, gemini_continue_conversation,
 *           gemini_list_conversations, gemini_clear_conversation, gemini_conversation_stats
 */

import { success, error } from '../base.js';

/**
 * Start a new conversation
 */
async function handleGeminiStartConversation(args, context) {
  const { title, system_prompt, model = 'gemini-2.5-pro', initial_message } = args;
  const { getConversationManager, runGeminiCli, MessageRole } = context;

  try {
    const conversationManager = getConversationManager();

    const conversation = conversationManager.startConversation({
      title,
      systemPrompt: system_prompt,
      model,
    });

    let response = `Conversation started!
- ID: ${conversation.id}
- Title: ${conversation.title}
- Model: ${conversation.model}

Use gemini_continue_conversation with this ID to send messages.`;

    // If initial message provided, send it
    if (initial_message) {
      conversationManager.addMessage(conversation.id, MessageRole.USER, initial_message);
      const contextPrompt = conversationManager.buildContextPrompt(conversation.id, initial_message);
      const geminiResponse = await runGeminiCli(contextPrompt, { model });
      conversationManager.addMessage(conversation.id, MessageRole.ASSISTANT, geminiResponse);

      response += `\n\n---\n\n**Initial Response:**\n${geminiResponse}`;
    }

    return success(response);
  } catch (err) {
    return error(`Failed to start conversation: ${err.message}`);
  }
}

/**
 * Continue an existing conversation
 */
async function handleGeminiContinueConversation(args, context) {
  const { conversation_id, message } = args;
  const { getConversationManager, runGeminiCli, MessageRole } = context;

  const conversationManager = getConversationManager();
  const conversation = conversationManager.getConversation(conversation_id);

  if (!conversation) {
    return error(`Conversation ${conversation_id} not found`);
  }

  try {
    // Add user message
    conversationManager.addMessage(conversation_id, MessageRole.USER, message);

    // Build context prompt with history
    const contextPrompt = conversationManager.buildContextPrompt(conversation_id, message);

    // Get Gemini response
    const geminiResponse = await runGeminiCli(contextPrompt, { model: conversation.model });

    // Add assistant response
    conversationManager.addMessage(conversation_id, MessageRole.ASSISTANT, geminiResponse);

    const stats = conversationManager.getConversationStats(conversation_id);

    return success(`[${conversation.title} - Turn ${stats.stats.userMessages}]\n\n${geminiResponse}\n\n---\n_Tokens: ~${stats.stats.estimatedTokens} | Messages: ${stats.stats.messageCount}_`);
  } catch (err) {
    return error(`Failed to continue conversation: ${err.message}`);
  }
}

/**
 * List conversations
 */
async function handleGeminiListConversations(args, context) {
  const { state, limit = 20 } = args;
  const { getConversationManager } = context;

  const conversationManager = getConversationManager();
  const result = conversationManager.listConversations({ state, limit });

  if (result.conversations.length === 0) {
    return success('No conversations found. Use gemini_start_conversation to create one.');
  }

  let output = `# Conversations (${result.total} total)\n\n`;
  for (const conv of result.conversations) {
    const stateEmoji = conv.state === 'active' ? '🟢' : conv.state === 'completed' ? '✅' : '⏸️';
    output += `${stateEmoji} **${conv.title}**\n`;
    output += `   ID: \`${conv.id}\`\n`;
    output += `   Model: ${conv.model} | Messages: ${conv.messageCount}\n`;
    output += `   Updated: ${conv.updatedAt}\n\n`;
  }

  return success(output);
}

/**
 * Clear a conversation
 */
async function handleGeminiClearConversation(args, context) {
  const { conversation_id } = args;
  const { getConversationManager } = context;

  const conversationManager = getConversationManager();
  const cleared = conversationManager.clearConversation(conversation_id);

  if (cleared) {
    return success(`Conversation ${conversation_id} cleared successfully.`);
  } else {
    return error(`Conversation ${conversation_id} not found.`);
  }
}

/**
 * Get conversation statistics
 */
async function handleGeminiConversationStats(args, context) {
  const { conversation_id } = args;
  const { getConversationManager } = context;

  const conversationManager = getConversationManager();

  if (conversation_id) {
    const stats = conversationManager.getConversationStats(conversation_id);
    if (!stats) {
      return error(`Conversation ${conversation_id} not found.`);
    }

    return success(`# Conversation Stats: ${stats.title}

**ID:** ${stats.id}
**State:** ${stats.state}
**Model:** ${stats.model}

## Usage
- Messages: ${stats.stats.messageCount}
- User messages: ${stats.stats.userMessages}
- Assistant messages: ${stats.stats.assistantMessages}
- Estimated tokens: ${stats.stats.estimatedTokens}
- Token usage: ${stats.tokenUsagePercent.toFixed(1)}%
- Message usage: ${stats.messageUsagePercent.toFixed(1)}%

## Timestamps
- Created: ${stats.metadata.createdAt}
- Updated: ${stats.metadata.updatedAt}`);
  } else {
    const globalStats = conversationManager.getGlobalStats();

    return success(`# Global Conversation Stats

## Overview
- Total conversations: ${globalStats.totalConversations}
- Active conversations: ${globalStats.activeConversations}
- Total messages: ${globalStats.totalMessages}
- Estimated total tokens: ${globalStats.totalTokensEstimated}

## Limits
- Max messages per conversation: ${globalStats.config.maxMessages}
- Max tokens per conversation: ${globalStats.config.maxTotalTokens}
- Conversation expiration: ${globalStats.config.expirationMs / 1000 / 60 / 60}h`);
  }
}

/**
 * Export handlers map
 */
export const handlers = {
  gemini_start_conversation: handleGeminiStartConversation,
  gemini_continue_conversation: handleGeminiContinueConversation,
  gemini_list_conversations: handleGeminiListConversations,
  gemini_clear_conversation: handleGeminiClearConversation,
  gemini_conversation_stats: handleGeminiConversationStats,
};

export default handlers;
