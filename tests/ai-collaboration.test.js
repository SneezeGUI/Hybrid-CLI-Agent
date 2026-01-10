/**
 * Tests for AI Collaboration Engine
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import AICollaborationEngine, { 
  CollaborationMode, 
  DebateStyle, 
  ConsensusMethod 
} from '../src/services/ai-collaboration.js';

describe('AICollaborationEngine', () => {
  let engine;
  let mockGemini;
  let mockOpenRouter;

  beforeEach(() => {
    // Mock Gemini Adapter
    mockGemini = {
      runSync: async (prompt, opts) => {
        // Simulate error for specific prompts if needed
        if (prompt.includes('FAIL_GEMINI')) {
          throw new Error('Gemini execution failed');
        }
        return `Gemini response for ${opts.model || 'default'}: ${prompt.substring(0, 20)}...`;
      }
    };

    // Mock OpenRouter Client
    mockOpenRouter = {
      chat: async ({ model, prompt }) => {
        if (prompt.includes('FAIL_OPENROUTER')) {
          throw new Error('OpenRouter failed');
        }
        return { 
          content: `OpenRouter response for ${model}: ${prompt.substring(0, 20)}...` 
        };
      }
    };

    engine = new AICollaborationEngine();
    // Inject mocks
    engine.gemini = mockGemini;
    engine.openrouter = mockOpenRouter;
  });

  describe('Constructor & Configuration', () => {
    it('should initialize with default configuration', () => {
      assert.ok(engine.gemini);
      assert.ok(engine.openrouter);
      assert.ok(engine.defaultModels[CollaborationMode.DEBATE]);
      assert.ok(engine.defaultModels[CollaborationMode.SEQUENTIAL]);
      assert.ok(engine.defaultModels[CollaborationMode.VALIDATION]);
    });

    it('should initialize with custom configuration', () => {
      const customConfig = {
        gemini: { key: 'test' },
        openrouter: { apiKey: 'test' }
      };
      const customEngine = new AICollaborationEngine(customConfig);
      assert.ok(customEngine);
    });
  });

  describe('Model Selection', () => {
    it('should identify Gemini models correctly', () => {
      assert.strictEqual(engine.isGeminiModel('gemini-2.5-flash'), true);
      assert.strictEqual(engine.isGeminiModel('google/gemini-pro'), true);
      assert.strictEqual(engine.isGeminiModel('openai/gpt-4'), false);
    });

    it('should parse model string into array', () => {
      const models = engine.parseModels('model1, model2, model3');
      assert.deepStrictEqual(models, ['model1', 'model2', 'model3']);
    });

    it('should return array if already array', () => {
      const models = ['model1', 'model2'];
      assert.deepStrictEqual(engine.parseModels(models), models);
    });

    it('should route to correct provider in sendToModel', async () => {
      // Test Gemini routing
      const geminiResponse = await engine.sendToModel('gemini-2.5-flash', 'test prompt');
      assert.match(geminiResponse, /Gemini response/);

      // Test OpenRouter routing
      const openRouterResponse = await engine.sendToModel('openai/gpt-4', 'test prompt');
      assert.match(openRouterResponse, /OpenRouter response/);
    });
  });

  describe('Debate Mode', () => {
    it('should run a constructive debate with defaults', async () => {
      const result = await engine.collaborate({
        mode: CollaborationMode.DEBATE,
        content: 'Should we use microservices?',
        models: ['gemini-2.5-flash', 'openai/gpt-4']
      });

      assert.strictEqual(result.mode, CollaborationMode.DEBATE);
      assert.strictEqual(result.style, DebateStyle.CONSTRUCTIVE);
      assert.strictEqual(result.participants.length, 2);
      assert.ok(result.history.length > 0);
      assert.ok(result.synthesis);
    });

    it('should support different debate styles', async () => {
      const styles = [
        DebateStyle.ADVERSARIAL,
        DebateStyle.SOCRATIC,
        DebateStyle.DEVIL_ADVOCATE
      ];

      for (const style of styles) {
        const result = await engine.collaborate({
          mode: CollaborationMode.DEBATE,
          debateStyle: style,
          content: 'Topic',
          rounds: 1,
          models: ['gemini-2.5-flash']
        });
        assert.strictEqual(result.style, style);
      }
    });

    it('should handle errors in debate rounds gracefully', async () => {
      // Force error by using special prompt trigger in mock
      const result = await engine.collaborate({
        mode: CollaborationMode.DEBATE,
        content: 'FAIL_GEMINI',
        models: ['gemini-2.5-flash'],
        rounds: 1
      });

      // Should still return a result object, but history should contain errors
      assert.strictEqual(result.mode, CollaborationMode.DEBATE);
      const errorEntry = result.history.find(h => h.error);
      assert.ok(errorEntry);
      assert.match(errorEntry.error, /Gemini execution failed/);
    });
  });

  describe('Validation Mode', () => {
    it('should run validation and calculate consensus', async () => {
      const result = await engine.collaborate({
        mode: CollaborationMode.VALIDATION,
        content: 'Code to validate',
        models: ['gemini-2.5-flash', 'openai/gpt-4']
      });

      assert.strictEqual(result.mode, CollaborationMode.VALIDATION);
      assert.strictEqual(result.validations.length, 2);
      assert.ok(result.consensus);
      assert.ok(result.consensus.reached); // Both mocks succeed
    });

    it('should support different consensus methods', async () => {
      const result = await engine.collaborate({
        mode: CollaborationMode.VALIDATION,
        content: 'Code',
        consensusMethod: ConsensusMethod.UNANIMOUS,
        models: ['gemini-2.5-flash', 'openai/gpt-4']
      });

      assert.strictEqual(result.method, ConsensusMethod.UNANIMOUS);
      assert.strictEqual(result.consensus.reached, true);
    });

    it('should fail consensus when errors occur', async () => {
      // One succeeds, one fails
      mockGemini.runSync = async () => { throw new Error('Fail'); };
      
      const result = await engine.collaborate({
        mode: CollaborationMode.VALIDATION,
        content: 'Code',
        consensusMethod: ConsensusMethod.UNANIMOUS,
        models: ['gemini-2.5-flash', 'openai/gpt-4'] // One fails, one succeeds
      });

      assert.strictEqual(result.consensus.reached, false);
      assert.strictEqual(result.validations.find(v => v.error) !== undefined, true);
    });
  });

  describe('Sequential Mode', () => {
    it('should run sequential pipeline stages', async () => {
      const result = await engine.collaborate({
        mode: CollaborationMode.SEQUENTIAL,
        content: 'Initial content',
        pipelineStages: ['stage1', 'stage2'],
        models: ['gemini-2.5-flash']
      });

      assert.strictEqual(result.mode, CollaborationMode.SEQUENTIAL);
      assert.strictEqual(result.stages.length, 2);
      assert.strictEqual(result.stages[0].stage, 'stage1');
      assert.strictEqual(result.stages[1].stage, 'stage2');
      assert.ok(result.finalOutput);
      assert.ok(result.summary);
    });

    it('should pass outputs between stages', async () => {
      const result = await engine.collaborate({
        mode: CollaborationMode.SEQUENTIAL,
        content: 'Start',
        pipelineStages: ['step1', 'step2'],
        models: ['gemini-2.5-flash']
      });

      // The final output should be the result of the last stage
      assert.match(result.finalOutput, /Gemini response/);
      assert.strictEqual(result.summary.successfulStages, 2);
    });

    it('should handle stage errors', async () => {
      const result = await engine.collaborate({
        mode: CollaborationMode.SEQUENTIAL,
        content: 'FAIL_GEMINI',
        pipelineStages: ['stage1'],
        models: ['gemini-2.5-flash']
      });

      assert.strictEqual(result.summary.failedStages, 1);
      assert.ok(result.stages[0].error);
    });
  });

  describe('Default Behavior', () => {
    it('should default to DEBATE mode if not specified', async () => {
      const result = await engine.collaborate({
        content: 'Topic'
      });
      assert.strictEqual(result.mode, CollaborationMode.DEBATE);
    });

    it('should use default models if none provided', async () => {
      // Mock sendToModel to capture which model was used
      const modelsUsed = new Set();
      engine.sendToModel = async (model) => {
        modelsUsed.add(model);
        return 'response';
      };

      await engine.collaborate({
        mode: CollaborationMode.DEBATE,
        content: 'Topic',
        rounds: 1
      });

      // Check that default models were used
      const defaults = engine.defaultModels[CollaborationMode.DEBATE];
      assert.ok(defaults.length > 0);
      assert.ok(modelsUsed.size > 0);
    });
  });
});
