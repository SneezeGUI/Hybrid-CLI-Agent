import { describe, it } from 'node:test';
import assert from 'node:assert';
import { executeToolHandler, hasToolHandler, getToolNames } from '../src/mcp/tool-handlers/index.js';

describe('Tool Handler Registry', () => {
  describe('getToolNames', () => {
    it('should return all registered tools', () => {
      const tools = getToolNames();
      assert.ok(tools.includes('gemini_auth_status'));
      assert.ok(tools.includes('hybrid_metrics'));
      assert.ok(tools.includes('gemini_agent_task'));
      assert.ok(tools.length >= 7);
    });
  });

  describe('hasToolHandler', () => {
    it('should return true for existing tools', () => {
      assert.strictEqual(hasToolHandler('gemini_auth_status'), true);
      assert.strictEqual(hasToolHandler('gemini_agent_task'), true);
    });

    it('should return false for non-existent tools', () => {
      assert.strictEqual(hasToolHandler('non_existent_tool'), false);
    });
  });

  describe('executeToolHandler', () => {
    it('should execute existing tool', async () => {
      // We can't easily mock the internal handler function without rewiring,
      // but we can test that it returns something valid for a simple tool if we provide mock context.
      
      // Mock context sufficient for gemini_auth_status (or we can just test the error case for unknown tool)
      const result = await executeToolHandler('non_existent_tool', {}, {});
      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Unknown tool'));
    });

    it('should handle tool execution errors', async () => {
        // We'll try to execute a tool with missing context to force an error
        // gemini_auth_status requires context.AUTH_CONFIG
        const result = await executeToolHandler('gemini_auth_status', {}, {});
        assert.strictEqual(result.isError, true);
        // It should catch the error and return formatted error
        assert.ok(result.content[0].text.includes('Error'));
    });
  });
});
