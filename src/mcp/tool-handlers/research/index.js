/**
 * Research Tool Handlers
 *
 * Handlers: research_heavy_context, summarize_directory, gemini_eval_plan, gemini_verify_solution
 */

import { success, error } from '../base.js';

/**
 * Research heavy context - read and analyze files
 */
async function handleResearchHeavyContext(args, context) {
  const { query, file_patterns, use_flash = false, use_gemini_3 = false, base_dir = process.cwd() } = args;
  const { runGeminiCli, sanitizeGlobPatterns, readFilesFromPatterns, AUTH_CONFIG } = context;

  // Sanitize glob patterns to prevent path traversal
  const safePatterns = sanitizeGlobPatterns(file_patterns, base_dir);
  if (safePatterns.length === 0) {
    return error('No valid file patterns provided. Patterns cannot contain ".." or be absolute paths.');
  }

  try {
    // Read files locally (FREE - no tokens)
    const files = await readFilesFromPatterns(safePatterns, base_dir);

    if (files.length === 0) {
      return success('No files found matching the patterns.');
    }

    // Combine file contents
    const combinedContent = files
      .map(f => `\n--- FILE: ${f.path} ---\n${f.content}`)
      .join('\n');

    // Construct the research prompt
    const prompt = `You are a Senior Research Assistant helping a Lead Engineer.

QUERY: ${query}

Analyze the following ${files.length} files.

OUTPUT RULES:
1. Be concise - the Lead Engineer is busy
2. Provide a high-level summary first, then specific findings
3. If you find bugs or issues, list them with file:line references
4. If asked about architecture, provide a clear mental model
5. Do NOT regurgitate code unless absolutely necessary

CONTEXT (${files.length} files):
${combinedContent}`;

    // Determine requested model (user hints override smart selection)
    let requestedModel = null;
    if (use_flash) requestedModel = 'gemini-2.5-flash';
    if (use_gemini_3 && AUTH_CONFIG.method === 'vertex') requestedModel = 'gemini-3-pro';

    const response = await runGeminiCli(prompt, {
      model: requestedModel,
      toolName: 'research_heavy_context',
      preferFast: use_flash,
    });

    const costNote = AUTH_CONFIG.method === 'oauth' ? '(FREE with Pro subscription)' : '';

    return success(`[Gemini analyzed ${files.length} files ${costNote}]\n\n${response}`);
  } catch (err) {
    return error(`Research analysis failed: ${err.message}`);
  }
}

/**
 * Summarize directory structure
 */
async function handleSummarizeDirectory(args, context) {
  const { directory, depth = 2, focus = 'general structure' } = args;
  const { runGeminiCli, validateDirectory, readFilesFromPatterns, readdir, join } = context;

  // Validate directory path to prevent traversal
  const safeDirectory = await validateDirectory(directory);
  if (!safeDirectory) {
    return error('Invalid directory path. Path must exist and be within the current working directory.');
  }

  try {
    // Get directory tree using cross-platform Node.js approach
    const getFilesRecursive = async (dir, currentDepth = 0, maxDepth = depth) => {
      const files = [];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory() && currentDepth < maxDepth) {
            files.push(...await getFilesRecursive(fullPath, currentDepth + 1, maxDepth));
          } else if (entry.isFile()) {
            files.push(fullPath);
          }
        }
      } catch (e) {
        // Ignore permission errors
      }
      return files;
    };

    const fileList = await getFilesRecursive(safeDirectory);
    const treeResult = fileList.join('\n');

    // Read key files (README, package.json, etc.)
    const keyFiles = await readFilesFromPatterns([
      'README*',
      'package.json',
      'Cargo.toml',
      'pyproject.toml',
      'go.mod',
    ], safeDirectory);

    const prompt = `You are a Codebase Analyst.

Analyze this directory structure and provide a clear mental model.

FOCUS: ${focus}

DIRECTORY TREE:
${treeResult}

KEY FILES:
${keyFiles.map(f => `--- ${f.path} ---\n${f.content}`).join('\n')}

Provide:
1. What this project does (1-2 sentences)
2. Key entry points
3. Directory structure explanation
4. Dependencies/tech stack
5. Where to start if making changes`;

    const response = await runGeminiCli(prompt, {
      toolName: 'summarize_directory',
    });

    return success(`[Directory Analysis: ${directory}]\n\n${response}`);
  } catch (err) {
    return error(`Directory summarization failed: ${err.message}`);
  }
}

/**
 * Evaluate implementation plan
 */
async function handleGeminiEvalPlan(args, context) {
  const { plan, context: planContext = '', requirements = '', model: requestedModel = null } = args;
  const { runGeminiCli } = context;

  try {
    const prompt = `You are a Senior Solutions Architect evaluating an implementation plan.

CONTEXT: ${planContext}
REQUIREMENTS: ${requirements}

PLAN TO EVALUATE:
${plan}

Provide:
1. FEASIBILITY SCORE (1-10) with reasoning
2. RISKS & CONCERNS - potential issues or blockers
3. MISSING ELEMENTS - what the plan doesn't address
4. SUGGESTIONS - specific improvements
5. RECOMMENDED SEQUENCE - optimal order of implementation
6. ESTIMATED EFFORT - rough time estimates for each phase

Be constructive but thorough. Flag critical issues prominently.`;

    const response = await runGeminiCli(prompt, {
      model: requestedModel,
      toolName: 'gemini_eval_plan',
    });

    return success(`[Plan Evaluation]\n\n${response}`);
  } catch (err) {
    return error(`Plan evaluation failed: ${err.message}`);
  }
}

/**
 * Verify complete solution
 */
async function handleGeminiVerifySolution(args, context) {
  const { solution, requirements, test_criteria = '', context: solutionContext = '', model: requestedModel = null } = args;
  const { runGeminiCli } = context;

  try {
    const prompt = `You are a Quality Assurance Architect verifying a complete solution.

CONTEXT: ${solutionContext}
REQUIREMENTS:
${requirements}

TEST CRITERIA: ${test_criteria}

SOLUTION TO VERIFY:
${solution}

Perform comprehensive verification:

1. REQUIREMENTS CHECK
   - For each requirement, state: ✅ MET / ❌ NOT MET / ⚠️ PARTIAL
   - Provide evidence from the solution

2. CODE QUALITY
   - Architecture assessment
   - Error handling coverage
   - Edge cases addressed

3. SECURITY REVIEW
   - Authentication/authorization
   - Input validation
   - Data protection

4. PERFORMANCE ASSESSMENT
   - Potential bottlenecks
   - Scalability concerns

5. TEST COVERAGE
   - What's tested
   - What's missing

6. DEPLOYMENT READINESS
   - Production checklist
   - Missing configurations

7. FINAL VERDICT
   - APPROVED FOR DEPLOYMENT / NEEDS REVISION
   - Critical blockers (if any)`;

    const response = await runGeminiCli(prompt, {
      model: requestedModel,
      toolName: 'gemini_verify_solution',
    });

    return success(`[Solution Verification]\n\n${response}`);
  } catch (err) {
    return error(`Solution verification failed: ${err.message}`);
  }
}

/**
 * Export handlers map
 */
export const handlers = {
  research_heavy_context: handleResearchHeavyContext,
  summarize_directory: handleSummarizeDirectory,
  gemini_eval_plan: handleGeminiEvalPlan,
  gemini_verify_solution: handleGeminiVerifySolution,
};

export default handlers;
