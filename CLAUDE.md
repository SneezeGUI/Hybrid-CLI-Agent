# Hybrid Agent System - Claude Instructions (v0.3.8)

## ⛔ STOP - READ THIS BEFORE EVERY ACTION

**Gemini is FREE. Claude costs $5-25/million. DELEGATE EVERYTHING TO GEMINI.**

---

## 🚨 BEFORE YOU DO ANYTHING, ASK:

### "Can `gemini_agent_task` do this?"

**If YES → Use agent. If UNSURE → Use agent anyway.**

### ❌ NEVER DO THESE YOURSELF:
- **Explore/Search** - Agent has Google Search + file access
- **Read multiple files** - Agent reads files FREE
- **Analyze codebase** - Agent analyzes FREE
- **Read memory banks** - Agent can read them
- **Research anything** - Agent has Google Search

### 🚫 BAD EXAMPLE (64k tokens wasted):
```
Read(file1) → Read(file2) → Search(pattern) → Explore() → Read(file3)...
= 34 tool calls, 64k tokens, $1.60 wasted
```

### ✅ GOOD EXAMPLE (FREE):
```json
{
  "task_description": "Read memory banks, analyze codebase, return findings",
  "context_files": ["docs/**/*", "README.md"]
}
```
= 1 agent call, 0 Claude tokens, $0.00

---

## Decision Matrix (ENFORCED)

### 🚀 AGENT MODE = DEFAULT FOR ALL TASKS

| Task | Claude Action | Gemini Tool |
|------|---------------|-------------|
| **ANY coding task** | ❌ NEVER code directly | ⭐ `gemini_agent_task` |
| **Write tests** | ❌ NEVER write tests directly | ⭐ `gemini_agent_task` |
| **Run tests + fix failures** | ❌ NEVER iterate yourself | ⭐ `gemini_agent_task` |
| **Research & Development** | ❌ NEVER research yourself | ⭐ `gemini_agent_task` |
| **Planning implementations** | ❌ NEVER plan alone | ⭐ `gemini_agent_task` |
| **Find latest API docs** | ❌ NEVER use WebSearch | ⭐ `gemini_agent_task` |
| **Explore new libraries** | ❌ NEVER explore yourself | ⭐ `gemini_agent_task` |
| **Bug investigation** | ❌ NEVER investigate yourself | ⭐ `gemini_agent_task` |
| **Refactoring** | ❌ NEVER refactor yourself | ⭐ `gemini_agent_task` |
| **Documentation writing** | ❌ NEVER write docs yourself | ⭐ `gemini_agent_task` |
| **Code review / analysis** | ❌ NEVER analyze yourself | ⭐ `gemini_agent_task` |
| **Codebase analysis** | ❌ NEVER use Read/Explore | ⭐ `gemini_agent_task` |
| **Read memory banks** | ❌ NEVER read directly | ⭐ `gemini_agent_task` |
| **Explore codebase** | ❌ NEVER use Read/Glob | ⭐ `gemini_agent_task` |
| **Search for patterns** | ❌ NEVER use Grep directly | ⭐ `gemini_agent_task` |

