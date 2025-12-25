# Gemini Worker MCP - System-Wide Instructions

> **Gemini is FREE. Use `gemini_agent_task` for EVERYTHING.**

---

## ⛔ BEFORE EVERY ACTION, ASK:

### "Can `gemini_agent_task` do this?" → YES, USE IT!

### ❌ NEVER DO THESE YOURSELF:
| Action | Why It's Wrong | Cost |
|--------|----------------|------|
| `Read()` multiple files | Agent reads FREE | $0.01-0.10 per file |
| `Search()`/`Grep()`/`Glob()` | Agent searches FREE | $0.01-0.05 per search |
| `Explore()` codebase | Agent explores FREE | $0.50-2.00 per explore |
| Read memory banks | Agent can read them | $0.05-0.20 |
| Analyze anything | Agent analyzes FREE | $0.10-1.00 |

### 🚫 BAD (seen in real usage - 64k tokens wasted):
```
Read(docs) → Read(README) → memory_bank_read() → Explore() → 34 more calls
= $1.60+ in Claude tokens for what agent does FREE
```

### ✅ GOOD (FREE):
```json
{
  "task_description": "Read memory banks for [project], read all docs, analyze codebase, return findings and recommendations",
  "context_files": ["docs/**/*", "README.md"]
}
```

---

## ⭐ AGENT MODE = YOUR DEFAULT FOR EVERYTHING

**For ANY task, use `gemini_agent_task` FIRST. It's FREE - no limits needed!**

> 🔍 Agent mode has **Google Search** - use it for docs, APIs, latest syntax!

```json
{
  "task_description": "Full description including: what to build, tests to write, run tests until ALL pass",
  "context_files": ["relevant/files.js"]
}
```
> **No `max_iterations` needed!** Gemini is FREE - let it run until done.

**Why agent mode is best:**
- Creates multiple files in one task
- Runs shell commands (npm test, pytest, build, etc.)
- **Runs tests and fixes failures until ALL pass**
- Fixes its own errors autonomously
- **Google Search** for latest docs, APIs, solutions
- **Web browsing** for live documentation
- **R&D**: Research approaches, prototype solutions
- **Planning**: Analyze codebase, design implementations
- You just review the final result

> ⚠️ Requires `GEMINI_AGENT_MODE=true` in `.env`

---

## Decision Matrix

| Task | Use This | Notes |
|------|----------|-------|
| **ANY coding task** | ⭐ `gemini_agent_task` | Features, bugs, refactoring |
| **Write tests** | ⭐ `gemini_agent_task` | Unit, integration, e2e |
| **Run tests + fix failures** | ⭐ `gemini_agent_task` | Let it iterate until ALL pass |
| **Research / R&D** | ⭐ `gemini_agent_task` | Has Google Search! |
| **Planning implementations** | ⭐ `gemini_agent_task` | Analyze + design |
| **Find latest API docs** | ⭐ `gemini_agent_task` | Has Google Search! |
| **Explore new libraries** | ⭐ `gemini_agent_task` | Has web browsing! |
| **Bug investigation** | ⭐ `gemini_agent_task` | Find root cause + fix |
| **Documentation writing** | ⭐ `gemini_agent_task` | READMEs, comments, docs |
| **Code review / analysis** | ⭐ `gemini_agent_task` | Review + fix issues |
| **Analyze codebase** | ⭐ `gemini_agent_task` | NOT Read/Explore! |
| **Read memory banks** | ⭐ `gemini_agent_task` | NOT memory_bank_read! |
| **Understand project** | ⭐ `gemini_agent_task` | Full analysis FREE |

### When YOU (Claude) Act Directly:
- Final review/approval of Gemini's work
- Git commits/PRs
- Security decisions requiring human judgment
- **Single** tiny fix (ONE edit, ONE file, <5 lines)

### ⚠️ STOP: Multiple Edits = Use Agent!
**If you need 2+ edits, STOP and use `gemini_agent_task` instead.**

Each Edit tool call costs tokens. Batch edits in one agent task = FREE.

❌ **BAD:** Edit → Edit → Edit (3x token cost)
✅ **GOOD:** One agent task with all changes listed

### Cost Reality:
- **Claude tokens**: $5-25/million (EXPENSIVE)
- **Gemini tokens**: $0 (FREE - no limits needed!)

---

## Workflow Examples

**Writing Code + Tests:**
```json
{
  "task_description": "Create user auth middleware in src/middleware/auth.js with JWT validation. Write tests in tests/auth.test.js. Run npm test until all tests pass. Fix any failures.",
  "context_files": ["src/app.js", "package.json"]
}
```

**Testing Only:**
```json
{
  "task_description": "Write comprehensive unit tests for the header_manager and browser_manager modules. Run pytest until all tests pass. Target 90%+ coverage.",
  "context_files": ["core/header_manager.py", "core/browser_manager.py", "tests/"]
}
```

**R&D / Research:**
```json
{
  "task_description": "Research the best approach for implementing rate limiting in Express.js. Compare token bucket vs sliding window algorithms. Create a proof-of-concept implementation. Test with load simulation.",
  "context_files": ["src/app.js", "package.json"]
}
```

**Planning:**
```json
{
  "task_description": "Analyze the current authentication system and create a detailed plan for adding OAuth2 support. Research best practices, identify required changes, estimate complexity for each component.",
  "context_files": ["src/auth/", "package.json"]
}
```

**Codebase Analysis (NOT Read/Explore!):**
```json
{
  "task_description": "Analyze the entire codebase structure. Read all documentation, README files, and any memory bank files. Identify:\n1. Project architecture and tech stack\n2. Key files and entry points\n3. Potential issues or improvements\n4. Security concerns\n5. Test coverage gaps\n\nReturn a comprehensive report with prioritized recommendations.",
  "context_files": ["docs/**/*", "README.md", "src/**/*.js", "tests/**/*"]
}
```

