/**
 * Core Gemini Tool Handlers
 *
 * Handlers: gemini_auth_status, gemini_prompt, ask_gemini
 */

import { success, error } from '../base.js';

/**
 * Check Gemini authentication status
 */
async function handleGeminiAuthStatus(args, context) {
  const { safeSpawn, spawn, buildEnv, getActiveAuthMethod, getDefaultModel, AUTH_CONFIG } = context;

  const authInfo = await new Promise((resolve) => {
    const proc = safeSpawn(spawn, 'gemini', ['auth', 'status'], { env: buildEnv() });
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => {
      resolve({
        authenticated: code === 0,
        output: output.trim(),
      });
    });
    proc.on('error', () => resolve({ authenticated: false, output: 'CLI not found' }));
  });

  const activeMethod = getActiveAuthMethod();
  const fallbackChain = AUTH_CONFIG.fallbackChain;
  const failedMethods = Object.keys(AUTH_CONFIG.authFailures);

  const status = {
    activeMethod,
    primaryMethod: AUTH_CONFIG.method,
    authenticated: authInfo.authenticated,
    defaultModel: getDefaultModel(),
    availableModels: activeMethod === 'vertex'
      ? ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3-pro']
      : ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro'],
    isFree: activeMethod === 'oauth',
    details: authInfo.output,
    tips: [],
  };

  const chainDisplay = fallbackChain.map((auth, i) => {
    const isActive = auth.method === activeMethod;
    const isFailed = AUTH_CONFIG.authFailures[auth.method];
    const marker = isActive ? '>>> ' : isFailed ? '[X] ' : '    ';
    const suffix = isActive ? ' (active)' : isFailed ? ' (failed)' : '';
    return `${marker}${i + 1}. ${auth.name}${suffix}`;
  }).join('\n');

  if (!authInfo.authenticated && activeMethod === 'oauth') {
    status.tips.push('Run "gemini auth login" to authenticate with your Google account');
    status.tips.push('Pro/Ultra subscribers get 60 RPM and 1000 RPD FREE');
  }
  if (activeMethod === 'api-key') {
    status.tips.push('Using API key - consider OAuth for higher rate limits');
  }
  if (activeMethod === 'vertex') {
    status.tips.push('Using Vertex AI - higher rate limits available');
  }
  if (failedMethods.length > 0) {
    status.tips.push('Failed auth methods will be retried after 5 minutes');
  }

  return success(`Gemini Authentication Status:
- Active Method: ${status.activeMethod}
- OAuth Status: ${status.authenticated ? 'Authenticated' : 'Not authenticated'}
- Default Model: ${status.defaultModel}
- Available Models: ${status.availableModels.join(', ')}
- Free Tier: ${status.isFree ? 'Yes (OAuth/Pro subscription)' : 'No (billed per token)'}

Authentication Fallback Chain:
${chainDisplay}
${status.tips.length > 0 ? '\nTips:\n' + status.tips.map(t => '- ' + t).join('\n') : ''}`);
}

/**
 * Send prompt to Gemini with @filename support
 */
async function handleGeminiPrompt(args, context) {
  const { prompt, model: requestedModel = null } = args;
  const { runGeminiCli, hasFileReferences, processPrompt } = context;

  try {
    let processedPrompt = prompt;
    let fileInfo = '';

    if (hasFileReferences(prompt)) {
      const result = await processPrompt(prompt);
      processedPrompt = result.processed;

      if (result.files.length > 0) {
        fileInfo = `\n_[Processed ${result.files.length} file(s): ${result.files.map(f => f.path).join(', ')}]_\n`;
      }
      if (result.errors.length > 0) {
        fileInfo += `\n_[Warnings: ${result.errors.join('; ')}]_\n`;
      }
    }

    const response = await runGeminiCli(processedPrompt, {
      model: requestedModel,
      toolName: 'gemini_prompt',
    });

    return success(fileInfo + response);
  } catch (err) {
    return error(`Gemini prompt failed: ${err.message}`);
  }
}

/**
 * Quick questions to Gemini
 */
async function handleAskGemini(args, context) {
  const { question, model: requestedModel = null } = args;
  const { runGeminiCli, hasFileReferences, processPrompt } = context;

  try {
    let processedQuestion = question;
    if (hasFileReferences(question)) {
      const result = await processPrompt(question);
      processedQuestion = result.processed;
    }

    const response = await runGeminiCli(processedQuestion, {
      model: requestedModel,
      toolName: 'ask_gemini',
    });

    return success(response);
  } catch (err) {
    return error(`Ask Gemini failed: ${err.message}`);
  }
}

/**
 * Export handlers map
 */
export const handlers = {
  gemini_auth_status: handleGeminiAuthStatus,
  gemini_prompt: handleGeminiPrompt,
  ask_gemini: handleAskGemini,
};

export default handlers;
