# Project Brief: Hybrid CLI Agent

## Overview
**hybrid-cli-agent** is a multi-agent CLI orchestrator that combines **Claude Code** (precise reasoning, higher cost) with **Gemini CLI** (massive context, free tier) and **OpenRouter** (400+ AI models). It acts as a supervisor system where Claude directs tasks, Gemini handles heavy context processing, and OpenRouter provides diverse model perspectives.

## Core Value Proposition
- **Context Arbitrage**: "Reading is cheap, thinking is expensive." Offload heavy reading/analysis to Gemini (Free) and use Claude (Paid) for critical decision-making.
- **Cost Reduction**: Achieves ~90% cost savings compared to using Claude alone for context-heavy tasks.
- **Unified Interface**: Integrates multiple powerful AI CLI tools into a single orchestration layer.

## Key Features
- **Supervisor Pattern**: Claude reviews and validates Gemini's output.
- **Multi-Agent Orchestration**: Routes tasks to the most appropriate/cost-effective agent.
- **MCP Integration**: Exposes capabilities as Model Context Protocol (MCP) tools for Claude Code.
- **Extensive Toolset**: 17+ tools for code drafting, research, review, and collaboration.
- **Authentication Flexibility**: Supports OAuth (Free tier), API Keys, and Vertex AI.

## Project Status
- **Version**: 0.2.0 (Beta)
- **Status**: Active Development / Local Deployment Focus
- **Current Focus**: Stability, File Structure Organization, Local Development Experience.