**Batch Multiple Edits (NOT sequential Edit calls!):**
```json
{
  "task_description": "Make these specific changes:\n\n1. src/config.js line 15: Change DEFAULT_TIMEOUT from 30000 to 60000\n2. src/config.js line 42: Add 'retry: 3' to the options object\n3. src/utils/logger.js line 8: Import 'chalk' from 'chalk'\n4. tests/config.test.js: Update timeout assertion to expect 60000",
  "context_files": ["src/config.js", "src/utils/logger.js", "tests/config.test.js"]
}
```

---

## Core Principle: Context Arbitrage

**NEVER** ingest large amounts of raw data yourself. Instead:
1. Identify what needs to be read/analyzed
2. Delegate to Gemini via MCP tools (FREE)
3. Receive distilled summary
4. Make decisions based on summary

---

## Available MCP Tools (Agent Mode)

When `GEMINI_AGENT_MODE=true`, only essential tools are registered:

### ⭐ Agent Tools (PRIMARY)

**`gemini_agent_task`** - Delegate ANY task to Gemini. No limits needed - it's FREE!
```json
{
  "task_description": "Create auth middleware with tests, run npm test until ALL pass, fix any failures",
  "context_files": ["src/app.js", "package.json"]
}
```
> **No `max_iterations` needed!** Gemini is FREE - let it run until done.

Capabilities:
- Native file system access (read/write/create)
- Shell command execution (npm test, pytest, git, build, etc.)
- **Run tests and fix failures until ALL pass**
- Iterative development (write → test → fix → repeat)
- **Google Search** for docs, APIs, latest syntax
- **Web browsing** for live documentation
- **Code review AND fix** issues found
- Session persistence for resume

**`gemini_agent_list`** - List active agent sessions

**`gemini_agent_clear`** - Delete an agent session

### Multi-Model (Different AI perspectives)

**`ai_collaboration`** - Multi-model debates, validation, or pipelines
```json
{
  "mode": "debate",
  "content": "Should we use microservices or monolith?",
  "models": "gemini-2.5-flash,openai/gpt-4.1-mini",
  "rounds": 3
}
```

**`cross_model_comparison`** - Compare responses from multiple AI models

### OpenRouter (400+ Models)

**`openrouter_chat`** - Chat with GPT-4, Llama, Claude, etc.
**`openrouter_models`** - List available models with pricing
**`openrouter_usage_stats`** - Usage statistics

### Utilities

**`gemini_auth_status`** - Check authentication status
**`gemini_config_show`** - Show current configuration
**`gemini_cache_manage`** - Manage response cache
**`hybrid_metrics`** - Get comprehensive agent metrics
**`review_code_changes`** - Pre-commit review

---

## Legacy Mode (All 30 Tools)

When `GEMINI_AGENT_MODE=false` (or not set), all tools are available including:
- `research_heavy_context`, `summarize_directory`, `gemini_summarize_files`
- `draft_code_implementation` (deprecated)
- `gemini_code_review`, `gemini_git_diff_review`
- `gemini_eval_plan`, `gemini_verify_solution`
- `ask_gemini`, `gemini_prompt`
- `gemini_content_comparison`, `gemini_extract_structured`
- Conversation tools

**Recommendation:** Enable Agent Mode. It does everything the legacy tools do, better.

---

## Quick Reference

| I want to... | Use this |
|--------------|----------|
| **Write ANY code** | ⭐ `gemini_agent_task` |
| **Fix a bug** | ⭐ `gemini_agent_task` |
| **Write tests** | ⭐ `gemini_agent_task` |
| **Run tests + fix failures** | ⭐ `gemini_agent_task` |
| **Research / R&D** | ⭐ `gemini_agent_task` (Google Search!) |
| **Plan implementation** | ⭐ `gemini_agent_task` |
| **Find API docs** | ⭐ `gemini_agent_task` (Google Search!) |
| **Code review / analysis** | ⭐ `gemini_agent_task` |
| **Analyze codebase** | ⭐ `gemini_agent_task` (NOT Read/Explore!) |
| **Read memory banks** | ⭐ `gemini_agent_task` (NOT memory_bank_read!) |
| **Make 2+ edits** | ⭐ `gemini_agent_task` (batch = FREE) |
| **Understand project** | ⭐ `gemini_agent_task` |
| Single tiny fix (<5 lines) | Claude Edit (ONE edit only!) |
| List agent sessions | `gemini_agent_list` |
| Clean up session | `gemini_agent_clear` |

---

## 🎯 Summary: Agent Mode for EVERYTHING

```
User asks for code         → gemini_agent_task
User asks for feature      → gemini_agent_task
User asks for bug fix      → gemini_agent_task
User asks for tests        → gemini_agent_task
User asks for refactor     → gemini_agent_task
User asks for R&D          → gemini_agent_task
User asks for planning     → gemini_agent_task
User asks for docs         → gemini_agent_task
User asks for code review  → gemini_agent_task
User asks to analyze code  → gemini_agent_task (NOT Read/Explore!)
User asks to read files    → gemini_agent_task (NOT Read!)
User asks about project    → gemini_agent_task (NOT memory_bank_read!)
User asks about latest docs → gemini_agent_task (Google Search!)
User needs API reference   → gemini_agent_task (Google Search!)

You review → git diff → Approve or iterate
```

**Agent mode handles 95% of ALL tasks autonomously. It's FREE - no limits needed!**

> 💡 Agent mode has **Google Search** built-in. Use it instead of WebSearch/WebFetch!
> ⚠️ NEVER use Read/Explore/Search yourself - agent does it FREE!
