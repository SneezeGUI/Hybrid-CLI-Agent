# 🔄 Hybrid Agent Context Refresh

> **Run `/hybrid` anytime to remind yourself of your FREE tools.**

---

## ⚡ YOU HAVE FREE GEMINI TOOLS - USE THEM

**Your tokens cost ~$15/million. Gemini is FREE.**

### 🚨 STOP and use Gemini when:

| Situation | Tool | Example |
|-----------|------|---------|
| Reading 5+ files | `research_heavy_context` | "Find bugs in src/**/*.py" |
| Writing >20 lines | `draft_code_implementation` | "Create auth middleware" |
| New codebase | `summarize_directory` | Understand project structure |
| Code review | `gemini_code_review` | Security/performance audit |
| Second opinion | `ask_gemini` | Quick questions |
| Before coding | `gemini_eval_plan` | Validate your approach |

### ✅ YOU handle directly:
- Reading 1-4 specific files
- Small edits (<20 lines)
- Final approval of Gemini's work
- Complex reasoning / judgment calls
- Security-critical decisions

---

## Quick Reference

```javascript
// Heavy file analysis (FREE)
research_heavy_context({
  query: "Find authentication vulnerabilities",
  file_patterns: ["src/**/*.ts"]
})

// Code generation (FREE)
draft_code_implementation({
  task_description: "Create REST API for users",
  target_file: "src/api/users.ts"
})

// Quick questions (FREE)
ask_gemini({
  question: "Best practices for rate limiting?"
})

// Directory overview (FREE)
summarize_directory({
  directory: "legacy_module/"
})
```

---

## Current Task: $ARGUMENTS

**Decision tree:**
1. Is this heavy reading (5+ files, logs, docs)? → `research_heavy_context`
2. Is this significant code generation? → `draft_code_implementation`
3. Is this exploring unknown code? → `summarize_directory`
4. Is this a quick question? → `ask_gemini`
5. Only if none of the above → Do it yourself

**Now proceed with the task, using Gemini tools where appropriate.**
