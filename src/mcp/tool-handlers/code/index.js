/**
 * Code Tool Handlers
 *
 * Handlers: draft_code_implementation, review_code_changes, gemini_code_review, gemini_git_diff_review
 */

import { success, error, runGitDiff, cleanCodeOutput } from '../base.js';

/**
 * Draft code implementation
 */
async function handleDraftCodeImplementation(args, context) {
  const { task_description, target_file, context_files = [], language, use_gemini_3 = false } = args;
  const { runGeminiCli, sanitizePath, sanitizeGlobPatterns, readFilesFromPatterns, isWriteAllowed, writeFile, AUTH_CONFIG } = context;

  // Validate target file path
  const safeTargetFile = sanitizePath(target_file);
  if (!safeTargetFile) {
    return error('Invalid target file path. Path cannot contain ".." or be absolute.');
  }

  // Check if write is allowed (protects critical files)
  const writeCheck = isWriteAllowed(target_file);
  if (!writeCheck.allowed) {
    return error(`Cannot write to this location.\nReason: ${writeCheck.reason}\n\nFor security, certain files and directories are protected from automated writes:\n- Configuration files (.env, package.json, etc.)\n- System directories (node_modules/, .git/, etc.)\n- Source directories of this tool (src/, bin/)\n\nPlease specify a different target path.`);
  }

  try {
    // Read context files if provided
    let contextSection = '';
    if (context_files.length > 0) {
      const safeContextPatterns = sanitizeGlobPatterns(context_files);
      const files = await readFilesFromPatterns(safeContextPatterns);
      if (files.length > 0) {
        contextSection = `\nREFERENCE FILES:\n${files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n')}`;
      }
    }

    // Detect language from file extension
    const ext = target_file.split('.').pop();
    const detectedLang = language || {
      js: 'JavaScript', ts: 'TypeScript', py: 'Python',
      rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby',
    }[ext] || ext;

    const prompt = `You are a code generator. Output ONLY raw ${detectedLang} code.

TASK: ${task_description}
${contextSection}

CRITICAL RULES:
- Output ONLY the code itself, nothing else
- Do NOT explain what you will do
- Do NOT mention files, tools, or actions
- Do NOT use markdown code blocks
- Start your response with the first line of code
- Include JSDoc/docstrings and error handling
- Follow ${detectedLang} best practices`;

    // Smart model selection - code generation is complex
    let requestedModel = null;
    if (use_gemini_3 && AUTH_CONFIG.method === 'vertex') requestedModel = 'gemini-3-pro';

    const code = await runGeminiCli(prompt, {
      model: requestedModel,
      toolName: 'draft_code_implementation',
    });

    // Clean up Gemini response to extract only the code
    const cleanCode = cleanCodeOutput(code);

    // Write to disk
    await writeFile(safeTargetFile, cleanCode, 'utf-8');

    return success(`Gemini drafted ${target_file}\n\nReview it with:\n  cat ${target_file}\n  git diff ${target_file}\n\nThe code is ready for your review and refinement.`);
  } catch (err) {
    return error(`Code drafting failed: ${err.message}`);
  }
}

/**
 * Review code changes
 */
async function handleReviewCodeChanges(args, context) {
  const { file_patterns, focus_areas = 'general quality', git_diff = false } = args;
  const { runGeminiCli, sanitizeGlobPatterns, sanitizeGitPatterns, readFilesFromPatterns, isGitAvailable, safeSpawn, spawn, TIMEOUTS } = context;

  try {
    let contentToReview = '';

    if (git_diff) {
      if (!(await isGitAvailable())) {
        return error('Git is not available or not installed. Cannot run git diff.');
      }

      const safeGitPatterns = sanitizeGitPatterns(file_patterns);
      contentToReview = await runGitDiff({
        spawn,
        safeSpawn,
        patterns: safeGitPatterns,
        staged: true,
        timeout: TIMEOUTS.QUICK,
      });
    } else {
      const safePatterns = sanitizeGlobPatterns(file_patterns);
      const files = await readFilesFromPatterns(safePatterns);
      contentToReview = files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n');
    }

    const prompt = `You are a Senior Code Reviewer.

FOCUS AREAS: ${focus_areas}

Review the following code/changes and provide:
1. Critical issues (bugs, security, performance)
2. Suggestions for improvement
3. What's done well (brief)

Be constructive and specific. Reference file:line when possible.

CODE TO REVIEW:
${contentToReview}`;

    const response = await runGeminiCli(prompt, {
      toolName: 'review_code_changes',
      preferFast: true,
    });

    return success(`[Code Review by Gemini]\n\n${response}`);
  } catch (err) {
    return error(`Code review failed: ${err.message}`);
  }
}

