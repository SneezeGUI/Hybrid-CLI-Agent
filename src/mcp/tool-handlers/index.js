/**
 * Tool Handlers Index
 *
 * Central registry for all MCP tool handlers.
 *
 * Categories:
 * - core: gemini_auth_status
 * - system: hybrid_metrics, gemini_config_show, gemini_health_check
 * - agent: gemini_agent_task, gemini_agent_list, gemini_agent_clear
 *
 * Each handler is an async function with signature:
 *   async function handler(args, context) => { content: [...], isError?: boolean }
 *
 * Context provides access to shared utilities:
 * - runGeminiCli: Execute Gemini CLI commands
 * - safeSpawn: Safe process spawning
 * - buildEnv: Build environment variables
 * - AUTH_CONFIG: Authentication configuration
 * - getActiveAuthMethod: Get current auth method
 * - getDefaultModel: Get default model
 */

// Import handler categories
import { handlers as coreHandlers } from './core/index.js';
import { handlers as systemHandlers } from './system/index.js';
import { handlers as agentHandlers } from './agent/index.js';

/**
 * Combined handler map for all tools (7 total)
 */
export const toolHandlers = {
  ...coreHandlers,   // 1 tool: gemini_auth_status
  ...systemHandlers, // 3 tools: hybrid_metrics, gemini_config_show, gemini_health_check
  ...agentHandlers,  // 3 tools: gemini_agent_task, gemini_agent_list, gemini_agent_clear
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
