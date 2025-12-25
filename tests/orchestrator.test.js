/**
 * Unit tests for the Orchestrator
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, readFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import Orchestrator from '../src/orchestrator/index.js';

// Mock Adapter Class
class MockAdapter {
  constructor(name, costPerToken = 0.0001) {
    this.name = name;
    this.costPerToken = costPerToken;
    this.calls = [];
    this.responseQueue = [];
    this.defaultResponse = { 
      text: 'Mock response', 
      metadata: { inputTokens: 10, outputTokens: 10 } 
    };
  }

  async spawn(sessionId, options) {
    this.calls.push({ method: 'spawn', sessionId, options });
    return Promise.resolve();
  }

  async sendAndWait(sessionId, message, options) {
    this.calls.push({ method: 'sendAndWait', sessionId, message, options });
    const next = this.responseQueue.shift() || this.defaultResponse;
    return Promise.resolve(next);
  }

  estimateCost(inputTokens, outputTokens) {
    return (inputTokens + outputTokens) * this.costPerToken;
  }

  // Test helper to queue specific responses
  queueResponse(text, metadata = { inputTokens: 10, outputTokens: 10 }) {
    this.responseQueue.push({ text, metadata });
  }
}

describe('Orchestrator', () => {
  let orchestrator;
  let workDir;
  let mockClaude;
  let mockGemini;

  beforeEach(async () => {
    // Create temp directory for each test
    workDir = await mkdtemp(join(tmpdir(), 'orchestrator-test-'));
    
    mockClaude = new MockAdapter('claude');
    mockGemini = new MockAdapter('gemini');

    orchestrator = new Orchestrator({
      workDir,
      claudeAdapter: mockClaude,
      geminiAdapter: mockGemini
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(workDir, { recursive: true, force: true });
  });

  describe('Task Classification', () => {
    describe('classifyComplexity', () => {
      it('should identify trivial tasks by keyword', () => {
        const result = orchestrator.classifyComplexity('Just a simple quick check', 1000);
        assert.strictEqual(result, 'trivial');
      });

      it('should identify critical tasks by keyword', () => {
        const result = orchestrator.classifyComplexity('This is for production environment', 100);
        assert.strictEqual(result, 'critical');
      });

      it('should classify based on input length', () => {
        const { complexityThreshold } = orchestrator.config;
        
        assert.strictEqual(
          orchestrator.classifyComplexity('task', complexityThreshold.trivial - 1), 
          'trivial'
        );
        assert.strictEqual(
          orchestrator.classifyComplexity('task', complexityThreshold.standard - 1), 
          'standard'
        );
        assert.strictEqual(
          orchestrator.classifyComplexity('task', complexityThreshold.complex - 1), 
          'complex'
        );
        assert.strictEqual(
          orchestrator.classifyComplexity('task', complexityThreshold.complex + 1), 
          'critical'
        );
      });
    });

    describe('classifyTaskType', () => {
      it('should classify read/analyze tasks', () => {
        assert.strictEqual(orchestrator.classifyTaskType('Read this file'), 'read_analyze');
        assert.strictEqual(orchestrator.classifyTaskType('Summarize content'), 'read_analyze');
      });

      it('should classify coding tasks', () => {
        assert.strictEqual(orchestrator.classifyTaskType('Write a function'), 'draft_code');
        assert.strictEqual(orchestrator.classifyTaskType('Create a class'), 'draft_code');
      });

      it('should classify fix/bug tasks', () => {
        assert.strictEqual(orchestrator.classifyTaskType('Fix this bug'), 'fix_bug');
        assert.strictEqual(orchestrator.classifyTaskType('Debug the error'), 'fix_bug');
      });

      it('should classify architecture tasks', () => {
        assert.strictEqual(orchestrator.classifyTaskType('Design the system'), 'architecture');
      });

      it('should default to question', () => {
        assert.strictEqual(orchestrator.classifyTaskType('What time is it?'), 'question');
      });
    });
  });

  describe('Model Selection', () => {
    it('should select Gemini for read_analyze tasks regardless of complexity', () => {
      const routing1 = orchestrator.selectModel('read_analyze', 'trivial');
      assert.strictEqual(routing1.adapter, 'gemini');
      assert.strictEqual(routing1.model, 'gemini-2.5-flash');

      const routing2 = orchestrator.selectModel('read_analyze', 'critical');
      assert.strictEqual(routing2.adapter, 'gemini');
      assert.strictEqual(routing2.model, 'gemini-2.5-pro');
    });

    it('should select Claude for critical questions', () => {
      const routing = orchestrator.selectModel('question', 'critical');
      assert.strictEqual(routing.adapter, 'claude');
    });

    it('should select Gemini with review for standard coding tasks', () => {
      const routing = orchestrator.selectModel('draft_code', 'standard');
      assert.strictEqual(routing.adapter, 'gemini');
      assert.strictEqual(routing.requiresReview, true);
    });

    it('should select Claude for architecture tasks', () => {
      const routing = orchestrator.selectModel('architecture', 'standard');
      assert.strictEqual(routing.adapter, 'claude');
    });

    it('should select Claude for critical coding tasks without external review loop', () => {
      // Critical coding goes directly to Claude, assuming Claude is capable enough 
      // or that the orchestrator design implies Claude doesn't review itself in the same loop
      const routing = orchestrator.selectModel('draft_code', 'critical');
      assert.strictEqual(routing.adapter, 'claude');
      assert.ok(!routing.requiresReview);
    });
  });

  describe('Execution Flow', () => {
    it('should execute a simple task with Gemini', async () => {
      mockGemini.queueResponse('Gemini result');
      
      const result = await orchestrator.execute('Simple question');
      
      assert.strictEqual(result.routing.adapter, 'gemini');
      assert.strictEqual(result.result, 'Gemini result');
      assert.strictEqual(mockGemini.calls.length, 2); // spawn + sendAndWait
      assert.strictEqual(mockClaude.calls.length, 0);
    });

    it('should execute an architecture task with Claude', async () => {
      mockClaude.queueResponse('Architecture plan');
      
      const result = await orchestrator.execute('Design a system architecture');
      
      assert.strictEqual(result.routing.adapter, 'claude');
      assert.strictEqual(result.result, 'Architecture plan');
      assert.strictEqual(mockClaude.calls.length, 2);
      assert.strictEqual(mockGemini.calls.length, 0);
    });

    it('should emit progress events', async () => {
      const events = [];
      orchestrator.on('progress', (e) => events.push(e));
      
      await orchestrator.execute('Simple task');
      
      assert.ok(events.find(e => e.stage === 'routing'));
      assert.ok(events.find(e => e.stage === 'executing'));
      assert.ok(events.find(e => e.stage === 'complete'));
    });
    
    it('should handle errors during execution', async () => {
      mockGemini.sendAndWait = async () => { throw new Error('Gemini failed'); };
      
      await assert.rejects(
        orchestrator.execute('Simple task'),
        /Gemini failed/
      );
      
      // Verify session status is error (accessible via internal map if needed, or subsequent checks)
      // Since sessions are internal, we infer state or check side effects if possible.
      // Here we rely on the throw.
    });
  });

  describe('Review Loop', () => {
    it('should return result immediately if approved by Claude', async () => {
      const task = 'Write code';
      
      // Gemini drafts code
      mockGemini.queueResponse('const x = 1;');
      
      // Claude reviews and approves
      mockClaude.queueResponse('Looks good. APPROVED');
      
      const result = await orchestrator.execute(task);
      
      assert.strictEqual(result.result, 'const x = 1;');
      assert.strictEqual(mockGemini.calls.length, 2); // spawn + draft
      assert.strictEqual(mockClaude.calls.length, 2); // spawn + review
      
      // Check summary
      assert.strictEqual(result.summary.stepsCount, 2); // 1 draft + 1 review
      assert.strictEqual(result.summary.approved, true);
    });

    it('should use polished code if Claude approves with code block', async () => {
      const task = 'Write code';
      
      mockGemini.queueResponse('var x = 1;'); // Old style
      mockClaude.queueResponse('Approved with polish. APPROVED\n```js\nconst x = 1;\n```');
      
      const result = await orchestrator.execute(task);
      
      assert.strictEqual(result.result, 'const x = 1;');
    });

    it('should enter correction loop if Claude rejects', async () => {
      const task = 'Write code';
      
      // 1. Gemini drafts
      mockGemini.queueResponse('Bad code');
      
      // 2. Claude reviews -> Rejects with feedback (no APPROVED)
      mockClaude.queueResponse('There are bugs. Fix them.');
      
      // 3. Gemini corrects
      mockGemini.queueResponse('Fixed code');
      
      // 4. Claude reviews again -> Approves
      mockClaude.queueResponse('APPROVED');
      
      const result = await orchestrator.execute(task);
      
      assert.strictEqual(result.result, 'Fixed code');
      
      // Calls: 
      // Gemini: Spawn(main), Draft, Spawn(correct), Correct
      // Claude: Spawn(review1), Review1, Spawn(review2), Review2
      assert.strictEqual(mockGemini.calls.filter(c => c.method === 'sendAndWait').length, 2);
      assert.strictEqual(mockClaude.calls.filter(c => c.method === 'sendAndWait').length, 2);
      
      assert.strictEqual(result.summary.reviewIterations, 2);
      assert.strictEqual(result.summary.correctionIterations, 1);
    });

    it('should stop after max retries', async () => {
      orchestrator.config.maxCorrectionRetries = 2;
      const task = 'Write code';
      
      // Gemini drafts
      mockGemini.queueResponse('Draft 1');
      
      // Loop 1: Claude rejects -> Gemini corrects
      mockClaude.queueResponse('Bad');
      mockGemini.queueResponse('Draft 2');
      
      // Loop 2: Claude rejects -> Gemini corrects
      mockClaude.queueResponse('Still bad');
      mockGemini.queueResponse('Draft 3');
      
      // Loop 3: Should not happen, returns Draft 3 (current output)
      
      const result = await orchestrator.execute(task);
      
      assert.strictEqual(result.result, 'Draft 3');
      // Should have 2 correction attempts
      assert.strictEqual(result.summary.correctionIterations, 2);
    });
  });

  describe('Cost Tracking', () => {
    it('should track costs correctly', async () => {
      mockGemini.queueResponse('result', { inputTokens: 100, outputTokens: 50 });
      
      await orchestrator.execute('Simple task');
      
      const costs = orchestrator.getTotalCosts();
      const sessionCost = orchestrator.getSessionCost([...orchestrator.sessions.keys()][0]);
      
      const expectedCost = (100 + 50) * mockGemini.costPerToken;
      
      assert.strictEqual(costs.gemini.inputTokens, 100);
      assert.strictEqual(costs.gemini.outputTokens, 50);
      assert.ok(Math.abs(costs.gemini.cost - expectedCost) < 0.000001);
      assert.ok(Math.abs(sessionCost - expectedCost) < 0.000001);
    });

    it('should aggregate costs across multiple steps', async () => {
      // Mock flow: Gemini Draft -> Claude Review -> Gemini Correct -> Claude Review
      const task = 'Write code';
      
      // 1. Draft
      mockGemini.queueResponse('Draft', { inputTokens: 10, outputTokens: 10 });
      // 2. Review (Reject)
      mockClaude.queueResponse('Fix it', { inputTokens: 20, outputTokens: 20 });
      // 3. Correct
      mockGemini.queueResponse('Fixed', { inputTokens: 10, outputTokens: 10 });
      // 4. Review (Approve)
      mockClaude.queueResponse('APPROVED', { inputTokens: 20, outputTokens: 20 });
      
      await orchestrator.execute(task);
      
      const total = orchestrator.getTotalCosts();
      assert.strictEqual(total.gemini.inputTokens, 20); // 10 + 10
      assert.strictEqual(total.claude.inputTokens, 40); // 20 + 20
    });
  });

  describe('Context Persistence', () => {
    it('should persist session context to file', async () => {
      mockGemini.queueResponse('Result');
      
      const result = await orchestrator.execute('Task');
      
      const contextPath = join(workDir, 'HYBRID_CONTEXT.md');
      
      // Verify file exists
      await assert.doesNotReject(access(contextPath));
      
      // Verify content
      const content = await readFile(contextPath, 'utf-8');
      assert.ok(content.includes(result.sessionId));
      assert.ok(content.includes('**Status:** complete'));
      assert.ok(content.includes('Result'));
      assert.ok(content.includes('Cost Summary'));
    });

    it('should load context from file', async () => {
      const contextPath = join(workDir, 'HYBRID_CONTEXT.md');
      // Mock writing manually to simulate existing context
      await orchestrator.persistContext('fake-session-id'); // Can't do this easily as session not in map
      
      // Actually run a task to generate context
      mockGemini.queueResponse('Res');
      await orchestrator.execute('Task');
      
      // Now load it
      const content = await orchestrator.loadContext();
      assert.ok(content.includes('Hybrid Agent Context'));
    });
    
    it('should return null if no context file exists', async () => {
      const content = await orchestrator.loadContext();
      assert.strictEqual(content, null);
    });
  });
});