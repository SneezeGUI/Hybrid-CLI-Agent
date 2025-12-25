# Technical Context

## Core Technologies
- **Runtime**: Node.js (>=20.0.0)
- **Language**: JavaScript (ES Modules)
- **CLI Framework**: `commander`
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Process Management**: `child_process` (spawn/exec)

## External Dependencies (CLIs)
The system relies on external tools being installed in the user's environment:
- `@anthropic-ai/claude-code`: For Claude interactions.
- `@google/gemini-cli`: For Gemini interactions.
- `git`: For version control operations (diffs, reviews).

## Configuration
- **Environment Variables**: `.env` file for API keys (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, etc.).
- **Authentication**:
  - Gemini: OAuth (local credential file) or API Key.
  - Claude: Managed via its own CLI login.

## Security Constraints
- **Local Execution**: Tools run with user privileges.
- **Input Validation**: Critical for preventing command injection (identified as a priority fix).
- **Credentials**: Stored in environment variables or standard CLI config paths.

## Development Environment
- **OS**: Cross-platform (Windows/Mac/Linux), currently developing on Windows (win32).
- **Package Manager**: npm
- **Testing**: Node.js native test runner (`node --test`).
