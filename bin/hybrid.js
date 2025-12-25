#!/usr/bin/env node
/**
 * Hybrid CLI Agent
 * 
 * A multi-agent CLI orchestrator that combines Claude Code and Gemini CLI.
 * Claude supervises, Gemini does heavy lifting.
 * 
 * Usage:
 *   hybrid ask "What does the auth module do?"
 *   hybrid draft src/new-feature.js "Create a rate limiter"
 *   hybrid review src/
 *   hybrid costs
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { Orchestrator } from '../src/orchestrator/index.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { GeminiCliAdapter } from '../src/adapters/gemini-cli.js';

const program = new Command();

// Global verbose flag
let verbose = false;

/**
 * Connect orchestrator progress events to an ora spinner
 * @param {Orchestrator} orchestrator
 * @param {ora.Ora} spinner
 */
function connectProgress(orchestrator, spinner) {
  orchestrator.on('progress', ({ stage, message, details }) => {
    // Update spinner text based on stage
    switch (stage) {
      case 'routing':
        spinner.text = `Routing to ${details.adapter}...`;
        break;
      case 'executing':
        spinner.text = message;
        break;
      case 'review':
        if (message.includes('reviewing')) {
          spinner.text = chalk.cyan(message);
        } else if (details?.approved) {
          spinner.succeed(chalk.green('Review approved!'));
          spinner.start('Finalizing...');
        } else if (message === 'Corrections needed') {
          spinner.text = chalk.yellow('Corrections needed...');
        }
        break;
      case 'correction':
        spinner.text = chalk.yellow(message);
        break;
      case 'complete':
        spinner.succeed('Task completed');
        break;
    }

    // Log details in verbose mode
    if (verbose && details) {
      console.error(chalk.dim(`  [${stage}] ${JSON.stringify(details)}`));
    }
  });
}

/**
 * Print operation summary after task completion
 * @param {object} result
 */
function printSummary(result) {
  if (!result.summary) return;

  const { summary, cost } = result;
  console.log('\n' + chalk.dim('─'.repeat(50)));
  console.log(chalk.bold('Operation Summary:'));
  console.log(`  Task type: ${chalk.cyan(summary.taskType)}`);
  console.log(`  Complexity: ${chalk.cyan(summary.complexity)}`);
  console.log(`  Steps: ${summary.stepsCount}`);

  if (summary.reviewIterations > 0) {
    console.log(`  Reviews: ${summary.reviewIterations}`);
    console.log(`  Corrections: ${summary.correctionIterations}`);
    console.log(`  Status: ${summary.approved ? chalk.green('Approved') : chalk.yellow('Max attempts reached')}`);
  }

  console.log(`  Models: ${summary.modelsUsed.join(', ')}`);
  console.log(`  Cost: $${cost?.toFixed(4) || '0.0000'}`);
}

program
  .name('hybrid')
  .description('Multi-agent CLI orchestrator combining Claude Code and Gemini CLI')
  .version('0.1.0')
  .option('-v, --verbose', 'Show detailed progress information')
  .hook('preAction', (thisCommand) => {
    verbose = thisCommand.opts().verbose || false;
  });

// Check available adapters
async function checkAdapters() {
  const claude = new ClaudeCodeAdapter();
  const gemini = new GeminiCliAdapter();
  
  const claudeAvailable = await claude.isAvailable();
  const geminiAvailable = await gemini.isAvailable();
  
  return { claude: claudeAvailable, gemini: geminiAvailable };
}

// ============================================================================
// Commands
// ============================================================================