/**
 * Gemini code review with structured output
 */
async function handleGeminiCodeReview(args, context) {
  const { code, language = '', focus_areas = 'security,performance,quality,best_practices', severity_threshold = 'info' } = args;
  const { runGeminiCli, hasFileReferences, processPrompt } = context;

  try {
    let codeToReview = code;
    if (hasFileReferences(code)) {
      const result = await processPrompt(code);
      codeToReview = result.processed;
    }

    const prompt = `You are a Senior Code Reviewer performing a comprehensive analysis.

LANGUAGE: ${language || 'auto-detect'}
FOCUS AREAS: ${focus_areas}
MINIMUM SEVERITY: ${severity_threshold}

CODE TO REVIEW:
${codeToReview}

Provide structured output:

## SUMMARY
Brief overview of code quality and main concerns.

## ISSUES FOUND
For each issue:
- **[SEVERITY]** (critical/error/warning/info)
- **Location**: file:line or code snippet
- **Issue**: What's wrong
- **Impact**: Why it matters
- **Fix**: How to resolve

## POSITIVE ASPECTS
What the code does well.

## RECOMMENDATIONS
Top 3-5 priority improvements.

## METRICS
- Estimated complexity: Low/Medium/High
- Test coverage needed: Yes/No/Partial
- Documentation needed: Yes/No/Partial`;

    const response = await runGeminiCli(prompt, {
      toolName: 'gemini_code_review',
    });

    return success(`[Code Review]\n\n${response}`);
  } catch (err) {
    return error(`Code review failed: ${err.message}`);
  }
}

/**
 * Git diff review
 */
async function handleGeminiGitDiffReview(args, context) {
  const { diff, review_type = 'comprehensive', base_branch = 'main', commit_message = '' } = args;
  const { runGeminiCli, isGitAvailable, safeSpawn, spawn, TIMEOUTS } = context;

  try {
    let diffContent = diff;

    if (diff === 'staged' || diff === 'staged changes') {
      if (!(await isGitAvailable())) {
        return error('Git is not available or not installed. Cannot run git diff.');
      }

      diffContent = await runGitDiff({
        spawn,
        safeSpawn,
        staged: true,
        timeout: TIMEOUTS.QUICK,
      });
    }

    const reviewPrompts = {
      comprehensive: 'Perform a complete code review covering security, performance, correctness, and style.',
      security_only: 'Focus ONLY on security vulnerabilities and concerns.',
      performance_only: 'Focus ONLY on performance issues and optimization opportunities.',
      quick: 'Quick review - highlight only critical issues.',
    };

    const prompt = `You are reviewing a git diff.

BASE BRANCH: ${base_branch}
COMMIT MESSAGE: ${commit_message}
REVIEW TYPE: ${review_type}

INSTRUCTIONS: ${reviewPrompts[review_type] || reviewPrompts.comprehensive}

DIFF:
${diffContent}

Provide:
1. CHANGE SUMMARY - What these changes do
2. ISSUES - Problems found (with line references from diff)
3. SUGGESTIONS - Improvements
4. VERDICT - Approve / Request Changes / Comment`;

    const response = await runGeminiCli(prompt, { model: 'gemini-2.5-pro' });

    return success(`[Git Diff Review - ${review_type}]\n\n${response}`);
  } catch (err) {
    return error(`Git diff review failed: ${err.message}`);
  }
}

/**
 * Export handlers map
 */
export const handlers = {
  draft_code_implementation: handleDraftCodeImplementation,
  review_code_changes: handleReviewCodeChanges,
  gemini_code_review: handleGeminiCodeReview,
  gemini_git_diff_review: handleGeminiGitDiffReview,
};

export default handlers;
