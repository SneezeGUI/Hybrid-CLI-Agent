# Active Context

## Current Status (Dec 2025)
- **Code Complete**: All core files exist and import correctly
- **Tests Passing**: 20/20 tests passing
- **Windows Compatible**: All tools work on Windows
- **MCP Server**: 26 tools fully active

## Recent Session Changes (Dec 23, 2025)

### Files Created
- `src/adapters/base.js` - Base adapter class with proper interface
- `src/adapters/claude-code.js` - Claude Code CLI wrapper
- `src/services/conversation-manager.js` - Multi-turn conversation state management
- `src/services/response-cache.js` - TTL-based response caching with LRU eviction
- `src/utils/prompt-processor.js` - @filename syntax processor

### Files Fixed
- `package.json` - Scripts now point to valid files
- `src/mcp/gemini-mcp-server.js` - Windows compatibility, 26 tools implemented

### Features Implemented
1. **OpenRouter Tools** (enabled) - 400+ model access
2. **AI Collaboration Tools** (enabled) - Debate, validation, sequential modes
3. **Conversation System** (new) - 5 tools for multi-turn conversations
4. **Content Analysis** (new) - 3 tools for comparison, extraction, summarization
5. **@filename Syntax** (new) - File references in prompts
6. **Response Caching** (new) - TTL-based caching with LRU eviction

## Tool Inventory (26 Total)

| Category | Count | Tools |
|----------|-------|-------|
| Core Gemini | 6 | auth_status, prompt, research_heavy_context, draft_code, ask_gemini, summarize_directory |
| Analysis | 4 | eval_plan, verify_solution, code_review, git_diff_review |
| AI Collaboration | 2 | ai_collaboration, cross_model_comparison |
| OpenRouter | 3 | chat, models, usage_stats |
| Conversation | 5 | start, continue, list, clear, stats |
| Content Analysis | 3 | content_comparison, extract_structured, summarize_files |
| Cache | 1 | cache_manage |
| Metrics | 2 | hybrid_metrics, review_code_changes |

## Services

| Service | File | Purpose |
|---------|------|---------|
| ConversationManager | `src/services/conversation-manager.js` | Multi-turn state, history, export |
| ResponseCache | `src/services/response-cache.js` | TTL caching, LRU eviction |
| OpenRouterClient | `src/services/openrouter-client.js` | 400+ model access |
| AICollaborationEngine | `src/services/ai-collaboration.js` | Multi-model debate/validation |

## Next Steps
1. **Integration tests** for MCP tools
2. **CLI end-to-end testing**

## Documentation Status
- ✅ README.md fully updated with all 26 tools, new features, auth options
- ✅ Claude auth documented (subscription + API key)
- ✅ Gemini auth documented (OAuth + API key + Vertex)
- ✅ CLAUDE.md updated to v0.3.0

## Known Limitations (Local-Only)
- Security vulnerabilities (path traversal) - acceptable for local use
- No process timeouts - manual cleanup if something hangs