program
  .command('status')
  .description('Check which CLI agents are available and their auth status')
  .action(async () => {
    const spinner = ora('Checking available agents...').start();
    
    const { claude, gemini } = await checkAdapters();
    spinner.stop();
    
    console.log('\n' + chalk.bold('Agent Status:'));
    console.log(`  ${claude ? chalk.green('✓') : chalk.red('✗')} Claude Code CLI ${claude ? chalk.gray('(claude)') : chalk.red('not found - npm i -g @anthropic-ai/claude-code')}`);
    console.log(`  ${gemini ? chalk.green('✓') : chalk.red('✗')} Gemini CLI ${gemini ? chalk.gray('(gemini)') : chalk.red('not found - npm i -g @google/gemini-cli')}`);
    
    // Check Gemini auth status if available
    if (gemini) {
      const geminiAdapter = new GeminiCliAdapter();
      const authStatus = await geminiAdapter.checkAuth();
      const authInfo = geminiAdapter.getAuthInfo();
      
      console.log('\n' + chalk.bold('Gemini Authentication:'));
      console.log(`  Method: ${chalk.cyan(authInfo.method)}`);
      console.log(`  Status: ${authStatus.authenticated ? chalk.green('Authenticated') : chalk.red('Not authenticated')}`);
      console.log(`  Free Tier: ${authInfo.isFree ? chalk.green('Yes (60 RPM, 1000 RPD)') : chalk.yellow('No (billed per token)')}`);
      console.log(`  Models: ${authInfo.models.join(', ')}`);
      
      if (!authStatus.authenticated) {
        console.log('\n' + chalk.yellow('To authenticate with Google Pro subscription:'));
        console.log(chalk.gray('  gemini auth login'));
      }
      
      if (authStatus.isProSubscription) {
        console.log('\n' + chalk.green('✓ Pro subscription detected - you have generous "FREE" limits!'));
      }
    }
    
    // Check for API keys
    console.log('\n' + chalk.bold('Environment Variables:'));
    console.log(`  GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? chalk.green('Set') : chalk.gray('Not set')}`);
    console.log(`  VERTEX_API_KEY: ${process.env.VERTEX_API_KEY ? chalk.green('Set (Gemini 3 Pro available)') : chalk.gray('Not set')}`);
    console.log(`  GOOGLE_API_KEY: ${process.env.GOOGLE_API_KEY ? chalk.green('Set') : chalk.gray('Not set')}`);
    
    if (claude && gemini) {
      console.log('\n' + chalk.green('✓ All agents ready!'));
    } else {
      console.log('\n' + chalk.yellow('⚠ Some agents are missing. Install them to use all features.'));
    }
  });

program
  .command('ask <question>')
  .description('Ask a question - routed to the best agent automatically')
  .option('-m, --model <model>', 'Force a specific model')
  .option('-a, --agent <agent>', 'Force an agent (claude or gemini)')
  .option('--files <patterns...>', 'Include files for context')
  .action(async (question, options) => {
    const spinner = ora('Thinking...').start();

    try {
      const orchestrator = new Orchestrator({ workDir: process.cwd() });
      connectProgress(orchestrator, spinner);

      // Build the full prompt with files if specified
      let fullPrompt = question;
      if (options.files) {
        fullPrompt = `Analyze these files and answer: ${question}\n\nFiles: ${options.files.join(', ')}`;
      }

      const result = await orchestrator.execute(fullPrompt, {
        forceAdapter: options.agent,
        forceModel: options.model,
      });

      console.log('\n' + chalk.dim(`[${result.routing.adapter}/${result.routing.model}]`));
      console.log(result.result);

      if (verbose) {
        printSummary(result);
      } else {
        console.log('\n' + chalk.dim(`Cost: $${result.cost?.toFixed(4) || '0.0000'}`));
      }

    } catch (error) {
      spinner.fail(chalk.red(error.message));
      process.exit(1);
    }
  });

program
  .command('research <query>')
  .description('Research a codebase using Gemini (heavy context, free)')
  .requiredOption('-f, --files <patterns...>', 'File patterns to analyze')
  .option('--flash', 'Use Gemini Flash (faster, less thorough)')
  .action(async (query, options) => {
    const spinner = ora('Gemini is reading files...').start();

    try {
      const orchestrator = new Orchestrator({ workDir: process.cwd() });
      connectProgress(orchestrator, spinner);

      const prompt = `[RESEARCH TASK - Use Gemini]
Analyze files matching: ${options.files.join(', ')}
Query: ${query}

Read all matching files and provide a comprehensive analysis.`;

      const result = await orchestrator.execute(prompt, {
        forceAdapter: 'gemini',
        forceModel: options.flash ? 'gemini-2.5-flash' : 'gemini-2.5-pro',
      });

      console.log('\n' + result.result);

      if (verbose) {
        printSummary(result);
      } else {
        console.log('\n' + chalk.dim(`Cost: $${result.cost?.toFixed(4) || '0.0000'} (Gemini CLI is FREE with Google account)`));
      }

    } catch (error) {
      spinner.fail(chalk.red(error.message));
      process.exit(1);
    }
  });

