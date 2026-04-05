# About coding-cli

## What it is

A terminal coding assistant that talks to LLMs, reads your codebase, proposes edits, runs commands, and waits for you to approve before anything touches disk.

Same shape as Claude Code or Cursor. Built as transparent TypeScript you can read, fork, and modify.

## Why it exists

Coding agents are becoming infrastructure. Most of the good ones are closed. coding-cli is the same category — tool-using agent, staged writes, long-horizon context management — built openly so you can see exactly what's happening and change it.

It was designed around three convictions:

**1. The operator is always in the loop.** Every file change and every shell command is staged for explicit approval. Fast-approve and auto modes exist, but the default is: propose, review, apply. The model proposes, you decide.

**2. The agent should be inspectable and modifiable at runtime.** Not just the source code — the agent's own behavior. coding-cli embeds a Lisp interpreter. The agent has ~100 strategies written as S-expressions. It can read them as data, diagnose them, evolve them, and the improvements persist across sessions. Self-improvement is a first-class operation, not a party trick.

**3. Long context requires active management.** Modern models have huge windows, but usage patterns fill them fast. coding-cli tracks utilization continuously, summarizes older messages on demand (`/compact`), auto-trims when approaching the limit, dedupes redundant turns, and supports channel branching that carries forward summaries without the full history.

## What makes it different

- **Multi-provider by default.** Anthropic (API + OAuth), z.ai, Ollama, and LM Studio. Local models are auto-detected. Switch models mid-conversation.

- **Staged exec.** Shell commands go through the same propose-approve flow as file writes. The agent can run `npm test`, `git diff`, or anything else — but you see the exact command first.

- **Self-modification.** The CLI can read and edit its own TypeScript source. After approving changes, `/rebuild` recompiles. The agent literally improves itself.

- **Subagents.** Spawn background workers that run in parallel, then `/join` to pull results and any staged writes into the main conversation.

- **Live context awareness.** Every prompt shows a utilization bar: `[46%] > `. Every turn displays burn rate, estimated turns remaining, and cache hit rate. You see the budget.

- **Channel model.** Conversations are channels. You can have many, switch between them, branch from one, or read another channel's history into the current one as a compacted summary.

## Who it's for

Developers who want a coding agent they can actually understand and modify. If you're happy with closed tools that work, stick with those. If you want to see how the pieces fit, swap out the provider, rewrite the prompt, or teach the agent new strategies — coding-cli is built for that.

## Status

Version 0.2.0. Actively developed. TypeScript, ESM, Node 18+. Dependencies minimal: `@anthropic-ai/sdk` and `dotenv`.

## License

MIT.
