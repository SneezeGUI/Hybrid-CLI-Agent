/**
 * Hybrid Agent Orchestrator
 * 
 * Manages the Claude (Supervisor) ↔ Gemini (Worker) relationship.
 * 
 * Key patterns:
 * 1. Task Classification - Route to cheapest capable model
 * 2. Context Arbitrage - Gemini reads, Claude thinks
 * 3. Supervisor Loop - Claude reviews Gemini's output
 * 4. Cost Optimization - Track and minimize spend
 */

import { randomUUID } from 'crypto';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { GeminiCliAdapter } from '../adapters/gemini-cli.js';

// Task complexity classification
const TaskComplexity = {
  TRIVIAL: 'trivial',      // Simple questions → Gemini Flash
  STANDARD: 'standard',    // Normal tasks → Gemini Pro  
  COMPLEX: 'complex',      // Reasoning-heavy → Claude Sonnet
  CRITICAL: 'critical',    // Production code → Claude + Review
};

// Task type classification
const TaskType = {
  READ_ANALYZE: 'read_analyze',     // Heavy context reading
  DRAFT_CODE: 'draft_code',         // Initial code generation
  REVIEW_CODE: 'review_code',       // Code review
  FIX_BUG: 'fix_bug',              // Bug fixes
  REFACTOR: 'refactor',            // Code restructuring
  QUESTION: 'question',            // General questions
  ARCHITECTURE: 'architecture',     // Design decisions
};