program
  .command('draft <file> <description>')
  .description('Have Gemini draft code, then Claude reviews it')
  .option('--context <patterns...>', 'Reference files for context')
  .option('--no-review', 'Skip Claude review (just draft)')
  .action(async (file, description, options) => {
    const spinner = ora('Gemini is drafting code...').start();

    try {
      const orchestrator = new Orchestrator({ workDir: process.cwd() });
      connectProgress(orchestrator, spinner);

      const prompt = `[DRAFT CODE - Gemini drafts, Claude reviews]
Target file: ${file}
Task: ${description}
${options.context ? `Reference files: ${options.context.join(', ')}` : ''}

Create production-quality code for this file.`;

      const result = await orchestrator.execute(prompt, {
        skipReview: options.noReview,
      });

      console.log('\n' + chalk.green(`✓ Code drafted to ${file}`));
      console.log(chalk.dim('Review with: cat ' + file));

      // Always show summary for draft commands (shows collaboration process)
      printSummary(result);

    } catch (error) {
      spinner.fail(chalk.red(error.message));
      process.exit(1);
    }
  });

program
  .command('review [files...]')
  .description('Have Gemini review code, Claude validates concerns')
  .option('--focus <areas>', 'Focus areas: security, performance, readability')
  .option('--diff', 'Review only git staged changes')
  .action(async (files, options) => {
    const patterns = files.length > 0 ? files : ['**/*.{js,ts,py,go,rs}'];
    const spinner = ora('Reviewing code...').start();

    try {
      const orchestrator = new Orchestrator({ workDir: process.cwd() });
      connectProgress(orchestrator, spinner);

      const prompt = `[CODE REVIEW]
Files: ${patterns.join(', ')}
Focus: ${options.focus || 'general quality'}
${options.diff ? 'Mode: git diff (staged changes only)' : 'Mode: full file review'}

Review the code and identify issues.`;

      const result = await orchestrator.execute(prompt);

      console.log('\n' + result.result);

      // Always show summary for review commands
      printSummary(result);

    } catch (error) {
      spinner.fail(chalk.red(error.message));
      process.exit(1);
    }
  });

program
  .command('costs')
  .description('Show cost summary for this session')
  .action(async () => {
    const orchestrator = new Orchestrator({ workDir: process.cwd() });
    const costs = orchestrator.getTotalCosts();
    
    console.log('\n' + chalk.bold('Cost Summary:'));
    console.log(`  Claude: $${costs.claude.cost.toFixed(4)} (${costs.claude.inputTokens} in / ${costs.claude.outputTokens} out)`);
    console.log(`  Gemini: $${costs.gemini.cost.toFixed(4)} (${costs.gemini.inputTokens} in / ${costs.gemini.outputTokens} out)`);
    console.log(chalk.dim('  (Gemini CLI with Google account is FREE)'));
    console.log(`  ${chalk.bold('Total:')} $${costs.total.toFixed(4)}`);
  });

program
  .command('mcp-install')
  .description('Install the Gemini Worker MCP server into Claude Code')
  .action(async () => {
    const { execSync } = await import('child_process');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const serverPath = join(__dirname, '..', 'src', 'mcp', 'gemini-mcp-server.js');
    
    console.log(chalk.bold('Installing Gemini Worker MCP server...'));
    console.log(chalk.dim(`Server path: ${serverPath}`));
    
    try {
      execSync(`claude mcp add gemini-worker -- node ${serverPath}`, { stdio: 'inherit' });
      console.log(chalk.green('\n✓ MCP server installed!'));
      console.log(chalk.dim('Claude Code can now use Gemini tools like research_heavy_context'));
    } catch (error) {
      console.log(chalk.yellow('\nManual installation:'));
      console.log(`  claude mcp add gemini-worker -- node ${serverPath}`);
    }
  });

program.parse();
