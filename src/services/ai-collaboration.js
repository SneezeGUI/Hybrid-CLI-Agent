/**
 * AI Collaboration Engine
 * 
 * Enables multi-model AI collaboration with different modes:
 * - Sequential: Pipeline stages with handoffs
 * - Debate: Multi-round discussions with different styles
 * - Validation: Cross-model validation with consensus methods
 * 
 * Inspired by gemini-cli-mcp-server's collaboration engine.
 */

import { GeminiCliAdapter } from '../adapters/gemini-cli.js';
import { OpenRouterClient } from './openrouter-client.js';

/**
 * Collaboration modes
 */
export const CollaborationMode = {
  SEQUENTIAL: 'sequential',
  DEBATE: 'debate',
  VALIDATION: 'validation',
};

/**
 * Debate styles
 */
export const DebateStyle = {
  CONSTRUCTIVE: 'constructive',
  ADVERSARIAL: 'adversarial',
  COLLABORATIVE: 'collaborative',
  SOCRATIC: 'socratic',
  DEVIL_ADVOCATE: 'devil_advocate',
};

/**
 * Consensus methods for validation
 */
export const ConsensusMethod = {
  SIMPLE_MAJORITY: 'simple_majority',
  WEIGHTED_MAJORITY: 'weighted_majority',
  UNANIMOUS: 'unanimous',
  SUPERMAJORITY: 'supermajority',
  EXPERT_PANEL: 'expert_panel',
};

/**
 * AI Collaboration Engine
 */
export class AICollaborationEngine {
  constructor(config = {}) {
    this.gemini = new GeminiCliAdapter(config.gemini || {});
    this.openrouter = new OpenRouterClient(config.openrouter || {});
    
    // Default model pools for different modes
    this.defaultModels = {
      [CollaborationMode.SEQUENTIAL]: ['gemini-2.5-flash', 'openai/gpt-4.1-nano', 'anthropic/claude-3-haiku'],
      [CollaborationMode.DEBATE]: ['gemini-2.5-flash', 'openai/gpt-4.1-mini', 'anthropic/claude-3-haiku'],
      [CollaborationMode.VALIDATION]: ['gemini-2.5-flash', 'openai/gpt-4.1-nano', 'anthropic/claude-3-haiku'],
    };
  }

  /**
   * Run a collaboration session
   */
  async collaborate(options = {}) {
    const {
      mode = CollaborationMode.DEBATE,
      content,
      models = [],
      context = '',
      ...modeOptions
    } = options;

    const selectedModels = models.length > 0 ? this.parseModels(models) : this.defaultModels[mode];

    switch (mode) {
      case CollaborationMode.SEQUENTIAL:
        return this.runSequentialPipeline(content, selectedModels, { context, ...modeOptions });
      case CollaborationMode.DEBATE:
        return this.runDebate(content, selectedModels, { context, ...modeOptions });
      case CollaborationMode.VALIDATION:
        return this.runValidation(content, selectedModels, { context, ...modeOptions });
      default:
        throw new Error(`Unknown collaboration mode: ${mode}`);
    }
  }

  /**
   * Parse model string into array
   */
  parseModels(models) {
    if (Array.isArray(models)) return models;
    return models.split(',').map(m => m.trim());
  }

  /**
   * Check if a model is a Gemini model (uses CLI) or OpenRouter model
   */
  isGeminiModel(model) {
    return model.startsWith('gemini-') || model.startsWith('google/gemini');
  }

  /**
   * Send prompt to appropriate model
   */
  async sendToModel(model, prompt) {
    if (this.isGeminiModel(model)) {
      return this.gemini.runSync(prompt, { model: model.replace('google/', '') });
    } else {
      const result = await this.openrouter.chat({ model, prompt });
      return result.content;
    }
  }

