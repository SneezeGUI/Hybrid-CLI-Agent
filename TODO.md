# Hybrid CLI Agent - TODO & Progress Tracker

## Project Status: v0.3.4 - Beta

**Last Updated:** December 2024
**Lines of Code:** ~8,500
**MCP Tools:** 27
**Test Coverage:** 430 tests passing (14 test files)

---

## 🚀 Quick Start

### Prerequisites
1. **Node.js 20+** - `node --version`
2. **Gemini CLI** - Install from [Google](https://github.com/anthropics/claude-code)
3. **Google Account** with Gemini Pro subscription (for FREE 60 RPM access)

### Installation (3 Steps)

```bash
# 1. Clone and install
git clone <repo-url>
cd hybrid-cli-agent
npm install

# 2. Authenticate Gemini CLI (one-time)
gemini auth login

# 3. Add to Claude Code's MCP servers
```

Add to your Claude Code settings (`~/.claude.json` or `settings.json`):

```json
{
  "mcpServers": {
    "gemini-worker": {
      "command": "node",
      "args": ["<full-path>/src/mcp/gemini-mcp-server.js"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-..."
      }
    }
  }
}
```

### Verify Installation
```bash
# Test MCP server starts
npm run mcp

# Run tests
npm test
```

### Key Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Optional | For 400+ model access via OpenRouter |
| `GEMINI_API_KEY` | Optional | Alternative to OAuth (less features) |
| `GEMINI_AGENT_MODE` | Optional | Set `true` to enable Gemini tool usage |
| `VERTEX_API_KEY` | Optional | For Gemini 3 Pro access (Vertex AI) |

### Configuration Files
The server supports multiple configuration sources:
1. **System environment variables** (highest priority)
2. **`.env`** file in working directory
3. **`.env.local`** file in working directory
4. **`~/.env.gemini`** file in home directory

### Troubleshooting
- **"extensions" error**: Fixed in v0.3.0 with `--extensions none` flag
- **"write_file" error**: Gemini trying to use tools - ensure MCP server restarted
- **Rate limits**: OAuth gives 60 RPM FREE, automatic fallback to other models
- **Model selection**: Smart routing automatically picks best available model

---

## ✅ Completed

### Phase 1: Core Infrastructure
- [x] Project scaffolding with ES modules
- [x] Package.json with proper dependencies
- [x] Base adapter class with interface definition
- [x] Claude Code adapter with stream-json output parsing
- [x] Gemini CLI adapter with multi-auth support
- [x] Orchestrator with task routing logic
- [x] Cost tracking across adapters
- [x] Unit tests for adapters (23 tests)
- [x] Unit tests for orchestrator (10 tests)
- [x] Create memory banks (projectbrief, productContext, systemPatterns, techContext, activeContext)

### Phase 2: MCP Server
- [x] Basic MCP server setup with FastMCP pattern
- [x] `gemini_auth_status` tool
- [x] `research_heavy_context` tool
- [x] `draft_code_implementation` tool
- [x] `ask_gemini` tool
- [x] `summarize_directory` tool
- [x] `review_code_changes` tool

### Phase 3: Authentication Enhancement
- [x] OAuth authentication (gemini auth login)
- [x] API key authentication (GEMINI_API_KEY)
- [x] Vertex AI authentication (VERTEX_API_KEY)
- [x] Pro subscription detection
- [x] FREE tier identification
- [x] `checkAuth()` method
- [x] `getAuthInfo()` method
- [x] `buildEnv()` for credential passing

### Phase 4: Expanded Tooling (Inspired by gemini-cli-mcp-server)
- [x] `gemini_prompt` with @filename syntax
- [x] `gemini_eval_plan` - Plan evaluation
- [x] `gemini_verify_solution` - Solution verification
- [x] `gemini_code_review` - Structured code review
- [x] `gemini_git_diff_review` - Git diff analysis
- [x] `ai_collaboration` - Multi-model collaboration
- [x] `cross_model_comparison` - Model comparison

### Phase 5: OpenRouter Integration
- [x] OpenRouter client with 400+ models
- [x] `openrouter_chat` tool
- [x] `openrouter_models` tool
- [x] `openrouter_usage_stats` tool
- [x] Cost tracking per model
- [x] Popular models reference

### Phase 6: AI Collaboration Engine
- [x] Collaboration modes: debate, validation, sequential
- [x] Debate styles: constructive, adversarial, socratic, etc.
- [x] Consensus methods for validation
- [x] Sequential pipeline support
- [x] Multi-model orchestration

### Documentation
- [x] README.md with full documentation
- [x] CLAUDE.md steering file
- [x] .env.example with auth setup
- [x] /commands/hybrid.md slash command
- [x] TODO.md progress tracker

### Phase 7: Quality & Security Hardening (Dec 2024)
- [x] Input validation module (`src/utils/validation.js`)
- [x] Structured error classes (`src/utils/errors.js`)
- [x] Logging framework (`src/utils/logger.js`)
- [x] Security utilities (`src/utils/security.js`)
- [x] Sandbox mode for Gemini CLI (prevents tool hallucination)
- [x] Expanded test coverage (225 tests)

### Phase 8: Smart Model Selection (Dec 2024)
- [x] Model capabilities configuration (`MODEL_CAPABILITIES`)
- [x] Task complexity classification (`TASK_TYPES`)
- [x] Smart model routing (`getSmartModel()`)
- [x] Rate limit tracking and automatic fallback
- [x] `.env` file support (`.env`, `.env.local`, `~/.env.gemini`)
- [x] Updated `gemini_config_show` with model status
- [x] Gemini 3 Pro support for Vertex AI users

### Phase 9: Refactoring Sessions (Dec 2024) ✅ ALL COMPLETE
Six comprehensive refactoring sessions completed:

| Session | Focus | Tests Added | Key Deliverable |
|---------|-------|-------------|-----------------|
| 1 | Configuration Centralization | +26 | `src/config/` module (4 files) |
| 2 | Error Handling | +0 | Try-catch in 15 handlers |
| 3 | Tool-Handlers Refactoring | +26 | 4 shared utilities in base.js |
| 4 | CLI Enhancements | +0 | EventEmitter, progress, summary |
| 5 | Test Coverage | +102 | 3 service test files |
| 6 | Orchestrator Tests | +26 | Full orchestrator coverage |

**Total Test Growth:** 250 → 430 tests (+180)

Key improvements:
- [x] Centralized configuration in `src/config/` (50+ values)
- [x] Error handling coverage: ~7% → ~63%
- [x] Shared utilities: `runGitDiff()`, `fetchWithTimeout()`, `cleanCodeOutput()`, `withHandler()`
- [x] Orchestrator extends EventEmitter for progress events
- [x] CLI operation summary after draft/review
- [x] Dependency injection in orchestrator for testability
- [x] Comprehensive service tests (ResponseCache, ConversationManager, OpenRouterClient)

---

## 🔄 In Progress

### Testing & Quality
- [ ] Integration tests for MCP tools
- [ ] End-to-end tests with mock CLIs
- [ ] Error handling edge cases
- [x] Fix file structure inconsistency (Issue #8)
- [x] Add git availability check (Issue #22)
- [x] Disable/defer OpenRouter collaboration (Issue #19)

---

## 📋 Codebase Analysis Report (Dec 2025)

I've completed a comprehensive analysis of the hybrid-cli-agent codebase. Here are the issues organized by severity:

🔴 CRITICAL ISSUES (All Resolved)
1. ✅ [RESOLVED] Command Injection Vulnerability
   - Fix: Added sanitizeGlobPatterns() and validateDirectory() in src/utils/security.js
2. ✅ [RESOLVED] Path Traversal Vulnerability
   - Fix: Added sanitizePath() validation to MCP handlers
3. ✅ [RESOLVED] Arbitrary File Write
   - Fix: Added path validation to draft_code_implementation

🟠 HIGH PRIORITY ISSUES (Partially Resolved)
4. ✅ [RESOLVED] Git Command Injection
   - Fix: Added sanitizeGitPatterns() to review_code_changes
5. [ ] Missing Error Boundaries (index.js:183-223)
   - Location: Orchestrator execute method
   - Issue: Errors caught but session cleanup may be incomplete
   - Fix: Add comprehensive cleanup in error handler
6. ✅ [RESOLVED] Process Leak Risk
   - Fix: Added spawnWithTimeout() with SIGTERM/SIGKILL and TIMEOUTS constants
7. [ ] Insecure Credential Handling (gemini-mcp-server.js:40-76)
   - Location: AUTH_CONFIG in MCP server
   - Issue: API keys logged to console.error, exposed in error messages
   - Fix: Mask credentials in logs and error messages

🟡 MEDIUM PRIORITY ISSUES
8. [RESOLVED] Inconsistent File Structure
   - Fix: Moved adapters.test.js to tests/, updated package.json main entry
9. Missing Input Validation (Throughout)
   - Locations: Most MCP tool handlers
   - Issue: No validation on prompt lengths, model names, or parameter types
10. Weak Error Messages (gemini-mcp-server.js:113-118)
    - Issue: Generic error messages don't help users troubleshoot
11. Race Conditions (index.js:233-325, gemini-cli.js:221-319)
    - Location: Review and correction loops
    - Issue: Multiple concurrent spawns for same base sessionId could conflict
12. Hardcoded Model Names (Throughout)
    - Issue: Model names hardcoded as strings everywhere
13. Missing Cost Limit Enforcement (openrouter-client.js:162-164)
    - Location: OpenRouter client cost tracking
    - Issue: Warning logged but execution continues even when over budget

🟢 LOW PRIORITY / QUALITY ISSUES
14. Incomplete Type Checking
    - Recommendation: Add JSDoc comments or migrate to TypeScript
15. Test Coverage Gaps
    - Fix: Add integration and unit tests for remaining modules
16. Inconsistent Naming Conventions
    - Fix: Standardize on camelCase for JavaScript
17. Magic Numbers (index.js:58-62)
    - Fix: Use named constants with comments explaining thresholds
18. Console Pollution (Multiple files)
    - Fix: Use proper logging library with levels
19. [RESOLVED] TODO Comments as Production Code (TODO.md line 156)
    - Fix: Disabled OpenRouter/Collaboration tools in MCP server for now
20. Incomplete Documentation
    - Fix: Add JSDoc comments for public APIs

⚠️ KNOWN ISSUES (Updated)
21. [DEFERRED] Simulated OpenRouter Collaboration
    - Status: Implementation deferred; tool disabled in MCP server
22. [RESOLVED] Git Dependency Without Check
    - Fix: Added isGitAvailable() check to MCP tools
23. Vertex AI Model Availability
    - Status: Known limitation

---

## 📋 Backlog

### High Priority

#### Conversation System ✅ COMPLETED
- [x] `gemini_start_conversation` - Start stateful conversation
- [x] `gemini_continue_conversation` - Continue with history
- [x] `gemini_list_conversations` - List active conversations
- [x] `gemini_clear_conversation` - Clear conversation
- [x] `gemini_conversation_stats` - Conversation metrics
- [x] In-memory conversation storage
- [ ] Optional Redis storage backend

#### Content Analysis ✅ COMPLETED
- [x] `gemini_content_comparison` - Multi-source comparison
- [x] `gemini_extract_structured` - JSON schema extraction
- [x] `gemini_summarize_files` - Optimized file summarization

#### Enhanced Features (Partial)
- [x] @filename syntax processing in all tools
- [ ] Large file chunking strategies
- [ ] Automatic model fallback on rate limits
- [x] Response caching with TTL
- [ ] Template system for prompts

### Medium Priority

#### CLI Enhancements
- [ ] Interactive mode (`hybrid interactive`)
- [ ] Configuration file support (.hybridrc)
- [ ] Output format options (json, markdown, plain)
- [ ] Verbose/debug mode
- [ ] Progress indicators for long operations

#### Monitoring & Metrics
- [ ] Request/response logging
- [ ] Performance metrics collection
- [ ] Cost reports by time period
- [ ] Usage analytics dashboard

#### Security (Partial)
- [x] Input sanitization (path traversal, command injection)
- [x] Process timeouts (spawnWithTimeout)
- [ ] Credential rotation support
- [ ] Rate limiting
- [ ] API key validation
- [ ] Input length validation

### Low Priority

#### Advanced Collaboration
- [ ] Weighted voting in validation mode
- [ ] Expert panel consensus method
- [ ] Conflict resolution strategies
- [ ] Budget limits for OpenRouter

#### Integration
- [ ] Claude Desktop configuration generator
- [ ] VS Code extension
- [ ] GitHub Actions integration
- [ ] Pre-commit hook support

#### Documentation
- [ ] API documentation
- [ ] Architecture diagrams
- [ ] Video tutorials
- [ ] Contributing guide

---

## 💡 Feature Ideas (Researched Dec 2024)

### High Value - Developer Productivity

| Feature | Description | Complexity | Value |
|---------|-------------|------------|-------|
| **Smart Model Routing** | Auto-route simple tasks to Gemini, complex to Claude | Medium | Cost savings |
| **AI Commit Messages** | Generate commit messages from `git diff --staged` | Medium | Time savings |
| **Automated Unit Tests** | Generate test boilerplate for functions/classes | Medium | Coverage boost |
| **Dockerfile Scaffolding** | Generate Docker configs from project analysis | Medium | DevOps speedup |

### High Value - Cost Optimization

| Feature | Description | Complexity | Value |
|---------|-------------|------------|-------|
| **Two-Stage Analysis** | Gemini for broad scan, Claude for deep insights | High | Best of both |
| **Semantic Caching** | Cache by embedding similarity, not exact match | High | Cache hit boost |
| **Cost Dashboard** | Token usage tracking with budget alerts | Medium | Spend control |

### High Value - UX Improvements

| Feature | Description | Complexity | Value |
|---------|-------------|------------|-------|
| **Config File** | `mcp-config.yaml` instead of env vars only | Low | Easier config |
| **Setup Wizard** | Interactive `npm run setup` for first-time config | Low | Better onboarding |
| **Hot Reload** | Auto-restart on config changes | Medium | Faster iteration |
| **Config Show** | `hybrid config show` to view active settings | Low | Transparency |
| **Rich Errors** | Context-aware error messages with fix suggestions | Medium | Less frustration |

### Unique Claude+Gemini Combinations

| Feature | Description | Complexity | Value |
|---------|-------------|------------|-------|
| **AI Peer Review** | Gemini generates, Claude critiques | High | Quality boost |
| **Dependency Health** | Scan package.json for security/updates | Medium | Maintenance |

---

## 🐛 Known Issues

1. **OpenRouter in `ai_collaboration`**: Currently uses simulated collaboration via Gemini. Need to implement actual multi-model calls through OpenRouter.

2. **Git diff in MCP**: The `gemini_git_diff_review` tool spawns git process but may fail in non-git directories.

3. **Model availability**: Some Gemini 3 Pro models require Vertex AI auth which isn't widely available yet.

---

## 📊 Comparison with gemini-cli-mcp-server

| Feature | gemini-cli-mcp-server | hybrid-cli-agent |
|---------|----------------------|------------------|
| Language | Python | Node.js |
| MCP Tools | 33 | 27 |
| OpenRouter | ✅ | ✅ |
| AI Collaboration | ✅ | ✅ |
| Conversations | ✅ Redis | ✅ In-memory |
| Template System | ✅ | ❌ Not yet |
| Security Framework | ✅ 22 fixes | ✅ Comprehensive |
| Test Cases | 2,500+ | 430 |
| Claude Code Focus | ⚠️ Generic | ✅ Primary |
| Supervisor Pattern | ❌ | ✅ |

---

## 🎯 Roadmap

### v0.3.0 - Conversation Support
- Implement conversation system with history
- Add conversation tools (start, continue, list, clear)
- In-memory and Redis storage options

### v0.4.0 - Enhanced Analysis
- Content comparison tool
- Structured extraction tool
- @filename syntax in all tools
- Response caching

### v0.5.0 - Production Hardening
- Security framework
- Rate limiting
- Error recovery
- Comprehensive logging

### v1.0.0 - Stable Release
- Full test coverage
- Documentation complete
- Performance optimized
- Security audited

---

## 📝 Notes

### Design Decisions
1. **Node.js over Python**: Better integration with Claude Code ecosystem
2. **CLI-first**: Wraps existing CLIs rather than APIs for cost savings
3. **Modular adapters**: Easy to add new AI providers
4. **MCP-native**: First-class MCP support for Claude Code integration

### Inspiration
- [gemini-cli-mcp-server](https://github.com/centminmod/gemini-cli-mcp-server) - 33 tools, enterprise features
- [claude-oracle](https://github.com/n1ira/claude-oracle) - FULLAUTO pattern
- [cliagents](https://github.com/suyashb734/cliagents) - Unified CLI agent server

### Contributing
See README.md for setup instructions. PRs welcome!
