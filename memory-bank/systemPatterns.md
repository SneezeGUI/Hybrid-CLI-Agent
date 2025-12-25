# System Patterns

## Architecture
The system follows a **Supervisor-Worker** architecture pattern.

```mermaid
graph TD
    User[User CLI] --> Orchestrator
    Orchestrator -->|Complexity Check| Router
    Router -->|High Reasoning| Claude[Claude Code (Supervisor)]
    Router -->|High Context/Low Cost| Gemini[Gemini CLI (Worker)]
    Router -->|Specific Model| OpenRouter[OpenRouter Client]
    Claude -->|MCP Protocol| MCPServer[Gemini MCP Server]
    MCPServer -->|Executes| Gemini
```

## Key Components

### 1. Orchestrator (`src/orchestrator/`)
- Central nervous system.
- Receives user commands.
- Determines task complexity and cost implications.
- Routes tasks to Adapters.
- Manages the "Supervisor Loop" (Draft -> Review -> Refine).

### 2. Adapters (`src/adapters/`)
- **Wrapper Pattern**: Wraps external CLIs (Claude Code, Gemini CLI).
- Standardized interface (`isAvailable`, `run`, `cost`).
- Handles output parsing (e.g., stripping ANSI codes, parsing JSON).

### 3. MCP Server (`src/mcp/`)
- **FastMCP Pattern**: Exposes internal tools to Claude.
- Bridges the gap between Claude Code and local resources/Gemini.
- Tools include: `research_heavy_context`, `draft_code_implementation`, etc.

### 4. Services (`src/services/`)
- **AI Collaboration**: Engine for multi-model debates and pipelines.
- **OpenRouter Client**: Direct API client for accessing 3rd party models.

## Design Patterns
- **Context Arbitrage**: Prefer lower-cost models for read-heavy operations.
- **Graceful Degradation**: Check for tool availability (e.g., Git) and provide fallbacks or clear errors.
- **Dependency Injection**: Orchestrator accepts adapters to facilitate testing (partial implementation).

## File Structure
```
hybrid-cli-agent/
├── bin/            # CLI executables
├── src/
│   ├── adapters/   # CLI Wrappers
│   ├── mcp/        # MCP Server
│   ├── orchestrator/ # Core Logic
│   ├── services/   # Auxiliary Services
│   └── utils/      # Helpers
├── tests/          # Unit/Integration Tests
└── ...
```
