# Hybrid CLI Agent

A multi-agent CLI orchestrator that combines **Claude Code** (expensive, precise), **Gemini CLI** (free, high-context), and **OpenRouter** (400+ AI models) for optimal cost and quality.

Inspired by [gemini-cli-mcp-server](https://github.com/centminmod/gemini-cli-mcp-server).

## The Idea

Claude is great at reasoning but expensive. Gemini has massive context windows and is FREE with Google account. OpenRouter gives access to 400+ models. This tool:

1. **Routes tasks** to the cheapest capable model
2. **Offloads heavy reading** to Gemini (context arbitrage)
3. **Has Claude review** Gemini's code output (supervisor pattern)
4. **Enables AI collaboration** - debates, validation, sequential pipelines
5. **Tracks costs** across all providers
6. **Caches responses** to avoid repeated queries

**Result:** ~90% cost reduction while maintaining Claude-level quality for critical decisions.

## Features

- **27 MCP Tools** - Complete toolset for multi-AI integration
- **400+ AI Models** - Access OpenAI, Anthropic, Meta via OpenRouter
- **AI Collaboration** - Multi-model debates, validation, sequential pipelines
- **Multi-Turn Conversations** - Stateful conversation sessions with history
- **@filename Syntax** - Reference files directly in prompts
- **Response Caching** - TTL-based caching with LRU eviction
- **Content Analysis** - Compare, extract, summarize content
- **Context Arbitrage** - Gemini reads, Claude thinks
- **Supervisor Pattern** - Claude reviews Gemini's code
- **Token Tracking** - Real-time token usage and cost tracking per session (NEW)
- **JSON Output** - Structured Gemini responses for reliable parsing (NEW)

## Quick Start

```bash
# Install dependencies
npm install

# Check your agents are available
node bin/hybrid.js status

# Install MCP server into Claude Code
node bin/hybrid.js mcp-install

# Use the CLI
node bin/hybrid.js ask "What does this codebase do?"
node bin/hybrid.js research "Find auth bugs" -f "src/**/*.ts"
node bin/hybrid.js draft src/new-feature.js "Create a rate limiter"
```

## Prerequisites

### Claude Code CLI (Choose ONE authentication method)

#### Option 1: Claude Pro Subscription (RECOMMENDED)
**Best for:** Personal and team use with full Claude Code features
**Cost:** $20/month (Pro) or $25/user/month (Team)

```bash
npm i -g @anthropic-ai/claude-code
claude login  # Opens browser for Anthropic OAuth
```

#### Option 2: API Key
**Best for:** CI/CD, automation, or if you already have API credits
**Cost:** Pay-per-token ($3/1M input, $15/1M output for Sonnet)

```bash
npm i -g @anthropic-ai/claude-code
export ANTHROPIC_API_KEY="sk-ant-your-api-key"  # Get key: https://console.anthropic.com/
```

### Gemini CLI (Choose ONE authentication method)

#### Option 1: OAuth (RECOMMENDED for Pro/Ultra subscribers)
**Best for:** Personal use with Google Pro/Ultra subscription
**Benefits:** 60 RPM, 1000 RPD **FREE**, no API key needed

```bash
npm i -g @google/gemini-cli
gemini auth login  # Opens browser for Google OAuth
```

#### Option 2: Standard API Key
**Best for:** Quick setup, testing
**Limits:** Standard API rate limits apply

```bash
npm i -g @google/gemini-cli
export GEMINI_API_KEY="your-key"  # Get key: https://makersuite.google.com/app/apikey
```

#### Option 3: Vertex AI (for Gemini 3 Pro)
**Best for:** Production use, access to Gemini 3 Pro, no rate limits
**Cost:** Billed per token

```bash
npm i -g @google/gemini-cli

# Set up Vertex AI credentials
export VERTEX_API_KEY="your-vertex-key"
export VERTEX_PROJECT="your-gcp-project-id"
export VERTEX_LOCATION="us-central1"
```

### Check Your Setup
```bash
node bin/hybrid.js status
```

This will show:
- Which CLIs are installed
- Authentication status
- Available models
- Whether you're on the FREE tier

### OpenRouter (Optional - for 400+ AI models)
Get access to OpenAI, Anthropic, Meta, and 400+ other models.

```bash
# Get API key at https://openrouter.ai/keys
export OPENROUTER_API_KEY="sk-or-v1-your-api-key"

# Optional: Set daily cost limit
export OPENROUTER_COST_LIMIT_PER_DAY="10.0"
```

## Authentication & Costs

### Claude Code Auth Options

| Auth Method | Setup | Full Features | Rate Limits | Cost |
|------------|-------|---------------|-------------|------|
| **Pro Subscription** (recommended) | `claude login` | ✅ Yes | Generous | $20/month flat |
| **API Key** | `ANTHROPIC_API_KEY=...` | ✅ Yes | Standard | ~$3-15/1M tokens |

### Gemini Auth Options

| Auth Method | Setup | Gemini 3 Pro | Rate Limits | Cost |
|------------|-------|--------------|-------------|------|
| **OAuth** (recommended) | `gemini auth login` | Preview only | 60 RPM, 1000 RPD | **FREE** |
| **API Key** | `GEMINI_API_KEY=...` | No | Standard | ~$1.25/1M tokens |
| **Vertex AI** | `VERTEX_API_KEY=...` | ✅ Yes | Unlimited | ~$1.25/1M tokens |

### Cost Comparison

| Scenario | Claude Only | Hybrid (OAuth) | Hybrid (Vertex) |
|----------|-------------|----------------|-----------------|
| Read 50k tokens of docs | $0.15 | **$0.00** | $0.06 |
| Generate 500 lines of code | $0.02 | **$0.00** | $0.01 |
| Code review (10k tokens) | $0.05 | **$0.00** | $0.01 |
| **Total** | **$0.22** | **$0.00** | **$0.08** |

With OAuth authentication, Gemini operations are effectively **FREE** within the generous limits.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         YOUR CLI                                 │
│                     hybrid ask/draft/review                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                       ORCHESTRATOR                               │
│  • Task classification (trivial/standard/complex/critical)      │
│  • Model routing (cheapest capable)                             │
│  • Supervisor loop (Claude reviews Gemini)                      │
│  • Cost tracking                                                │
└───────────┬─────────────────────────────────────┬───────────────┘
            │                                     │
   ┌────────▼────────┐                   ┌────────▼────────┐
   │   CLAUDE CODE   │                   │   GEMINI CLI    │
   │   (Supervisor)  │                   │    (Worker)     │
   │                 │                   │                 │
   │ • Final judge   │    reviews        │ • Heavy reading │
   │ • Code polish   │◄──────────────────│ • First drafts  │
   │ • Architecture  │                   │ • Research      │
   │                 │                   │                 │
   │ Cost: $1-25/1M  │                   │ Cost: FREE*     │
   └─────────────────┘                   └─────────────────┘
                                         * with Google account
```

## How Routing Works

| Task Type | Complexity | Routes To | Cost |
|-----------|------------|-----------|------|
| Read/Analyze | Any | Gemini | FREE |
| Questions | Trivial-Complex | Gemini | FREE |
| Questions | Critical | Claude | $$ |
| Code Generation | Trivial-Complex | Gemini → Claude review | ~FREE |
| Code Generation | Critical | Claude | $$ |
| Architecture | Any | Claude | $$ |

## CLI Commands

> **Note:** Use `node bin/hybrid.js` to run commands. Examples below use the shorthand `hybrid` which requires `npm link` or adding to PATH.

### `status`
Check which agents are available.
```bash
node bin/hybrid.js status
```

### `ask <question>`
Ask a question - automatically routed to best agent.
```bash
node bin/hybrid.js ask "How does the auth flow work?"
node bin/hybrid.js ask "What's causing the memory leak?" --files "logs/*.log" "src/**/*.js"
```

### `research <query> -f <patterns>`
Research codebase using Gemini (heavy context, FREE).
```bash
node bin/hybrid.js research "Find security vulnerabilities" -f "src/**/*.ts"
node bin/hybrid.js research "Explain the data model" -f "src/models/*.py" --flash
```

### `draft <file> <description>`
Have Gemini draft code, Claude reviews.
```bash
node bin/hybrid.js draft src/middleware/auth.ts "JWT authentication middleware"
node bin/hybrid.js draft src/utils/logger.js "Winston logger with rotation" --context "src/config/*.js"
```

### `review [files]`
Code review powered by Gemini.
```bash
node bin/hybrid.js review src/new-feature/
node bin/hybrid.js review --focus "security,performance"
node bin/hybrid.js review --diff  # only staged changes
```

### `costs`
Show cost summary.
```bash
node bin/hybrid.js costs
```

### `mcp-install`
Install Gemini Worker MCP server into Claude Code.
```bash
node bin/hybrid.js mcp-install
```

### Manual MCP Setup

For manual system-wide setup, add to your Claude Code `settings.json`:

```json
"gemini-worker": {
  "type": "stdio",
  "command": "node",
  "args": ["C:\\path\\to\\gemini-cli-mcp-server\\src\\mcp\\gemini-mcp-server.js"],
  "env": {
    "GEMINI_WORKER_ROOT": "C:\\path\\to\\gemini-cli-mcp-server"
  }
}
```

**Environment Variables:** The server loads `.env` files in this order:
1. `GEMINI_WORKER_ROOT/.env` (if set in settings.json)
2. Project root `.env` (where the script lives)
3. Current working directory `.env`
4. `~/.env.gemini` (home directory)

**API Keys** - Put these in a `.env` file (not settings.json):
```bash
# Only needed for OpenRouter features
OPENROUTER_API_KEY=sk-or-...

# Only needed if not using OAuth
GEMINI_API_KEY=...
VERTEX_API_KEY=...
```

## Claude Code Integration

After running `node bin/hybrid.js mcp-install`, you can use Gemini tools directly in Claude Code:

```
> /hybrid Analyze the authentication system and create a rate limiter

Claude: I'll use the Gemini worker for this task...
[Calls research_heavy_context to analyze auth files]
[Calls draft_code_implementation to create rate limiter]
[Reviews the draft and makes corrections]
Done! The rate limiter is at src/middleware/rate-limiter.ts
```

## MCP Tools (27 Total)

The `gemini-worker` MCP server exposes these tools organized into categories:

### Core Gemini Tools (6)
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `gemini_auth_status` | Check auth status | Verify setup |
| `gemini_prompt` | Send prompts with @filename syntax | General queries |
| `research_heavy_context` | Analyze files without loading into context | Large codebases, logs |
| `draft_code_implementation` | Generate code files | New features, refactors |
| `ask_gemini` | Quick questions | Brainstorming |
| `summarize_directory` | Understand codebase structure | Onboarding |

### Analysis Tools (4)
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `gemini_eval_plan` | Evaluate implementation plans | Before starting work |
| `gemini_verify_solution` | Verify complete solutions | Before deploying |
| `gemini_code_review` | Structured code review | Quality assurance |
| `gemini_git_diff_review` | Review git diffs | Before commits |

### AI Collaboration Tools (2)
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `ai_collaboration` | Multi-model debates/validation | Complex decisions |
| `cross_model_comparison` | Compare responses across models | Getting diverse perspectives |

### OpenRouter Tools (3)
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `openrouter_chat` | Chat with 400+ models | Access OpenAI, Anthropic, Meta |
| `openrouter_models` | List available models | Finding the right model |
| `openrouter_usage_stats` | Get usage stats | Cost tracking |

### Conversation Tools (5) - NEW
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `gemini_start_conversation` | Start stateful conversation | Multi-turn dialogs |
| `gemini_continue_conversation` | Continue conversation with history | Follow-up questions |
| `gemini_list_conversations` | List active conversations | Managing sessions |
| `gemini_clear_conversation` | Delete conversation | Cleanup |
| `gemini_conversation_stats` | Get conversation metrics | Monitoring usage |

### Content Analysis Tools (3) - NEW
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `gemini_content_comparison` | Compare multiple sources | Version comparison, diff analysis |
| `gemini_extract_structured` | Extract JSON from text | Log parsing, data extraction |
| `gemini_summarize_files` | Summarize multiple files | Quick codebase overview |

### Cache Management (1) - NEW
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `gemini_cache_manage` | View/clear response cache | Performance optimization |

### Metrics & Status (3)
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `hybrid_metrics` | Get agent metrics | Monitoring |
| `gemini_config_show` | Show config and environment | Debug setup |
| `review_code_changes` | Review code changes | Before committing |

## New Features (v0.3.3)

### Progress Events (NEW)
The orchestrator now emits progress events for real-time CLI feedback:
- `routing` - Task classification complete
- `executing` - Started execution on adapter
- `review` - Claude review started/completed
- `correction` - Gemini correction started
- `complete` - Task finished

### Operation Summary (NEW)
After draft/review commands, shows detailed breakdown:
```
Operation Summary:
  Task type: draft_code
  Steps: 2
  Reviews: 1
  Corrections: 0
  Status: Approved
  Models: gemini-2.5-pro, claude-sonnet-4-5-20250514
  Cost: $0.0023
```

### Centralized Configuration (NEW)
All configuration now lives in `src/config/`:
- `models.js` - Model definitions and capabilities
- `pricing.js` - Cost calculations per model
- `timeouts.js` - Timeouts, rate limits, CLI config

## Features (v0.3.0)

### @filename Syntax
Reference files directly in prompts across multiple tools:
```
gemini_prompt: "Analyze @src/auth.js for security issues"
ask_gemini: "What does @package.json tell us about dependencies?"
gemini_code_review: { code: "@src/api/*.ts" }
```

Supported patterns:
- `@path/to/file.js` - Single file
- `@src/**/*.py` - Glob pattern
- `@directory/` - Directory listing

### Response Caching
Automatic caching of Gemini responses to avoid repeated queries:
- 30-minute default TTL
- LRU eviction when cache is full (1000 entries max)
- Cache indicator on responses: `_[cached response]_`

Manage cache with `gemini_cache_manage`:
```python
gemini_cache_manage(action="stats")   # View statistics
gemini_cache_manage(action="clear")   # Clear all cached responses
gemini_cache_manage(action="check", prompt="...", model="...")  # Check if cached
```

### Multi-Turn Conversations
Stateful conversations with Gemini that maintain context:

```python
# Start a conversation
result = gemini_start_conversation(
    title="API Design Discussion",
    system_prompt="You are a senior API architect",
    initial_message="Let's design a REST API"
)
# Returns: { id: "abc-123", ... }

# Continue the conversation
gemini_continue_conversation(
    conversation_id="abc-123",
    message="Now add authentication"
)

# View all conversations
gemini_list_conversations()

# Get statistics
gemini_conversation_stats(conversation_id="abc-123")
```

Features:
- Token counting and limits
- 24-hour auto-expiration
- History tracking
- Export/import support

### Content Analysis
Advanced content analysis tools:

**Compare content:**
```python
gemini_content_comparison(
    sources=["@v1/api.py", "@v2/api.py"],
    comparison_type="semantic",  # semantic, structural, line_by_line, key_points
    focus="Breaking API changes"
)
```

**Extract structured data:**
```python
gemini_extract_structured(
    content="@logs/errors.log",
    schema_description="Extract error messages with timestamps and stack traces"
)
```

**Summarize files:**
```python
gemini_summarize_files(
    file_patterns=["src/**/*.js"],
    summary_style="bullet_points",  # brief, detailed, bullet_points, executive
    group_by="directory"  # none, directory, extension, purpose
)
```

## AI Collaboration

The `ai_collaboration` tool enables multi-model AI collaboration:

### Debate Mode
```python
ai_collaboration(
    mode="debate",
    content="Should we use microservices or monolith?",
    models="gemini-2.5-flash,openai/gpt-4.1-mini",
    rounds=3,
    debate_style="constructive"  # constructive, adversarial, socratic
)
```

### Validation Mode
```python
ai_collaboration(
    mode="validation",
    content="@mcp_server.py",
    models="gemini-2.5-flash,openai/gpt-4.1-mini,anthropic/claude-3-haiku",
    validation_criteria="code_quality,security,performance",
    consensus_method="weighted_majority"
)
```

### Sequential Pipeline
```python
ai_collaboration(
    mode="sequential",
    content="Design a REST API for user management",
    pipeline_stages="analysis,design,security_review,optimization"
)
```

## Context Arbitrage

The key insight: **Reading is cheap, thinking is expensive.**

**Without Hybrid Agent:**
```
User: "Find bugs in these 50 files"
Claude: [Reads 50,000 tokens @ $3/1M = $0.15]
Claude: [Analyzes and responds @ $15/1M = $0.10]
Total: $0.25
```

**With Hybrid Agent:**
```
User: "Find bugs in these 50 files"
Orchestrator: Routes to Gemini (heavy context task)
Gemini: [Reads 50,000 tokens @ FREE]
Gemini: [Analyzes and summarizes @ FREE]
Claude: [Reviews summary ~500 tokens @ $0.0015]
Total: $0.0015 (99% savings)
```

## Configuration

Create `.env` in your project:
```bash
# Optional: Force specific models
HYBRID_CLAUDE_MODEL=claude-sonnet-4-5-20250514
HYBRID_GEMINI_MODEL=gemini-2.5-pro

# Optional: Disable review loop
HYBRID_SKIP_REVIEW=false

# Optional: Max correction iterations
HYBRID_MAX_RETRIES=3
```

## Programmatic Usage

```javascript
import { Orchestrator } from 'hybrid-cli-agent';

const orchestrator = new Orchestrator({
  workDir: '/path/to/project',
});

// Automatically routes to best agent
const result = await orchestrator.execute(
  'Analyze the auth module and fix the token refresh bug'
);

console.log(result.result);
console.log(`Cost: $${result.cost}`);
console.log(`Route: ${result.routing.adapter}/${result.routing.model}`);
```

## Cost Tracking

The orchestrator tracks all costs:

```javascript
const costs = orchestrator.getTotalCosts();
// {
//   claude: { inputTokens: 1200, outputTokens: 800, cost: 0.0156 },
//   gemini: { inputTokens: 50000, outputTokens: 2000, cost: 0 },  // FREE!
//   total: 0.0156
// }
```

## The HYBRID_CONTEXT.md File

When running tasks, the orchestrator saves state to `HYBRID_CONTEXT.md`. This:
- Allows recovery if Claude's context compacts mid-task
- Provides an audit trail of agent interactions
- Shows cost breakdown per session

## Project Structure

```
hybrid-cli-agent/
├── bin/hybrid.js              # CLI entry point with progress events
├── src/
│   ├── adapters/              # CLI wrappers
│   │   ├── base.js            # Base adapter class
│   │   ├── claude-code.js     # Claude Code adapter
│   │   └── gemini-cli.js      # Gemini CLI adapter
│   ├── config/                # Centralized configuration (NEW)
│   │   ├── models.js          # Model definitions
│   │   ├── pricing.js         # Cost calculations
│   │   ├── timeouts.js        # Timeouts & rate limits
│   │   └── index.js           # Central export
│   ├── mcp/
│   │   ├── gemini-mcp-server.js  # MCP server (27 tools)
│   │   └── tool-handlers/     # Modular handlers
│   │       ├── base.js        # Shared utilities
│   │       ├── code/          # Code generation tools
│   │       ├── collaboration/ # AI collaboration tools
│   │       ├── content/       # Content analysis tools
│   │       ├── conversations/ # Conversation tools
│   │       ├── core/          # Core Gemini tools
│   │       ├── openrouter/    # OpenRouter tools
│   │       ├── research/      # Research tools
│   │       └── system/        # System tools
│   ├── orchestrator/
│   │   └── index.js           # EventEmitter + task routing
│   ├── services/
│   │   ├── ai-collaboration.js     # Multi-model collaboration
│   │   ├── conversation-manager.js # Stateful conversations
│   │   ├── openrouter-client.js    # OpenRouter API client
│   │   └── response-cache.js       # Response caching
│   └── utils/
│       ├── security.js        # Path/command sanitization
│       ├── validation.js      # Input validation
│       ├── errors.js          # Error classes
│       ├── logger.js          # Structured logging
│       └── prompt-processor.js # @filename syntax
├── tests/                     # 430 tests across 14 files
├── memory-bank/               # Project context files
├── commands/hybrid.md         # Slash command for Claude Code
├── CLAUDE.md                  # Claude Code instructions
└── README.md                  # This file
```

## Comparison

| Feature | claude-oracle | cliagents | **This Project** |
|---------|---------------|-----------|------------------|
| Language | Python | Node.js | Node.js |
| Claude support | Via API | CLI wrapper | CLI wrapper |
| Gemini support | API only | CLI wrapper | CLI wrapper (FREE tier) |
| MCP integration | No | No | **Yes (27 tools)** |
| Multi-turn conversations | No | No | **Yes** |
| Response caching | No | No | **Yes** |
| @filename syntax | No | No | **Yes** |
| AI collaboration | No | No | **Yes** |
| Supervisor pattern | Partial | No | **Yes** |
| Cost tracking | No | No | **Yes** |
| Test coverage | ? | ? | **430 tests** |
| Context persistence | FULLAUTO_CONTEXT.md | No | HYBRID_CONTEXT.md |

## License

MIT

## Credits

Inspired by:
- [claude-oracle](https://github.com/n1ira/claude-oracle) - The FULLAUTO pattern
- [cliagents](https://github.com/suyashb734/cliagents) - Unified CLI agent server
- [gemini-cli-mcp-server](https://github.com/centminmod/gemini-cli-mcp-server) - Gemini MCP inspiration
- Anthropic's MCP specification
