# Product Context

## Problem Statement
Developing with LLMs can be expensive, especially when large context windows are required for analyzing codebases or logs. High-intelligence models like Claude are costly for bulk processing. Conversely, cheaper models may lack the reasoning capability for complex architecture but are excellent at summarization and reading. Developers often need to manually switch between tools or suffer high costs/lower quality.

## User Experience
The user interacts primarily through a CLI (`hybrid`).
- **Commands**:
  - `hybrid ask <question>`: Smart routing to answer questions.
  - `hybrid research <query>`: Heavy context analysis using Gemini.
  - `hybrid draft <file>`: Code generation with review loop.
  - `hybrid review`: Code review assistance.
  - `hybrid status`: Check agent availability.

## User Goals
1. **Save Money**: Utilize free/cheap models for high-volume tasks.
2. **Save Time**: Automate the "read -> summarize -> decide" loop.
3. **High Quality**: Ensure code correctness by having Claude supervise and review.
4. **Local Control**: Run everything locally on the user's machine, wrapping existing CLI tools.

## Success Metrics
- **Cost Savings**: Significant reduction in token costs vs. pure Claude usage.
- **Task Success Rate**: Correctly routed and executed tasks without errors.
- **Developer Friction**: Minimal setup and smooth fallback when tools (like Git) are missing.
