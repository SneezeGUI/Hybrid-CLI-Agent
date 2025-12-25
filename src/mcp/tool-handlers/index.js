/**
 * Tool Handlers Index
 *
 * Central registry for all MCP tool handlers.
 * Each category exports its handlers which are collected here.
 *
 * Categories:
 * - core: gemini_auth_status, gemini_prompt, ask_gemini
 * - research: research_heavy_context, summarize_directory, gemini_eval_plan, gemini_verify_solution
 * - code: draft_code_implementation, review_code_changes, gemini_code_review, gemini_git_diff_review
 * - collaboration: ai_collaboration, cross_model_comparison
 * - openrouter: openrouter_chat, openrouter_models, openrouter_usage_stats
 * - conversations: gemini_start_conversation, gemini_continue_conversation, gemini_list_conversations, gemini_clear_conversation, gemini_conversation_stats
 * - content: gemini_content_comparison, gemini_extract_structured, gemini_summarize_files
 * - system: hybrid_metrics, gemini_config_show, gemini_cache_manage
 * - agent: gemini_agent_task, gemini_agent_list, gemini_agent_clear
 *
 * Each handler is an async function with signature:
 *   async function handler(args, context) => { content: [...], isError?: boolean }
 *
 * Context provides access to shared utilities:
 * - runGeminiCli: Execute Gemini CLI commands
 * - processPrompt: Process @filename references
 * - hasFileReferences: Check if prompt has file refs
 * - getSmartModel: Get optimal model for task
 * - responseCache: Cache manager
 * - conversationManager: Conversation state
 */

// Import handler categories
import { handlers as coreHandlers } from './core/index.js';
import { handlers as researchHandlers } from './research/index.js';
import { handlers as codeHandlers } from './code/index.js';
import { handlers as collaborationHandlers } from './collaboration/index.js';
import { handlers as openrouterHandlers } from './openrouter/index.js';
import { handlers as conversationHandlers } from './conversations/index.js';
import { handlers as contentHandlers } from './content/index.js';
import { handlers as systemHandlers } from './system/index.js';
import { handlers as agentHandlers } from './agent/index.js';

/**
 * Combined handler map for all tools (30 total)
 */
export const toolHandlers = {
  ...coreHandlers,           // 3 tools
  ...researchHandlers,       // 4 tools
  ...codeHandlers,           // 4 tools
  ...collaborationHandlers,  // 2 tools
  ...openrouterHandlers,     // 3 tools
  ...conversationHandlers,   // 5 tools
  ...contentHandlers,        // 3 tools
  ...systemHandlers,         // 3 tools
  ...agentHandlers,          // 3 tools
};

/**
 * Execute a tool by name
 * @param {string} toolName - The tool to execute
 * @param {Object} args - Tool arguments
 * @param {Object} context - Shared context/utilities
 * @returns {Promise<Object>} - MCP response object
 */
export async function executeToolHandler(toolName, args, context) {
  const handler = toolHandlers[toolName];

  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  try {
    return await handler(args, context);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error in ${toolName}: ${error.message}` }],
      isError: true,
    };
  }
}

/**
 * Check if a tool exists
 */
export function hasToolHandler(toolName) {
  return toolName in toolHandlers;
}

/**
 * Get list of all tool names
 */
export function getToolNames() {
  return Object.keys(toolHandlers);
}

export default {
  toolHandlers,
  executeToolHandler,
  hasToolHandler,
  getToolNames,
};