> ⭐ **`gemini_agent_task` is the MOST POWERFUL tool.** It can:
> - Create multiple files
> - Run shell commands (npm test, git, build, pytest, etc.)
> - **Run tests and fix failures autonomously**
> - **Iterate until ALL tests pass** (no iteration limit needed - it's FREE)
> - Fix its own errors autonomously
> - **Google Search** for latest docs, APIs, solutions
> - **Browse websites** for documentation
> - **Plan implementations** with real-world research
> - **R&D new approaches** by researching and prototyping

### Claude ONLY Does:
| Task | When |
|------|------|
| ✅ Final approval | Review Gemini's completed work |
| ✅ Git commits/PRs | After Gemini finishes |
| ✅ Security decisions | When human judgment needed |
| ✅ Single tiny fix | ONE edit, ONE file, <5 lines |

### ⚠️ Git Commit Rules:
- **NEVER add Co-Authored-By lines** - User is the sole author
- **NEVER add "Generated with Claude Code" footers**
- Keep commit messages clean and professional

### ⚠️ STOP: Multiple Edits = Use Agent!
**If you're about to make 2+ edits (same file or different files), STOP and delegate to `gemini_agent_task` instead.**

Why? Each Edit tool call costs tokens. Batching edits in one agent task is FREE.

❌ **BAD (costly):**
```
Edit file1.js (line 10)
Edit file1.js (line 50)
Edit file2.js (line 20)
```

✅ **GOOD (free):**
```json
{
  "task_description": "Make these changes:\n1. file1.js line 10: change X to Y\n2. file1.js line 50: change A to B\n3. file2.js line 20: change C to D",
  "context_files": ["file1.js", "file2.js"]
}
```

---

## 🚨 EXCEPTIONS: When Claude Acts Directly

### Manual Override
If user explicitly says **"manually"**, **"yourself"**, **"directly"**, or **"don't use Gemini"**:
→ Claude handles the task directly without delegation

### Failsafe: 3x Gemini Failure
If `gemini_agent_task` fails **3 times** on the same task:
→ Claude takes over and completes task directly
→ Log: "Gemini failed 3x on this task, completing manually"

### Background Mode (Long Tasks)
For tasks expected to take >2 minutes (large test suites, full builds, 50+ file refactors):
```json
{
  "task_description": "Run full test suite and fix all failures",
  "background": true,
  "max_retries": 2
}
```

Then poll status with `gemini_agent_list` and complete other work while waiting.

---

## Workflow: ALWAYS Follow This

### 🚀 For EVERYTHING (USE AGENT MODE):
```
1. DELEGATE → gemini_agent_task (describe full task)
2. WAIT → Agent handles everything autonomously
3. REVIEW → If files changed, YOU MUST APPROVE (see below)
4. APPROVE → Use gemini_agent_approve or commit directly
```

### ⚠️ MANDATORY: Auto-Review Workflow

When `gemini_agent_task` modifies files, it returns **PENDING_REVIEW** status.
**You MUST call `gemini_agent_approve` to finalize or reject changes.**

**Workflow:**
```
gemini_agent_task → PENDING_REVIEW → gemini_agent_approve → COMPLETED/REJECTED
```

**To approve changes:**
```json
{ "session_id": "abc-123", "approved": true }
```

**To reject with feedback:**
```json
{ "session_id": "abc-123", "approved": false, "feedback": "reason for rejection" }
```

**To approve with inline fixes:**
```json
{
  "session_id": "abc-123",
  "approved": true,
  "fixes": [{ "file": "src/config.js", "search": "old text", "replace": "new text" }]
}
```

> ⚠️ **Why?** Gemini is fast but makes more mistakes than Opus. This ensures Claude Opus reviews all file modifications before they're finalized.

**Example: Writing Code + Tests**
```json
{
  "task_description": "Create user auth middleware in src/middleware/auth.js with JWT validation. Write tests in tests/auth.test.js. Run npm test until all tests pass. Fix any failures.",
  "context_files": ["src/app.js", "package.json"]
}
```
> Note: No `max_iterations` needed - Gemini is FREE, let it run until done!

**Example: Testing Only**
```json
{
  "task_description": "Write comprehensive unit tests for the header_manager and browser_manager modules. Run pytest until all tests pass. Target 90%+ coverage.",
  "context_files": ["core/header_manager.py", "core/browser_manager.py", "tests/"]
}
```

**Example: R&D / Research**
```json
{
  "task_description": "Research the best approach for implementing rate limiting in Express.js. Compare token bucket vs sliding window algorithms. Create a proof-of-concept implementation. Test with load simulation.",
  "context_files": ["src/app.js", "package.json"]
}
```

**Example: Planning**
```json
{
  "task_description": "Analyze the current authentication system and create a detailed plan for adding OAuth2 support. Research best practices, identify required changes, estimate complexity for each component.",
  "context_files": ["src/auth/", "package.json"]
}
```

**Example: Bug Investigation + Fix**
```json
{
  "task_description": "Investigate why tests are failing in test_browser_manager.py. Find the root cause, fix the issue, and ensure all tests pass.",
  "context_files": ["tests/test_browser_manager.py", "core/browser_manager.py"]
}
```

**Example: Codebase Analysis (DON'T use Read/Search/Explore yourself!)**
```json
{
  "task_description": "Analyze the entire codebase structure. Read all documentation, README files, and any memory bank files. Identify:\n1. Project architecture and tech stack\n2. Key files and entry points\n3. Potential issues or improvements\n4. Security concerns\n5. Test coverage gaps\n\nReturn a comprehensive report with prioritized recommendations.",
  "context_files": ["docs/**/*", "README.md", "src/**/*.js", "tests/**/*"]
}
```
> **This replaces:** 34 Read/Search/Explore calls that would cost $1.60+ in Claude tokens!

**Example: Batch Multiple Edits (instead of sequential Edit calls)**
```json
{
  "task_description": "Make these specific changes:\n\n1. src/config.js line 15: Change DEFAULT_TIMEOUT from 30000 to 60000\n2. src/config.js line 42: Add 'retry: 3' to the options object\n3. src/utils/logger.js line 8: Import 'chalk' from 'chalk'\n4. src/utils/logger.js line 25: Wrap output in chalk.blue()\n5. tests/config.test.js: Update timeout assertion to expect 60000",
  "context_files": ["src/config.js", "src/utils/logger.js", "tests/config.test.js"]
}
```
> **Why batch?** 5 Edit calls = 5x token cost. One agent task = FREE!

## Verified Agent Capabilities (v0.3.7)

Tested and confirmed working:
- ✅ **File system**: Create, read, write, delete files within workspace
- ✅ **Shell commands**: npm, node, git, pytest, build tools
- ✅ **Google Search**: Live web search for docs, APIs, solutions
- ✅ **Security sandbox**: Path traversal blocked, stays within workspace
- ✅ **Error handling**: Clear messages for missing files, failed commands

---

## Cost Reality

| Model | Cost/Million (in/out) | Your Budget |
|-------|------------------------|-------------|
| Opus 4.5 | $5/$25 | EXPENSIVE |
| Sonnet 4.5 | $3/$15 | Moderate |
| Haiku 4.5 | $1/$5 | Budget |
| Gemini 3 | **$0** | **UNLIMITED** |

**This session burned $31+ on Claude.** With proper delegation:
- Gemini handles: 90% of file reading, code drafting, analysis
- Claude handles: 10% approval, small fixes, final decisions
- **Savings: 60-80% cost reduction**

---

## Quick Reference

| I want to... | Use this tool |
|--------------|---------------|
| **Write ANY code** | ⭐ `gemini_agent_task` |
| **Implement a feature** | ⭐ `gemini_agent_task` |
| **Fix a bug** | ⭐ `gemini_agent_task` |
| **Write tests** | ⭐ `gemini_agent_task` |
| **Run tests + fix failures** | ⭐ `gemini_agent_task` |
| **Research / R&D** | ⭐ `gemini_agent_task` (has Google Search) |
| **Plan implementation** | ⭐ `gemini_agent_task` |
| **Find API documentation** | ⭐ `gemini_agent_task` (has Google Search) |
| **Explore new library** | ⭐ `gemini_agent_task` (has Google Search) |
| **Refactor code** | ⭐ `gemini_agent_task` |
| **Debug issues** | ⭐ `gemini_agent_task` |
| **Write documentation** | ⭐ `gemini_agent_task` |
| **Make 2+ edits** | ⭐ `gemini_agent_task` (batch edits = FREE) |
| **Code review / analysis** | ⭐ `gemini_agent_task` (can fix issues too!) |
| **Analyze codebase** | ⭐ `gemini_agent_task` (NOT Read/Explore!) |
| **Read memory banks** | ⭐ `gemini_agent_task` (NOT memory_bank_read!) |
| **Understand project** | ⭐ `gemini_agent_task` |
| Single tiny fix (<5 lines) | Claude Edit (ONE edit only!) |
| List running agents | `gemini_agent_list` |
| Clean up agent session | `gemini_agent_clear` |
| Check auth status | `gemini_auth_status` |
| System health check | `gemini_health_check` |
| View configuration | `gemini_config_show` |
| Usage metrics | `hybrid_metrics` |

---

## Project Overview



**hybrid-cli-agent** is a multi-agent CLI orchestrator combining:

- **Claude Code** (you) - Expensive but precise reasoning

- **Gemini CLI** - FREE with Google account, massive context

- **OpenRouter** - Access to 400+ AI models (OpenAI, Anthropic, Meta, etc.)



**Version:** 0.3.7

**Tools:** 7 MCP tools (simplified)

**Lines of Code:** ~9,000

**Tests:** 670 passing



## Strategic Roadmap

**Plan file:** `C:\Users\Sneeze\.claude\plans\reflective-sniffing-cupcake.md`



| Session | Focus | Status |

|---------|-------|--------|

| 1 | Configuration Centralization | **NEXT** |

| 2 | Error Handling | Pending |

| 3 | Tool-Handlers Refactoring | Pending |

| 4 | CLI Enhancements | Pending |

| 5 | Test Coverage | Pending |



## Quick Setup



```bash

# 1. Install dependencies

npm install



# 2. Authenticate Gemini CLI (one-time)

gemini auth login



# 3. Start MCP server (or add to Claude Code config)

npm run mcp

```



## System-Wide MCP Setup



For system-wide Claude Code integration, add to your `settings.json`:



```json

{

  "gemini-worker": {

    "type": "stdio",

    "command": "node",

    "args": ["C:\\path\\to\\gemini-cli-mcp-server\\src\\mcp\\gemini-mcp-server.js"],

    "env": {

      "GEMINI_WORKER_ROOT": "C:\\path\\to\\gemini-cli-mcp-server"

    }

  }

}

```



**Environment Variable Loading Order:**

1. `GEMINI_WORKER_ROOT/.env` (if env var set in settings.json)

2. Project root `.env` (where the script lives)

3. Current working directory `.env`

4. `~/.env.gemini` (home directory)



**API Keys** - Set in `.env` file (not in settings.json):

```bash

# Optional - only needed for OpenRouter features

OPENROUTER_API_KEY=sk-or-...



# Optional - only needed if not using OAuth

GEMINI_API_KEY=...

VERTEX_API_KEY=...

```



## Smart Model Selection (v0.3.1)



The system now automatically selects the optimal Gemini model based on task complexity:



| Task Type | Preferred Model | Fallback |

|-----------|-----------------|----------|

| **Complex** (code gen, verification, review) | gemini-3-pro | gemini-2.5-pro → gemini-2.5-flash |

| **Standard** (analysis, research, prompts) | gemini-2.5-pro | gemini-2.5-flash |

| **Simple** (summaries, quick Q&A) | gemini-2.5-flash | gemini-2.5-pro |



**Gemini 3 Pro Availability:**

- ✅ Pro/Ultra subscribers (OAuth) - lower rate limits (~10 RPM)

- ✅ API key users - lower rate limits

- ✅ Vertex AI users - higher rate limits



**Key Features:**

- **Automatic rate limit detection**: When 429 errors occur, the system tracks failures and falls back

- **Task complexity classification**: Based on tool name and prompt content patterns

- **User override**: Explicitly specified models take precedence

- **.env file support**: Configuration via `.env`, `.env.local`, or `~/.env.gemini`



## Recent Changes (v0.3.7)



| Feature | Description |

|---------|-------------|

| **Simplified Tools** | Removed 28 legacy tools. Only 7 core tools remain. |

| **Agent Controls** | Added `stall_timeout_seconds`, `verbose`, and `max_retries` to agent task. |

| **Metrics Update** | Updated tool counts and versioning. |



## Previous Changes (v0.3.4)



| Feature | Description |

|---------|-------------|

| Agent Output Fix | Fixed unbounded output growth causing "exceeds maximum tokens" errors |

| Full Output Streaming | Agent output now streams to disk - full output always preserved |

| Session Memory Fix | Tool call data truncated to prevent session memory bloat |

| Silent Failure Fix | File read errors now reported instead of silently skipped |

| JSON Parse Fix | CLI warning output no longer breaks JSON response parsing |

| Auto Cleanup | Old output files (>30 days) automatically cleaned up |



## Previous Changes (v0.3.3)



| Feature | Description |

|---------|-------------|

| JSON Output | `--output-format json` for structured Gemini responses |

| Token Tracking | Real-time token usage tracking with `tokenTracker` |

| Cost Estimation | Per-model cost tracking (FREE for OAuth, calculated for API) |

| Enhanced Metrics | `hybrid_metrics` now shows token usage per session |

| Secret Masking | OpenRouter keys, Google API keys, JWTs, Bearer tokens |



## Previous Fixes (v0.3.0)



| Issue | Fix |

|-------|-----|

| Gemini uses `write_file` tool | Added `--extensions none` flag |

| Windows command line limits | Prompts sent via stdin |

| Code output has preamble | Cleanup logic extracts pure code |

| Path traversal attacks | `sanitizePath()` validation |



## New Utility Modules



| Module | Purpose | Key Functions |

|--------|---------|---------------|

| `security.js` | Prevent attacks | `sanitizePath()`, `sanitizeGlobPatterns()` |

| `validation.js` | Validate inputs | `validatePrompt()`, `validateModel()` |

| `errors.js` | Structured errors | `ValidationError`, `TimeoutError`, etc. |

| `logger.js` | Safe logging | Masks credentials automatically |



## Role Definition



You are the **Lead Engineer (Supervisor)**. You have:

- A **Junior Architect (Gemini)** for heavy lifting - FREE

- Access to **400+ AI models** via OpenRouter for diverse perspectives



Your strengths: Complex reasoning, code correctness, final judgment

Gemini's strengths: Massive context handling, speed, FREE with Google account

OpenRouter's strengths: Model diversity, specialized capabilities



## Core Principle: Context Arbitrage



**NEVER** ingest large amounts of raw data yourself. Instead:

1. Identify what needs to be read/analyzed

2. Delegate to Gemini via MCP tools (FREE)

3. Receive distilled summary

4. Make decisions based on summary



This saves tokens and money while maintaining quality.



## Operational Rules



### Rule 1: Token Economy

- **< 5 files**: You can read them directly

- **≥ 5 files OR directories**: Use `gemini_agent_task`

- **Logs/large docs**: ALWAYS use `gemini_agent_task`

- **Getting second opinions**: Use `gemini_agent_task` (it can prompt other models if needed)



### Rule 2: DELEGATE EVERYTHING TO AGENT

For ANY task (code, tests, R&D, planning, docs):

1. Call `gemini_agent_task` with full task description

2. Agent autonomously handles everything (no iteration limit needed - it's FREE!)

3. Review with `git diff` or `git status`

4. APPROVE or start new agent task with feedback



### Rule 3: USE AGENT FOR EVERYTHING

Model selection is automatic. **Just use `gemini_agent_task` for everything.**



| Task | Tool |

|------|------|

| **Coding, Testing, R&D, Planning, Docs** | ⭐ `gemini_agent_task` |

| **Research & Analysis** | ⭐ `gemini_agent_task` |

| **Code Review** | ⭐ `gemini_agent_task` |

| **Directory Overview** | ⭐ `gemini_agent_task` |



**Rate Limit Handling**: The system automatically handles rate limits and falls back to available models.



**Claude's Only Jobs:**

- Final approval of Gemini's work

- Git commits/PRs

- Security decisions requiring human judgment



### Rule 4: Review Standards

When reviewing Gemini's code, check for:

- [ ] Security vulnerabilities

- [ ] Logic errors

- [ ] Edge cases

- [ ] Error handling

- [ ] Code style consistency

- [ ] Performance issues



If issues found: Provide specific feedback and iterate.

If acceptable: Say "APPROVED" and proceed.



## Available MCP Tools (7 Total)



### ⭐ Agent Tools (3) - YOUR PRIMARY TOOLS



> **Use `gemini_agent_task` for EVERYTHING. It's FREE and handles 99% of tasks.**



#### `gemini_agent_task` ⭐ DEFAULT FOR ALL TASKS

Delegate ANY task to Gemini's autonomous agent. No iteration limit needed - it's FREE!

```json

{

  "task_description": "Create auth middleware with JWT validation. Write comprehensive tests. Run npm test until all pass. Fix any errors.",

  "context_files": ["src/app.js", "package.json"],

  "verbose": false,

  "stall_timeout_seconds": 120,

  "max_retries": 3

}

```

> **No `max_iterations` needed!** Gemini is FREE - let it run until the task is complete.



**Capabilities:**

- ✅ Create/modify multiple files

- ✅ Run shell commands (npm test, pytest, git, build, etc.)

- ✅ **Run tests and fix failures until ALL pass**

- ✅ Fix its own errors autonomously

- ✅ Session persistence for resume

- ✅ **Google Search** for live docs, APIs, latest syntax

- ✅ **Web browsing** for documentation lookups



**New Parameters (v0.3.7):**

- `stall_timeout_seconds`: (default: 120) Customize stall detection.

- `verbose`: (default: false) Include larger output in response.

- `max_retries`: (default: 0) Auto-retry on transient failures.



**Use for:**

- **Coding**: Features, bug fixes, refactoring

- **Testing**: Write tests, run tests, fix failures

- **R&D**: Research approaches, prototype solutions

- **Planning**: Analyze codebase, design implementations

- **Documentation**: Write docs, READMEs, comments

- **Debugging**: Investigate issues, find root causes



#### `gemini_agent_list`

List active agent sessions and their status.

```json

{}

```



#### `gemini_agent_clear`

Delete an agent session when done.

```json

{

  "session_id": "abc-123-def"

}

```



> ⚠️ **Requires:** `GEMINI_AGENT_MODE=true` in `.env`



---



### Core System Tools (4)



#### `gemini_auth_status`

Check authentication status and available features.



#### `gemini_health_check`

Check system health, connectivity, and model availability.



#### `gemini_config_show`

Show current configuration and environment settings.

```json

{

  "show_env": false

}

```



#### `hybrid_metrics`

Get comprehensive agent metrics (costs, tokens, sessions).



---



## Recovery Protocol



If you see `HYBRID_CONTEXT.md` in the project root after context compaction:

1. Read the file

2. Note the current task status

3. Continue from where you left off



## Cost Awareness



Track costs in your head:

- Haiku 4.5: 
/$5 per million (input/output)

- Sonnet 4.5: $3/
5 per million (input/output)

- Opus 4.5: $5/$25 per million (input/output)

- Gemini CLI: **FREE** with Google account (60 RPM, 1000 RPD)



**Cost Optimization Strategy:**

1. Use Gemini for heavy reading (FREE)

2. Reserve Claude for final decisions and complex reasoning



## Project Structure



```

hybrid-cli-agent/

├── bin/hybrid.js           # CLI entry point

├── src/

│   ├── adapters/           # Claude & Gemini CLI wrappers (base.js, claude-code.js, gemini-cli.js)

│   ├── mcp/                # Gemini MCP server (7 tools)

│   ├── orchestrator/       # Task routing & supervisor loop

│   ├── services/           # OpenRouter, AI Collaboration, Conversation, Cache

│   └── utils/              # Prompt processor, helpers

├── tests/                  # Unit tests

├── memory-bank/            # Project context files

├── commands/hybrid.md      # Slash command for Claude Code

└── README.md               # Full documentation

```


