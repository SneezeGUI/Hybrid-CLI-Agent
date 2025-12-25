#!/usr/bin/env node
/**
 * Show Gemini Worker configuration
 * Run directly: node bin/config.js
 * Or via npm: npm run config
 */

import { applyEnvFile } from '../src/utils/env.js';

// Mask sensitive values
function mask(val) {
  if (!val) return '(not set)';
  if (val.length <= 8) return '****';
  return val.substring(0, 4) + '*'.repeat(Math.min(val.length - 4, 16));
}

// Detect auth method
function detectAuthMethod() {
  if (process.env.VERTEX_API_KEY) return 'vertex';
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'api-key';
  return 'oauth';
}

// Get supported models
function getSupportedModels() {
  return ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3-pro'];
}

// Main - Load .env files using shared utility
const loadedFiles = applyEnvFile(process.cwd(), { silent: true });
const authMethod = detectAuthMethod();

console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  Hybrid-CLI-Agent - Config                   ║
╠══════════════════════════════════════════════════════════════╣
║ Version: 0.3.4                                               ║
╚══════════════════════════════════════════════════════════════╝

📁 Environment Files Loaded:
${loadedFiles.length > 0 ? loadedFiles.map(f => `   ✅ ${f}`).join('\n') : '   (none)'}

🔐 Authentication:
   Method: ${authMethod}${authMethod === 'vertex' ? ' (higher rate limits)' : ''}
   GEMINI_API_KEY: ${mask(process.env.GEMINI_API_KEY)}
   GOOGLE_API_KEY: ${mask(process.env.GOOGLE_API_KEY)}
   VERTEX_API_KEY: ${mask(process.env.VERTEX_API_KEY)}
   OPENROUTER_API_KEY: ${mask(process.env.OPENROUTER_API_KEY)}

🤖 Model Selection (Smart Routing):
   Default (complex): gemini-3-pro
   Default (standard): gemini-2.5-pro
   Default (simple): gemini-2.5-flash
   Rate limit fallback: Enabled

   Available models:
${getSupportedModels().map(m => `   ✅ ${m}`).join('\n')}

⚙️ Features:
   Smart Model Selection: Enabled
   Agent Mode: ${process.env.GEMINI_AGENT_MODE === 'true' ? 'Enabled' : 'Disabled (--extensions none)'}
   Response Cache: Enabled (30 min TTL)
   .env support: Enabled

📂 Paths:
   Working Directory: ${process.cwd()}

💡 Tips:
   • Enable agent mode: set GEMINI_AGENT_MODE=true
   • Use API key: set GEMINI_API_KEY=your-key
   • Start server: npm run mcp
`);
