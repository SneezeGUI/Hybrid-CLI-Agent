/**
 * OpenRouter Tool Handlers
 *
 * Handlers: openrouter_chat, openrouter_models, openrouter_usage_stats
 */

import { success, error, fetchWithTimeout } from '../base.js';

/**
 * Chat with OpenRouter models
 */
async function handleOpenrouterChat(args, context) {
  const { prompt, model = 'openai/gpt-4.1-nano', temperature = 0.7, max_tokens = 4096 } = args;
  const { openrouterStats } = context;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return error('OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable.\nGet your key at: https://openrouter.ai/keys');
  }

  try {
    const response = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/hybrid-cli-agent',
          'X-Title': 'Hybrid CLI Agent',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens,
        }),
      },
      60000
    );

    if (!response.ok) {
      const errorText = await response.text();
      return error(`OpenRouter error: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content || 'No response';

    // Track usage stats
    if (data.usage && openrouterStats) {
      openrouterStats.requests++;
      openrouterStats.inputTokens += data.usage.prompt_tokens || 0;
      openrouterStats.outputTokens += data.usage.completion_tokens || 0;

      const modelCosts = {
        'openai/gpt-4.1-nano': { input: 0.1, output: 0.4 },
        'openai/gpt-4.1-mini': { input: 0.4, output: 1.6 },
        'openai/gpt-4o': { input: 2.5, output: 10 },
        'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
        'anthropic/claude-3-haiku': { input: 0.25, output: 1.25 },
      };
      const costs = modelCosts[model] || { input: 0.5, output: 1.5 };
      openrouterStats.estimatedCost +=
        ((data.usage.prompt_tokens || 0) / 1_000_000) * costs.input +
        ((data.usage.completion_tokens || 0) / 1_000_000) * costs.output;
    }

    return success(`[${model}]\n\n${content}`);
  } catch (err) {
    if (err.name === 'AbortError') {
      return error('OpenRouter request timed out after 60 seconds');
    }
    return error(`OpenRouter error: ${err.message}`);
  }
}

/**
 * List OpenRouter models
 */
async function handleOpenrouterModels(args, context) {
  const { provider_filter = '' } = args;

  const models = {
    'openai': ['gpt-4.1-nano ($0.10/1M)', 'gpt-4.1-mini ($0.40/1M)', 'gpt-4o ($2.50/1M)', 'gpt-4o-mini ($0.15/1M)'],
    'anthropic': ['claude-3-haiku ($0.25/1M)', 'claude-3.5-sonnet ($3/1M)', 'claude-sonnet-4 ($3/1M)'],
    'meta': ['llama-3.1-8b-instruct ($0.05/1M)', 'llama-3.1-70b-instruct ($0.35/1M)', 'llama-3.1-405b-instruct ($2.70/1M)'],
    'google': ['gemini-2.5-flash ($0.08/1M)', 'gemini-2.5-pro ($1.25/1M)'],
    'deepseek': ['deepseek-r1 ($0.55/1M)', 'deepseek-chat ($0.14/1M)'],
  };

  let output = '# Available OpenRouter Models\n\n';
  output += '> Prices are per 1M input tokens. Output typically costs 2-4x more.\n\n';

  const providers = provider_filter
    ? Object.keys(models).filter(p => p.toLowerCase().includes(provider_filter.toLowerCase()))
    : Object.keys(models);

  for (const provider of providers) {
    output += `## ${provider.charAt(0).toUpperCase() + provider.slice(1)}\n`;
    for (const model of models[provider]) {
      output += `- ${provider}/${model}\n`;
    }
    output += '\n';
  }

  output += '\n_For full model list: https://openrouter.ai/models_';

  return success(output);
}

/**
 * Get OpenRouter usage stats
 */
async function handleOpenrouterUsageStats(args, context) {
  const { openrouterStats } = context;

  if (!openrouterStats) {
    return success('OpenRouter usage stats not available.');
  }

  return success(`# OpenRouter Usage Statistics

- **Requests**: ${openrouterStats.requests}
- **Input Tokens**: ${openrouterStats.inputTokens.toLocaleString()}
- **Output Tokens**: ${openrouterStats.outputTokens.toLocaleString()}
- **Estimated Cost**: $${openrouterStats.estimatedCost.toFixed(4)}

_Note: Costs are estimates based on typical model pricing._`);
}

/**
 * Export handlers map
 */
export const handlers = {
  openrouter_chat: handleOpenrouterChat,
  openrouter_models: handleOpenrouterModels,
  openrouter_usage_stats: handleOpenrouterUsageStats,
};

export default handlers;