export class Orchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workDir = options.workDir || process.cwd();
    this.contextFile = options.contextFile || 'HYBRID_CONTEXT.md';

    // Initialize adapters (allow injection for testing)
    this.claude = options.claudeAdapter || new ClaudeCodeAdapter(options.claude || {});
    this.gemini = options.geminiAdapter || new GeminiCliAdapter(options.gemini || {});
    
    // Session tracking
    this.sessions = new Map();
    this.costTracker = {
      claude: { inputTokens: 0, outputTokens: 0, cost: 0 },
      gemini: { inputTokens: 0, outputTokens: 0, cost: 0 },
    };
    
    // Orchestration config
    this.config = {
      // Thresholds for routing decisions
      complexityThreshold: {
        trivial: 100,    // < 100 tokens input → trivial
        standard: 5000,  // < 5000 tokens → standard
        complex: 50000,  // < 50000 tokens → complex (still Gemini)
        // > 50000 → critical, needs review
      },
      // When to have Claude review Gemini's work
      requiresReview: [TaskType.DRAFT_CODE, TaskType.FIX_BUG, TaskType.REFACTOR],
      // Maximum retries for correction loop
      maxCorrectionRetries: 3,
    };
  }

  /**
   * Classify task complexity based on input characteristics
   */
  classifyComplexity(task, inputLength) {
    // Explicit complexity hints in task
    if (task.match(/\b(simple|quick|brief)\b/i)) return TaskComplexity.TRIVIAL;
    if (task.match(/\b(complex|critical|production|careful)\b/i)) return TaskComplexity.CRITICAL;
    
    // Based on input size
    const { complexityThreshold } = this.config;
    if (inputLength < complexityThreshold.trivial) return TaskComplexity.TRIVIAL;
    if (inputLength < complexityThreshold.standard) return TaskComplexity.STANDARD;
    if (inputLength < complexityThreshold.complex) return TaskComplexity.COMPLEX;
    return TaskComplexity.CRITICAL;
  }

  /**
   * Classify task type based on keywords
   */
  classifyTaskType(task) {
    const lower = task.toLowerCase();
    
    if (lower.match(/\b(read|analyze|understand|explain|summarize|find)\b/)) {
      return TaskType.READ_ANALYZE;
    }
    if (lower.match(/\b(write|create|implement|build|generate)\b/)) {
      return TaskType.DRAFT_CODE;
    }
    if (lower.match(/\b(review|check|audit|inspect)\b/)) {
      return TaskType.REVIEW_CODE;
    }
    if (lower.match(/\b(fix|debug|resolve|repair)\b/)) {
      return TaskType.FIX_BUG;
    }
    if (lower.match(/\b(refactor|restructure|clean|improve)\b/)) {
      return TaskType.REFACTOR;
    }
    if (lower.match(/\b(design|architect|plan|structure)\b/)) {
      return TaskType.ARCHITECTURE;
    }
    
    return TaskType.QUESTION;
  }

  /**
   * Select the best model for a task
   */
  selectModel(taskType, complexity) {
    // Read/analyze tasks → Always Gemini (context arbitrage)
    if (taskType === TaskType.READ_ANALYZE) {
      return complexity === TaskComplexity.TRIVIAL 
        ? { adapter: 'gemini', model: 'gemini-2.5-flash' }
        : { adapter: 'gemini', model: 'gemini-2.5-pro' };
    }

    // Questions → Gemini unless critical
    if (taskType === TaskType.QUESTION) {
      return complexity === TaskComplexity.CRITICAL
        ? { adapter: 'claude', model: 'claude-sonnet-4-5-20250514' }
        : { adapter: 'gemini', model: 'gemini-2.5-pro' };
    }

    // Code tasks → Depends on complexity
    if ([TaskType.DRAFT_CODE, TaskType.FIX_BUG, TaskType.REFACTOR].includes(taskType)) {
      switch (complexity) {
        case TaskComplexity.TRIVIAL:
        case TaskComplexity.STANDARD:
          return { adapter: 'gemini', model: 'gemini-2.5-pro', requiresReview: true };
        case TaskComplexity.COMPLEX:
          return { adapter: 'gemini', model: 'gemini-3-pro-preview', requiresReview: true };
        case TaskComplexity.CRITICAL:
          return { adapter: 'claude', model: 'claude-sonnet-4-5-20250514' };
      }
    }

    // Architecture → Claude (needs reasoning)
    if (taskType === TaskType.ARCHITECTURE) {
      return { adapter: 'claude', model: 'claude-sonnet-4-5-20250514' };
    }

    // Default → Gemini Pro
    return { adapter: 'gemini', model: 'gemini-2.5-pro' };
  }

  /**
   * Execute a task with automatic routing
   */
  async execute(task, options = {}) {
    const sessionId = options.sessionId || randomUUID();
    const inputLength = task.length + (options.contextLength || 0);
    
    // Classify the task
    const taskType = this.classifyTaskType(task);
    const complexity = this.classifyComplexity(task, inputLength);
    const routing = this.selectModel(taskType, complexity);
    
    this.emit('progress', {
      stage: 'routing',
      message: `Routing to ${routing.adapter}`,
      details: { taskType, complexity, adapter: routing.adapter, model: routing.model }
    });
    
    // Store session info
    this.sessions.set(sessionId, {
      id: sessionId,
      task,
      taskType,
      complexity,
      routing,
      status: 'running',
      startedAt: new Date().toISOString(),
      steps: [],
    });

    try {
      let result;
      
      // Execute on selected adapter
      const adapter = routing.adapter === 'claude' ? this.claude : this.gemini;
      await adapter.spawn(sessionId, { model: routing.model, workDir: this.workDir });

      this.emit('progress', {
        stage: 'executing',
        message: `${routing.adapter} is working...`,
        details: { adapter: routing.adapter, model: routing.model }
      });

      const response = await adapter.sendAndWait(sessionId, task, options);
      result = response.text;
      
      // Track costs
      this.trackCost(routing.adapter, response.metadata);
      
      // Update session
      const session = this.sessions.get(sessionId);
      session.steps.push({
        agent: routing.adapter,
        model: routing.model,
        input: task.slice(0, 200) + '...',
        output: result.slice(0, 500) + '...',
        tokens: response.metadata,
      });

      // Review loop if needed
      if (routing.requiresReview && taskType !== TaskType.READ_ANALYZE) {
        result = await this.reviewAndCorrect(sessionId, task, result, options);
      }

      session.status = 'complete';
      session.result = result;
      session.completedAt = new Date().toISOString();

      this.emit('progress', {
        stage: 'complete',
        message: 'Task completed',
        details: { stepsCount: session.steps.length }
      });

      // Persist context
      await this.persistContext(sessionId);

      // Return result with session summary for CLI display
      return {
        sessionId,
        result,
        routing,
        cost: this.getSessionCost(sessionId),
        steps: session.steps,
        summary: {
          taskType,
          complexity,
          stepsCount: session.steps.length,
          reviewIterations: session.steps.filter(s => s.type === 'review').length,
          correctionIterations: session.steps.filter(s => s.type === 'correction').length,
          modelsUsed: [...new Set(session.steps.map(s => s.model))],
          approved: session.steps.some(s => s.type === 'review' && s.output?.includes('APPROVED'))
        }
      };
      
    } catch (error) {
      const session = this.sessions.get(sessionId);
      session.status = 'error';
      session.error = error.message;
      throw error;
    }
  }

  /**
   * Have Claude review and potentially correct Gemini's output
   */
  async reviewAndCorrect(sessionId, originalTask, geminiOutput, options = {}) {
    const session = this.sessions.get(sessionId);
    let currentOutput = geminiOutput;
    let attempts = 0;
    
    while (attempts < this.config.maxCorrectionRetries) {
      attempts++;
      
      // Create review prompt for Claude
      const reviewPrompt = `You are reviewing work done by a junior developer (Gemini).

ORIGINAL TASK:
${originalTask}

PROPOSED SOLUTION:
${currentOutput}

Your job:
1. Check for bugs, security issues, or logic errors
2. Verify it meets the requirements
3. Check code style and best practices

If the solution is GOOD:
- Respond with: APPROVED
- Optionally add minor polish

If the solution has ISSUES:
- List the specific problems
- Provide the CORRECTED version

Be concise. Focus on what matters.`;

      // Get Claude's review
      this.emit('progress', {
        stage: 'review',
        message: `Claude reviewing (attempt ${attempts})...`,
        details: { attempt: attempts }
      });

      await this.claude.spawn(`${sessionId}-review-${attempts}`, {
        model: 'claude-sonnet-4-5-20250514',
        workDir: this.workDir,
      });

      const review = await this.claude.sendAndWait(`${sessionId}-review-${attempts}`, reviewPrompt);
      this.trackCost('claude', review.metadata);
      
      session.steps.push({
        agent: 'claude',
        model: 'claude-sonnet-4-5-20250514',
        type: 'review',
        attempt: attempts,
        input: `Review attempt ${attempts}`,
        output: review.text.slice(0, 500) + '...',
        tokens: review.metadata,
      });

      // Check if approved
      if (review.text.includes('APPROVED')) {
        this.emit('progress', {
          stage: 'review',
          message: 'Review approved',
          details: { attempt: attempts, approved: true }
        });
        // Extract any polished version if provided
        const polishedMatch = review.text.match(/APPROVED[\s\S]*?```[\w]*\n?([\s\S]*?)```/);
        if (polishedMatch) {
          return polishedMatch[1].trim();
        }
        return currentOutput;
      }

      // Extract corrected version
      this.emit('progress', {
        stage: 'review',
        message: 'Corrections needed',
        details: { attempt: attempts, approved: false }
      });
      const correctedMatch = review.text.match(/```[\w]*\n?([\s\S]*?)```/);
      if (correctedMatch) {
        currentOutput = correctedMatch[1].trim();
      } else {
        // No code block, Claude might have given text feedback
        // Send back to Gemini for correction
        this.emit('progress', {
          stage: 'correction',
          message: `Gemini correcting (attempt ${attempts})...`,
          details: { attempt: attempts }
        });

        const correctionPrompt = `The senior engineer reviewed your work and found issues:

${review.text}

Original task: ${originalTask}

Please provide a corrected version addressing ALL the feedback.`;

        await this.gemini.spawn(`${sessionId}-correct-${attempts}`, {
          model: 'gemini-2.5-pro',
          workDir: this.workDir,
        });
        
        const correction = await this.gemini.sendAndWait(`${sessionId}-correct-${attempts}`, correctionPrompt);
        this.trackCost('gemini', correction.metadata);
        
        session.steps.push({
          agent: 'gemini',
          model: 'gemini-2.5-pro',
          type: 'correction',
          attempt: attempts,
          output: correction.text.slice(0, 500) + '...',
          tokens: correction.metadata,
        });
        
        currentOutput = correction.text;
      }
    }

    this.emit('progress', {
      stage: 'review',
      message: 'Max corrections reached',
      details: { maxAttempts: this.config.maxCorrectionRetries }
    });
    return currentOutput;
  }

  /**
   * Track costs for an adapter
   */
  trackCost(adapterName, metadata = {}) {
    const tracker = this.costTracker[adapterName];
    if (!tracker) return;
    
    tracker.inputTokens += metadata.inputTokens || 0;
    tracker.outputTokens += metadata.outputTokens || 0;
    
    // Calculate cost
    const adapter = adapterName === 'claude' ? this.claude : this.gemini;
    tracker.cost += adapter.estimateCost(
      metadata.inputTokens || 0,
      metadata.outputTokens || 0
    );
  }

  /**
   * Get cost for a specific session
   */
  getSessionCost(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    let cost = 0;
    for (const step of session.steps) {
      const adapter = step.agent === 'claude' ? this.claude : this.gemini;
      cost += adapter.estimateCost(
        step.tokens?.inputTokens || 0,
        step.tokens?.outputTokens || 0,
        step.model
      );
    }
    return cost;
  }

  /**
   * Get total costs across all sessions
   */
  getTotalCosts() {
    return {
      claude: { ...this.costTracker.claude },
      gemini: { ...this.costTracker.gemini },
      total: this.costTracker.claude.cost + this.costTracker.gemini.cost,
    };
  }

  /**
   * Persist context to HYBRID_CONTEXT.md for recovery
   */
  async persistContext(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    const contextPath = join(this.workDir, this.contextFile);
    
    const content = `# Hybrid Agent Context
<!-- Recovery header: If you're Claude and see this after context compaction, 
     the user was in the middle of a hybrid task. Review the status below. -->

## Current Session: ${sessionId}

**Status:** ${session.status}
**Task Type:** ${session.taskType}
**Complexity:** ${session.complexity}
**Started:** ${session.startedAt}
${session.completedAt ? `**Completed:** ${session.completedAt}` : ''}

### Original Task
\`\`\`
${session.task}
\`\`\`

### Execution Steps
${session.steps.map((step, i) => `
${i + 1}. **${step.agent}** (${step.model})${step.type ? ` - ${step.type}` : ''}
   - Tokens: ${step.tokens?.inputTokens || 0} in / ${step.tokens?.outputTokens || 0} out
`).join('')}

### Result
${session.result ? `\`\`\`\n${session.result.slice(0, 2000)}${session.result.length > 2000 ? '\n...(truncated)' : ''}\n\`\`\`` : 'In progress...'}

### Cost Summary
- Claude: $${this.costTracker.claude.cost.toFixed(4)}
- Gemini: $${this.costTracker.gemini.cost.toFixed(4)} (likely FREE with CLI)
- Total: $${(this.costTracker.claude.cost + this.costTracker.gemini.cost).toFixed(4)}
`;

    await writeFile(contextPath, content, 'utf-8');
  }

  /**
   * Load context from HYBRID_CONTEXT.md if it exists
   */
  async loadContext() {
    try {
      const contextPath = join(this.workDir, this.contextFile);
      const content = await readFile(contextPath, 'utf-8');
      // Parse and restore session state if needed
      return content;
    } catch {
      return null;
    }
  }
}

export default Orchestrator;
