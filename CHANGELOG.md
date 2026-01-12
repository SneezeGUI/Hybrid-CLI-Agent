# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.9] - 2026-01-12

### Added
- Comprehensive input validation for `gemini_agent_task` using centralized validation utilities
- All handler exports now wrapped with `withErrorHandling` for consistent error responses

### Changed
- Replaced inline `rateLimitTracker` object with centralized `RateLimitTracker` class from `utils/retry.js`
- Replaced manual retry loop in agent handler with `withRetry` utility
- Method calls updated: `recordFailure` → `recordRateLimit` for consistency with centralized class API

### Fixed
- Input validation now properly enforces limits on `max_iterations` (1-100), `max_retries` (0-10), `timeout_minutes` (1-60), `stall_timeout_seconds` (30-600)
- Context file patterns limited to 50 max for memory protection

### Technical
- Integrated 6 previously unused validation functions: `validatePrompt`, `validateModel`, `validateFilePatterns`, `validatePositiveInteger`, `aggregateValidations`
- Integrated `withRetry` and `getRateLimitTracker` from `utils/retry.js`
- Integrated `withErrorHandling` from `tool-handlers/base.js` into all handler exports
- Resolves TODO.md issue #9 (Missing Input Validation)

## [0.3.6] - 2026-01-10

### Added
- Error handling utilities: `analyzeStderr()`, `formatErrorResponse()`, `withErrorHandling()`, `createTypedError()`
- New test file: `tests/tool-handlers-error.test.js` for error utilities
- New test file: `tests/tool-handlers-core.test.js` for core handlers
- New test file: `tests/ai-collaboration.test.js` for AI collaboration engine

### Changed
- Refactored `gemini-mcp-server.js` to use centralized error detection
- Updated memory banks to reflect v0.3.6 state
- Test count increased from 629 to 677 (+48 tests)

### Fixed
- Stderr inspection logic now centralized instead of duplicated

## [0.3.5] - 2026-01-XX

### Added
- Full output streaming to disk for agent tasks
- Dual output files (full + summary) for large outputs
- Auto cleanup of old output files (>30 days)

### Fixed
- Agent output truncation causing "exceeds maximum tokens" errors
- Session memory bloat from unbounded tool call data
- Silent failures when reading context files
- JSON parse errors from CLI warning output

## [0.3.4] - 2024-12-XX

### Added
- JSON output format for Gemini CLI (`--output-format json`)
- Token tracking with `tokenTracker`
- Cost estimation per model (FREE for OAuth, calculated for API)
- Enhanced metrics in `hybrid_metrics` tool
- Secret masking for OpenRouter keys, Google API keys, JWTs, Bearer tokens

### Changed
- Improved token usage tracking per session

## [0.3.3] - 2024-12-XX

### Added
- Smart model selection with automatic fallback
- Rate limit tracking and recovery
- Gemini 3 Pro support for Vertex AI users
- `.env` file support (`.env`, `.env.local`, `~/.env.gemini`)

### Changed
- Updated `gemini_config_show` with model status

## [0.3.2] - 2024-12-XX

### Added
- Agent mode (`gemini_agent_task`) for autonomous task execution
- Session management (`gemini_agent_list`, `gemini_agent_clear`)
- `AgentSessionManager` service for tracking file mutations and shell commands

## [0.3.1] - 2024-12-XX

### Added
- Input validation module (`src/utils/validation.js`)
- Structured error classes (`src/utils/errors.js`)
- Logging framework (`src/utils/logger.js`)
- Security utilities (`src/utils/security.js`)
- Sandbox mode for Gemini CLI (prevents tool hallucination)

### Fixed
- Command injection vulnerability in glob patterns
- Path traversal vulnerability in file operations
- Arbitrary file write in draft_code_implementation

## [0.3.0] - 2024-12-XX

### Added
- Conversation system (5 tools: start, continue, list, clear, stats)
- Content analysis tools (comparison, structured extraction, file summarization)
- @filename syntax support in all tools
- Response caching with TTL and LRU eviction
- `gemini_content_comparison` tool
- `gemini_extract_structured` tool
- `gemini_summarize_files` tool

### Changed
- Expanded test coverage from 250 to 430 tests

## [0.2.0] - 2024-12-XX

### Added
- OpenRouter integration with 400+ models
- AI Collaboration engine (debate, validation, sequential modes)
- `openrouter_chat`, `openrouter_models`, `openrouter_usage_stats` tools
- `ai_collaboration`, `cross_model_comparison` tools
- Cost tracking per model

## [0.1.0] - 2024-12-XX

### Added
- Initial release
- Core MCP server with 17 tools
- Claude Code and Gemini CLI adapters
- Orchestrator with supervisor pattern
- Multi-auth support (OAuth, API Key, Vertex AI)
- Basic unit tests
