# Structured Output Implementation Plan

## Problem Statement

Currently, Gemini output is formatted for humans:
- Prose explanations mixed with code
- Markdown code blocks that need regex stripping
- Preamble text before actual content
- No token usage data returned

This causes:
- **Parsing ambiguity**: Complex regex needed to extract code
- **Token bloat**: Human-friendly text wastes tokens
- **No cost tracking**: Can't track actual token usage
- **Brittle extraction**: Preamble removal is error-prone

## Solution

Use `--output-format json` which returns:
```json
{
  "session_id": "uuid",
  "response": "clean content without markdown",
  "stats": {
    "models": {
      "gemini-2.5-flash": {
        "tokens": {
          "input": 1965,
          "prompt": 1965,
          "candidates": 57,
          "total": 2166
        }
      }
    }
  }
}
```

## Implementation Phases

### Phase 1: Core Infrastructure (runGeminiCli)

**File**: `src/mcp/gemini-mcp-server.js`

Change `runGeminiCli` to:
1. Use `--output-format json` instead of `text`
2. Parse JSON response
3. Extract `response` field
4. Track token usage from `stats`
5. Return structured result object

```javascript
// Before
const args = ['--model', selectedModel, '--output-format', 'text'];
// ...
resolve(stdout.trim());

// After
const args = ['--model', selectedModel, '--output-format', 'json'];
// ...
const result = JSON.parse(stdout);
const tokenStats = extractTokenStats(result.stats);
updateTokenTracking(tokenStats);
resolve({
  content: result.response,
  tokens: tokenStats,
  sessionId: result.session_id,
  cached: false,
});
```

### Phase 2: Update Tool Handlers

Update handlers to work with new result format:

```javascript
// Before
const response = await runGeminiCli(prompt, options);
return success(response);

// After
const result = await runGeminiCli(prompt, options);
return success(result.content);
```

### Phase 3: JSON Schema Prompts for Code Generation

For `draft_code_implementation`, use JSON output format in prompt:

```javascript
const prompt = `Output valid JSON with this exact schema:
{
  "code": "// your code here",
  "language": "${detectedLang}",
  "imports": ["list of imports needed"],
  "exports": ["list of exports"]
}

TASK: ${task_description}
${contextSection}

CRITICAL: Output ONLY the JSON object. No markdown, no explanation.`;
```

Benefits:
- No markdown stripping needed
- No preamble removal
- Guaranteed structure
- Easy validation

### Phase 4: Structured Code Review

For `gemini_code_review`, return structured issues:

```javascript
const prompt = `Analyze the code and return JSON:
{
  "summary": "brief overview",
  "issues": [
    {
      "severity": "critical|error|warning|info",
      "location": "file:line or snippet",
      "issue": "what's wrong",
      "impact": "why it matters",
      "fix": "how to resolve"
    }
  ],
  "positives": ["what code does well"],
  "metrics": {
    "complexity": "low|medium|high",
    "testCoverage": "yes|no|partial",
    "documentationNeeded": "yes|no|partial"
  }
}`;
```

### Phase 5: Token Usage Tracking

Add global token tracking:

```javascript
const tokenTracker = {
  totalInput: 0,
  totalOutput: 0,
  totalCost: 0,
  byModel: new Map(),

  record(model, inputTokens, outputTokens) {
    this.totalInput += inputTokens;
    this.totalOutput += outputTokens;

    const pricing = MODEL_PRICING[model];
    this.totalCost +=
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;

    // Track per-model
    const modelStats = this.byModel.get(model) || { input: 0, output: 0 };
    modelStats.input += inputTokens;
    modelStats.output += outputTokens;
    this.byModel.set(model, modelStats);
  },

  getStats() {
    return {
      totalInput: this.totalInput,
      totalOutput: this.totalOutput,
      totalCost: this.totalCost,
      byModel: Object.fromEntries(this.byModel),
    };
  }
};
```

## Benefits Summary

| Aspect | Before | After |
|--------|--------|-------|
| Code extraction | Regex gymnastics | Direct JSON field |
| Token tracking | None | Built-in from stats |
| Preamble removal | Fragile heuristics | Not needed |
| Cost estimation | Guessing | Accurate from tokens |
| Response format | Unpredictable | Guaranteed structure |
| Parsing errors | Common | Rare (JSON.parse) |

## Migration Strategy

1. **Backward compatible**: New format behind feature flag initially
2. **Gradual rollout**: One tool at a time
3. **Fallback**: If JSON parse fails, fall back to text extraction
4. **Testing**: Add JSON parsing tests for each tool

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| JSON parse failures | Try-catch with text fallback |
| Large responses truncated | Increase buffer size |
| Gemini returns invalid JSON | Validation + fallback |
| Breaking existing callers | Gradual migration, compat layer |

## Files to Modify

1. `src/mcp/gemini-mcp-server.js` - runGeminiCli function
2. `src/adapters/gemini-cli.js` - runSync method
3. `src/mcp/tool-handlers/code/index.js` - draft_code_implementation
4. `src/mcp/tool-handlers/code/index.js` - gemini_code_review
5. `src/mcp/tool-handlers/research/index.js` - gemini_eval_plan
6. `src/mcp/tool-handlers/content/index.js` - gemini_extract_structured

## Success Metrics

- [x] Token usage visible in `hybrid_metrics` (Completed: tokenTracker + hybrid_metrics update)
- [x] Cost tracking with OAuth detection (FREE for OAuth, calculated for API key)
- [x] All 250 tests passing (16 new tests for token tracking)
- [x] JSON output format enabled (`--output-format json`)
- [x] All tool handlers updated for new result format
- [ ] Zero regex-based code extraction (still uses cleanup for markdown blocks)
- [ ] Code generation success rate > 95% (needs production validation)
