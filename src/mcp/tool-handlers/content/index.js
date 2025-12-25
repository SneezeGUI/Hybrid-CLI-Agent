/**
 * Content Analysis Tool Handlers
 *
 * Handlers: gemini_content_comparison, gemini_extract_structured, gemini_summarize_files
 */

import { success, error } from '../base.js';

/**
 * Compare content from multiple sources
 */
async function handleGeminiContentComparison(args, context) {
  const { sources, comparison_type = 'semantic', focus = '' } = args;
  const { runGeminiCli, readFile } = context;

  if (!sources || sources.length < 2) {
    return error('At least 2 sources required for comparison');
  }

  try {
    // Process sources (handle @file references)
    const processedSources = await Promise.all(sources.map(async (source, i) => {
      if (source.startsWith('@')) {
        const filepath = source.slice(1);
        try {
          const content = await readFile(filepath, 'utf-8');
          return { label: `Source ${i + 1} (${filepath})`, content };
        } catch (e) {
          return { label: `Source ${i + 1} (${filepath})`, content: `[Error reading file: ${e.message}]` };
        }
      }
      return { label: `Source ${i + 1}`, content: source };
    }));

    const comparisonMethods = {
      semantic: 'Focus on meaning and intent. Identify conceptual similarities and differences.',
      structural: 'Analyze structure and organization. Compare layouts, sections, and hierarchy.',
      line_by_line: 'Perform detailed line-by-line comparison. Show additions, deletions, and modifications.',
      key_points: 'Extract and compare key points from each source.',
    };

    const prompt = `You are a Content Comparison Specialist.

COMPARISON TYPE: ${comparison_type}
METHOD: ${comparisonMethods[comparison_type]}
${focus ? `FOCUS AREAS: ${focus}` : ''}

SOURCES TO COMPARE:
${processedSources.map(s => `\n=== ${s.label} ===\n${s.content}`).join('\n')}

Provide a structured comparison:

## Summary
Brief overview of the comparison.

## Similarities
What the sources have in common.

## Differences
Key differences between sources (be specific, reference source numbers).

## Analysis
Deeper insights based on the ${comparison_type} comparison.
${focus ? `\n### Focus: ${focus}\nSpecific analysis of the requested focus areas.` : ''}

## Recommendations
Suggested actions or considerations based on the comparison.`;

    const response = await runGeminiCli(prompt, { model: 'gemini-2.5-pro' });

    return success(`[Content Comparison - ${comparison_type}]\n\n${response}`);
  } catch (err) {
    return error(`Content comparison failed: ${err.message}`);
  }
}

/**
 * Extract structured data from unstructured text
 */
async function handleGeminiExtractStructured(args, context) {
  const { content, schema, schema_description, examples = [] } = args;
  const { runGeminiCli, readFile } = context;

  // Handle @file reference
  let textContent = content;
  if (content.startsWith('@')) {
    const filepath = content.slice(1);
    try {
      textContent = await readFile(filepath, 'utf-8');
    } catch (e) {
      return error(`Error reading file: ${e.message}`);
    }
  }

  try {
    let schemaSection = '';
    if (schema) {
      schemaSection = `\nOUTPUT JSON SCHEMA:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;
    } else if (schema_description) {
      schemaSection = `\nEXPECTED OUTPUT STRUCTURE:\n${schema_description}`;
    } else {
      schemaSection = '\nInfer an appropriate JSON structure from the content.';
    }

    let examplesSection = '';
    if (examples.length > 0) {
      examplesSection = `\n\nEXAMPLES OF EXPECTED OUTPUT:\n${examples.map((ex, i) => `Example ${i + 1}:\n\`\`\`json\n${JSON.stringify(ex, null, 2)}\n\`\`\``).join('\n\n')}`;
    }

    const prompt = `You are a Data Extraction Specialist.

Extract structured data from the following content and return ONLY valid JSON.
${schemaSection}
${examplesSection}

CONTENT TO EXTRACT FROM:
${textContent}

IMPORTANT:
- Return ONLY the JSON, no markdown code blocks
- Ensure all JSON is valid and properly escaped
- If data is missing, use null
- If multiple items match, return an array`;

    const response = await runGeminiCli(prompt, { model: 'gemini-2.5-pro' });

    // Try to parse and validate JSON
    let parsedJson;
    try {
      const cleanedResponse = response
        .replace(/^```json\n?/gm, '')
        .replace(/```$/gm, '')
        .trim();
      parsedJson = JSON.parse(cleanedResponse);
    } catch (e) {
      return success(`[Extracted Data - Raw]\n\n${response}\n\nNote: Response may not be valid JSON. Error: ${e.message}`);
    }

    return success(`[Extracted Structured Data]\n\n\`\`\`json\n${JSON.stringify(parsedJson, null, 2)}\n\`\`\``);
  } catch (err) {
    return error(`Data extraction failed: ${err.message}`);
  }
}

/**
 * Generate summaries of multiple files
 */
async function handleGeminiSummarizeFiles(args, context) {
  const { file_patterns, summary_style = 'bullet_points', max_words_per_file = 100, group_by = 'directory', base_dir = process.cwd() } = args;
  const { runGeminiCli, sanitizeGlobPatterns, readFilesFromPatterns } = context;

  // Sanitize glob patterns
  const safePatterns = sanitizeGlobPatterns(file_patterns, base_dir);
  if (safePatterns.length === 0) {
    return error('No valid file patterns provided. Patterns cannot contain ".." or be absolute paths.');
  }

  try {
    const files = await readFilesFromPatterns(safePatterns, base_dir);

    if (files.length === 0) {
      return success('No files found matching the patterns.');
    }

    const styleInstructions = {
      brief: 'One sentence summary.',
      detailed: 'Comprehensive summary covering purpose, key components, and notable aspects.',
      bullet_points: '3-5 bullet points highlighting key aspects.',
      executive: 'High-level executive summary focusing on business value and key decisions.',
    };

    const prompt = `You are a Technical Documentation Specialist.

Summarize each of the following ${files.length} files.

SUMMARY STYLE: ${summary_style}
INSTRUCTION: ${styleInstructions[summary_style]}
MAX WORDS PER FILE: ${max_words_per_file}
GROUPING: ${group_by}

FILES:
${files.map(f => `\n=== ${f.path} ===\n${f.content.slice(0, 10000)}`).join('\n')}

${group_by !== 'none' ? `Group the summaries by ${group_by}.` : ''}

Output format:
${group_by !== 'none' ? '## [Group Name]\n\n' : ''}### [filename]
[Summary in ${summary_style} style]
`;

    const response = await runGeminiCli(prompt, { model: 'gemini-2.5-flash' });

    return success(`[File Summaries - ${files.length} files]\n\n${response}`);
  } catch (err) {
    return error(`File summarization failed: ${err.message}`);
  }
}

/**
 * Export handlers map
 */
export const handlers = {
  gemini_content_comparison: handleGeminiContentComparison,
  gemini_extract_structured: handleGeminiExtractStructured,
  gemini_summarize_files: handleGeminiSummarizeFiles,
};

export default handlers;
