/**
 * AI Collaboration Tool Handlers
 *
 * Handlers: ai_collaboration, cross_model_comparison
 */

import { success, error } from '../base.js';

/**
 * AI Collaboration - multi-model debates, validation, sequential pipelines
 */
async function handleAiCollaboration(args, context) {
  const {
    mode = 'debate',
    content,
    models = '',
    context: collaborationContext = '',
    rounds = 3,
    debate_style = 'constructive',
    validation_criteria = '',
    confidence_threshold = 0.7,
    consensus_method = 'simple_majority',
    pipeline_stages = '',
  } = args;
  const { runGeminiCli, AICollaborationEngine } = context;

  // Use AICollaborationEngine for REAL multi-model collaboration
  const collaborationEngine = new AICollaborationEngine({
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY,
    },
  });

  const modelList = models ? models.split(',').map(m => m.trim()) : undefined;

  try {
    const collaborationOptions = {
      mode: mode.toLowerCase(),
      content,
      models: modelList,
      context: collaborationContext,
    };

    // Add mode-specific options
    if (mode === 'debate') {
      collaborationOptions.rounds = rounds;
      collaborationOptions.debateStyle = debate_style;
    } else if (mode === 'validation') {
      collaborationOptions.validationCriteria = validation_criteria;
      collaborationOptions.confidenceThreshold = confidence_threshold;
      collaborationOptions.consensusMethod = consensus_method;
    } else if (mode === 'sequential') {
      collaborationOptions.pipelineStages = pipeline_stages || 'analysis,review,optimization';
    }

    const result = await collaborationEngine.collaborate(collaborationOptions);

    // Format output based on mode
    let output = `[AI Collaboration - ${mode.toUpperCase()}]\n\n`;

    if (mode === 'debate') {
      output += `**Style:** ${result.style}\n`;
      output += `**Rounds:** ${result.rounds}\n`;
      output += `**Participants:** ${result.participants.join(', ')}\n\n`;
      output += `**Debate History:**\n`;
      for (const entry of result.history.slice(-6)) {
        output += `\n---\n[Round ${entry.round}] [${entry.model}]:\n${entry.content || entry.error || 'No response'}\n`;
      }
      output += `\n---\n\n**Synthesis:**\n${result.synthesis}`;
    } else if (mode === 'validation') {
      output += `**Criteria:** ${result.criteria.join(', ')}\n`;
      output += `**Method:** ${result.method}\n`;
      output += `**Participants:** ${result.participants.join(', ')}\n\n`;
      output += `**Validations:**\n`;
      for (const v of result.validations) {
        output += `\n---\n[${v.model}]:\n${v.validation || v.error || 'No response'}\n`;
      }
      output += `\n---\n\n**Consensus:** ${JSON.stringify(result.consensus, null, 2)}`;
    } else if (mode === 'sequential') {
      output += `**Stages:** ${result.summary.stagesCompleted.join(' → ')}\n`;
      output += `**Success Rate:** ${result.summary.successfulStages}/${result.summary.totalStages}\n\n`;
      if (result.summary.failedStages.length > 0) {
        output += `**Failed Stages:** ${result.summary.stagesFailed.map(s => s.stage).join(', ')}\n\n`;
      }
      output += `**Final Output:**\n${result.finalOutput}`;
    }

    return success(output);
  } catch (err) {
    // Fallback to simulated collaboration if engine fails
    const fallbackPrompt = `You are simulating a ${mode} collaboration.

TOPIC/CONTENT: ${content}
CONTEXT: ${collaborationContext}
${mode === 'debate' ? `DEBATE STYLE: ${debate_style}\nROUNDS: ${rounds}` : ''}
${mode === 'validation' ? `CRITERIA: ${validation_criteria || 'correctness, completeness, quality'}` : ''}
${mode === 'sequential' ? `STAGES: ${pipeline_stages || 'analysis,review,optimization'}` : ''}

Provide comprehensive ${mode} analysis with multiple perspectives.`;

    const fallbackResponse = await runGeminiCli(fallbackPrompt, { model: 'gemini-2.5-pro' });
    return success(`[AI Collaboration - ${mode} (fallback mode)]\n\n${fallbackResponse}\n\n_Note: Full multi-model collaboration requires OpenRouter API key._`);
  }
}

/**
 * Cross-model comparison
 */
async function handleCrossModelComparison(args, context) {
  const { prompt, models = 'gemini-2.5-flash,gemini-2.5-pro' } = args;
  const { runGeminiCli } = context;

  const modelList = models.split(',').map(m => m.trim());
  const results = [];

  for (const model of modelList) {
    if (model.startsWith('gemini-')) {
      try {
        const response = await runGeminiCli(prompt, { model });
        results.push({ model, response, error: null });
      } catch (err) {
        results.push({ model, response: null, error: err.message });
      }
    } else {
      results.push({ model, response: null, error: 'OpenRouter models require OPENROUTER_API_KEY' });
    }
  }

  const output = results.map(r => {
    if (r.error) {
      return `## ${r.model}\n❌ Error: ${r.error}`;
    }
    return `## ${r.model}\n${r.response}`;
  }).join('\n\n---\n\n');

  return success(`[Cross-Model Comparison]\n\n${output}`);
}

/**
 * Export handlers map
 */
export const handlers = {
  ai_collaboration: handleAiCollaboration,
  cross_model_comparison: handleCrossModelComparison,
};

export default handlers;