  /**
   * Run sequential pipeline
   */
  async runSequentialPipeline(content, models, options = {}) {
    const {
      pipelineStages = ['analysis', 'review', 'optimization', 'final_validation'],
      qualityGates = 'standard',
      context = '',
    } = options;

    const stages = typeof pipelineStages === 'string' 
      ? pipelineStages.split(',').map(s => s.trim()) 
      : pipelineStages;

    const results = [];
    let currentOutput = content;
    let stageIndex = 0;

    for (const stage of stages) {
      const model = models[stageIndex % models.length];
      
      const prompt = `You are performing the "${stage}" stage in a sequential pipeline.

CONTEXT: ${context}

PREVIOUS OUTPUT:
${currentOutput}

YOUR TASK: Perform ${stage} on the above content.
- Build on what came before
- Add your specialized analysis
- Be specific and actionable

Output your ${stage} results:`;

      try {
        const response = await this.sendToModel(model, prompt);
        
        results.push({
          stage,
          model,
          output: response,
          timestamp: new Date().toISOString(),
        });
        
        currentOutput = response;
        stageIndex++;
      } catch (error) {
        results.push({
          stage,
          model,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return {
      mode: CollaborationMode.SEQUENTIAL,
      stages: results,
      finalOutput: currentOutput,
      summary: this.summarizeSequential(results),
    };
  }

  /**
   * Run multi-round debate
   */
  async runDebate(content, models, options = {}) {
    const {
      rounds = 3,
      debateStyle = DebateStyle.CONSTRUCTIVE,
      context = '',
      focus = 'comprehensive analysis',
    } = options;

    const debateHistory = [];
    let roundNumber = 0;

    // Initial positions
    const initialPrompt = this.getDebateInitialPrompt(content, debateStyle, context, focus);
    
    for (const model of models) {
      try {
        const response = await this.sendToModel(model, initialPrompt);
        debateHistory.push({
          round: 0,
          model,
          role: 'initial_position',
          content: response,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        debateHistory.push({
          round: 0,
          model,
          role: 'initial_position',
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Debate rounds
    for (roundNumber = 1; roundNumber <= rounds; roundNumber++) {
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const otherPositions = debateHistory
          .filter(h => h.model !== model && h.round === roundNumber - 1)
          .map(h => `[${h.model}]: ${h.content}`)
          .join('\n\n');

        const prompt = this.getDebateRoundPrompt(debateStyle, roundNumber, rounds, otherPositions);

        try {
          const response = await this.sendToModel(model, prompt);
          debateHistory.push({
            round: roundNumber,
            model,
            role: 'response',
            content: response,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          debateHistory.push({
            round: roundNumber,
            model,
            role: 'response',
            error: error.message,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Generate synthesis
    const synthesis = await this.synthesizeDebate(debateHistory, models[0]);

    return {
      mode: CollaborationMode.DEBATE,
      style: debateStyle,
      rounds: roundNumber,
      history: debateHistory,
      synthesis,
      participants: models,
    };
  }

  /**
   * Run validation with consensus
   */
  async runValidation(content, models, options = {}) {
    const {
      validationCriteria = 'correctness,completeness,quality,best_practices',
      confidenceThreshold = 0.7,
      consensusMethod = ConsensusMethod.SIMPLE_MAJORITY,
      context = '',
    } = options;

    const criteria = typeof validationCriteria === 'string'
      ? validationCriteria.split(',').map(c => c.trim())
      : validationCriteria;

    const validations = [];

    // Get validation from each model
    for (const model of models) {
      const prompt = `You are a validator. Evaluate the following content against these criteria: ${criteria.join(', ')}

CONTEXT: ${context}

CONTENT TO VALIDATE:
${content}

For each criterion, provide:
1. Score (0.0 to 1.0)
2. Reasoning
3. Issues found (if any)
4. Recommendations

Output as structured analysis:`;

      try {
        const response = await this.sendToModel(model, prompt);
        validations.push({
          model,
          validation: response,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        validations.push({
          model,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Calculate consensus
    const consensus = this.calculateConsensus(validations, consensusMethod, confidenceThreshold);

    return {
      mode: CollaborationMode.VALIDATION,
      criteria,
      validations,
      consensus,
      method: consensusMethod,
      confidenceThreshold,
      participants: models,
    };
  }

  /**
   * Get initial debate prompt based on style
   */
  getDebateInitialPrompt(content, style, context, focus) {
    const styleInstructions = {
      [DebateStyle.CONSTRUCTIVE]: 'Build understanding collaboratively. Focus on finding common ground while exploring different perspectives.',
      [DebateStyle.ADVERSARIAL]: 'Challenge assumptions rigorously. Look for weaknesses and counter-arguments.',
      [DebateStyle.COLLABORATIVE]: 'Work together to explore the topic comprehensively. Build on each others ideas.',
      [DebateStyle.SOCRATIC]: 'Use questioning to explore underlying assumptions and principles.',
      [DebateStyle.DEVIL_ADVOCATE]: 'Deliberately argue for challenging or unpopular positions to stress-test ideas.',
    };

    return `You are participating in a ${style} debate/discussion.

STYLE: ${styleInstructions[style] || styleInstructions[DebateStyle.CONSTRUCTIVE]}
FOCUS: ${focus}
CONTEXT: ${context}

TOPIC/CONTENT:
${content}

Present your initial position. Be clear, specific, and well-reasoned.`;
  }

  /**
   * Get debate round prompt
   */
  getDebateRoundPrompt(style, round, totalRounds, otherPositions) {
    const isLastRound = round === totalRounds;
    
    return `DEBATE ROUND ${round}/${totalRounds}

OTHER PARTICIPANTS' POSITIONS:
${otherPositions}

${isLastRound 
  ? 'This is the final round. Work towards synthesis and conclusions.'
  : 'Respond to the other positions. Challenge, build upon, or refine your views.'}

Your response:`;
  }

  /**
   * Synthesize debate results
   */
  async synthesizeDebate(history, synthesisModel) {
    const allPositions = history
      .map(h => `[Round ${h.round}] [${h.model}]: ${h.content || h.error || 'No response'}`)
      .join('\n\n');

    const prompt = `Synthesize this debate into a coherent summary:

${allPositions}

Provide:
1. Key points of agreement
2. Key points of disagreement  
3. Strongest arguments from each side
4. Overall conclusions
5. Recommendations`;

    try {
      return await this.sendToModel(synthesisModel, prompt);
    } catch (error) {
      return `Synthesis error: ${error.message}`;
    }
  }

  /**
   * Calculate consensus from validations
   */
  calculateConsensus(validations, method, threshold) {
    const validResults = validations.filter(v => !v.error);
    
    if (validResults.length === 0) {
      return { reached: false, reason: 'No valid validations' };
    }

    // For now, simple analysis of validation responses
    // In a full implementation, we'd parse scores from the responses
    
    const participantCount = validResults.length;
    
    switch (method) {
      case ConsensusMethod.UNANIMOUS:
        return {
          reached: participantCount === validations.length,
          participantCount,
          method,
          note: 'Unanimous requires all models to provide valid responses',
        };
        
      case ConsensusMethod.SUPERMAJORITY:
        return {
          reached: participantCount >= validations.length * 0.67,
          participantCount,
          method,
          threshold: '67%',
        };
        
      case ConsensusMethod.SIMPLE_MAJORITY:
      default:
        return {
          reached: participantCount >= validations.length * 0.5,
          participantCount,
          method,
          threshold: '50%',
        };
    }
  }

  /**
   * Summarize sequential pipeline results
   */
  summarizeSequential(results) {
    const successful = results.filter(r => !r.error);
    const failed = results.filter(r => r.error);

    return {
      totalStages: results.length,
      successfulStages: successful.length,
      failedStages: failed.length,
      stagesCompleted: successful.map(r => r.stage),
      stagesFailed: failed.map(r => ({ stage: r.stage, error: r.error })),
    };
  }
}

export default AICollaborationEngine;
