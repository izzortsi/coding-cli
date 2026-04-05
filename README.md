# coding-cli

Interactive CLI for multi-turn LLM conversations with tool use, staged writes, and a lisp runtime.

Think of it as a terminal-native coding assistant: you chat with an LLM, it reads your codebase,
proposes changes, and nothing touches disk until you approve.

## Features

- **Interactive REPL** — Multi-turn conversations in your terminal with full readline editing
- **Multi-provider** — Anthropic (API key or OAuth), z.ai, Ollama (auto-detected), LM Studio (auto-detected)
- **Tool use** — The model reads files, searches code, browses directories, proposes edits, runs tests, and evaluates lisp
- **Staged writes** — All file changes are proposed, reviewed, and explicitly approved before being applied
- **Staged exec** — Shell commands can be proposed and approved the same way as file writes
- **File tracking** — Tracks which files the model has read with content hashes for drift detection
- **Channel persistence** — Conversations saved as JSON, resumable across sessions
- **Compaction** — Summarize older messages to reclaim context window space while preserving decisions
- **Auto-trim** — Automatic context trimming when approaching the window limit
- **Dedupe** — Duplicate message detection to prevent context bloat
- **Lisp runtime** — The agent has a persistent lisp interpreter with stdlib; strategies survive across sessions
- **Subagents** — Spawn background subagents that run tasks concurrently and inject results on join
- **Bootstrap** — Auto-orient the model: scans project structure and key files
- **Context window tracking** — Live utilization bar, burn rate, estimated turns remaining, cache hit rate
- **Editor integration** — Compose messages in `$EDITOR` via `/edit` or `Ctrl+X E`
- **Markdown rendering** — Assistant output rendered with ANSI colors (headers, code blocks, bold, italic)
- **Sounds** — Optional audio feedback (`CODING_CLI_SOUNDS=1`)
- **Custom commands** — Define project-specific slash commands in `.coding-cli/commands.json`

## Quick Start

### Prerequisites

- Node.js 18+
- One of: Anthropic API key, Claude Pro/Max subscription (OAuth), z.ai API key, Ollama running locally, or LM Studio running locally

### Install

```bash
git clone https://github.com/your-org/coding-cli.git
cd coding-cli
npm install
npm run build
```

### Configure Authentication

**Option A: Anthropic API Key**

```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY
```

**Option B: Anthropic OAuth (Claude Pro/Max)**

```bash
node dist/index.js auth
# Follow the prompts to authenticate via browser
```

**Option C: z.ai**

```bash
cp .env.example .env
# Edit .env and set ZHIPU_API_KEY
# Optionally set ZAI_BASE_URL if using a custom endpoint
```

**Option D: Ollama (local)**

Ollama is auto-detected. Start the Ollama server and run coding-cli — available models are
discovered automatically from `http://localhost:11434` (override with `OLLAMA_BASE_URL`).

**Option E: LM Studio (local)**

LM Studio is auto-detected. Start LM Studio with its local server enabled. coding-cli discovers
the server at `http://localhost:1234/v1` (override with `LMSTUDIO_BASE_URL`).

### Run

```bash
npm start
# or
node dist/index.js
```

## Usage

### Interactive REPL

```
coding-cli v0.2.0

Auth: API key
Resuming: channel-2026-03-01 (12 messages)
Project: /home/user/my-project

[46%] > What files are in this project?
```

The prompt shows current context window utilization. The model uses tools autonomously to explore
your codebase, then responds.

### Non-Interactive (Single-Turn) Mode

Pass `-p` to send a single prompt and exit:

```bash
# Plain text output
node dist/index.js -p "What does auth.ts do?"

# JSON output (full API response)
node dist/index.js -p "List all providers" -f json

# Quiet mode (suppress progress/tool output)
node dist/index.js -p "Summarize this file" -q
```

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/model [id]` | Select model (interactive picker if no args) |
| `/mode [name]` | Switch agent mode (picker if no args) |
| `/system <prompt>` | Set a custom system prompt |
| `/new <name>` | Create a new empty channel |
| `/branch <name>` | Create a new channel with current context |
| `/load [id\|name]` | Switch to a channel (interactive picker if no args) |
| `/channel` | Alias for `/load` |
| `/list` | List all channels |
| `/compact [keep]` | Compact older messages into summary (keep last N, default 20) |
| `/read <channel>` | Read another channel — compact its history into current context |
| `/info` | Show channel info, compaction stats, and context window usage |
| `/bootstrap` | Orient the model — scans project structure and key files |
| `/state` | Show ephemeral state (what the model sees) |
| `/history [n]` | Show last n messages (default 10) |
| `/spawn <name> <task>` | Spawn a background subagent |
| `/agents` | List running/completed subagents |
| `/join <name>` | Wait for subagent, inject result and staged writes |
| `/kill <name>` | Abort a running subagent |
| `/identity [sub]` | Agent self-identity (list/get/set/clear/reserved) |
| `/edit` | Compose message in `$EDITOR` |
| `/edit system` | Edit system prompt in `$EDITOR` |
| `/paste` | Multi-line input mode (end with `/end`) |
| `/fast` | Toggle fast-approve mode (Enter approves all) |
| `/auto`, `/a` | Toggle auto-approve mode (full bypass, model loops until done) |
| `/approve [all\|sel]` | Approve all or one staged item by selector |
| `/reject [all\|sel]` | Reject all or one staged item by selector |
| `/files` | List pending staged writes |
| `/git status` | Show git status |
| `/git log [n]` | Show last n commits (default 10) |
| `/git diff` | Show working tree diff |
| `/git commit [message]` | Stage all changes and commit (auto-generates message from diff) |
| `/git branch <name> [src]` | Create branch (from src or current) |
| `/git pr <base> [title]` | Create PR to base branch (auto-generates title/body) |
| `/commit [message]` | Alias for `/git commit` |
| `/lisp <expr>` | Evaluate a lisp expression in the agent runtime |
| `/lisp strategies` | List all user-defined lisp strategies |
| `/lisp source <name>` | Show source of a strategy |
| `/lisp load <file>` | Load a .lisp file into the runtime |
| `/rebuild` | Rebuild coding-cli after self-modification |
| `/sidebar` | Open channel sidebar |
| `/quit`, `/exit` | Save and exit |

### Keybindings

| Key | Description |
|---|---|
| `Ctrl+X E` | Open `$EDITOR` with current line text (like bash `edit-and-execute-command`) |
| `Ctrl+X Tab` | Cycle agent mode |
| `Ctrl+B` | Open channel sidebar |
| `Ctrl+C` | Cancel current line / interrupt a running turn |
| `Ctrl+C Ctrl+C` | Quit (within 1 second) |

## Available Tools

The model has access to these tools during conversation:

| Tool | Description |
|---|---|
| `read_file` | Read file contents with line numbers. Supports `offset`/`limit` for large files. |
| `code_search` | Literal text search across code files (uses `grep`). Filter by extension. |
| `list_directory` | List directory contents (single level) with file sizes. |
| `directory_tree` | Recursive tree view with optional extension filter. Capped at 200 entries. |
| `find_files` | Find files by name glob or extension. Recursive. |
| `propose_write` | Propose creating or fully replacing a file (staged — requires approval). |
| `propose_edit` | Propose a targeted search-and-replace edit on an existing file (staged). |
| `propose_patch` | Propose a unified-diff patch on an existing file (staged). |
| `propose_exec` | Propose a shell command to execute (staged — requires approval). |
| `reject_write` | Cancel a previously staged write by token. |
| `run_typescript_validation` | Run `tsc --noEmit` and return compiler errors. |
| `run_tests` | Run the project's test command and return output. |
| `self_compact` | Compact the current conversation from within a tool call. |
| `run_subagent` | Spawn a subagent to handle a delegated task. |
| `self_identity` | Read or write the agent's identity fields. |
| `lisp_eval` | Evaluate a lisp expression in the persistent agent runtime. |
| `validate_self` | Validate coding-cli's own source (runs `tsc --noEmit` on the CLI itself). |

## Staged Writes

When the model proposes a file change, it is staged — not applied immediately. You will see a
summary with a token:

```
── staged writes ──

  ✓ src/utils.ts [S&R] token: a1b2c3d4
    - const old = 'value';
    + const updated = 'new value';

/approve to apply (or /approve all), /reject to discard
```

The `/approve` and `/reject` commands are flexible:

```
> /approve              # Auto-applies if there is only 1 pending write
                        # Shows numbered list if there are multiple

> /approve all          # Apply all pending writes at once
> /approve 1            # Apply by number (from the listed order)
> /approve a1b2c3d4     # Apply by exact token
> /approve a1b2         # Apply by token prefix (if unambiguous)

> /reject all           # Discard all pending writes
> /reject 2             # Discard by number
```

The same syntax works for staged exec (`propose_exec` calls from the model).

## Compaction, Auto-Trim, and Dedupe

**Compaction** — As conversations grow, use `/compact` to summarize older messages:

```
> /compact 20           # Keep 20 recent messages, summarize the rest
```

Compacted messages are marked dormant (excluded from API calls) and a dense summary is stored.
Summaries are injected into the system prompt automatically so the model retains long-term context.

Use `/new --carry` (or `/branch`) to start a fresh channel while carrying compaction summaries
and the system prompt — useful for continuing work without the full message history.

**Auto-Trim** — When the context window approaches its limit, older messages are automatically
trimmed to make room, preserving recent context and compaction summaries.

**Dedupe** — Duplicate or near-duplicate messages are detected and suppressed before being sent
to the API, preventing redundant context consumption.

## Lisp Runtime

The agent has access to a lisp interpreter via the `lisp_eval` tool. A standard library is loaded
at startup from `src/lisp/stdlib.lisp`. State persists to `~/.coding-cli/lisp/` between sessions,
so strategies and definitions survive across conversations.

Use `/lisp <expr>` to evaluate expressions directly from the REPL.

See `src/lisp/AGENT_GUIDE.md` for the full guide to writing and using strategies.

## Context Window Tracking

After each turn, a context utilization bar is displayed:

```
████████████░░░░░░░░ 58% · 116.2K/200K · ~8 turns left · cache 42%
```

The tracker monitors:
- **Utilization** — Current context window usage (green/yellow/red thresholds)
- **Burn rate** — Average context growth per turn
- **Turns remaining** — Estimated turns before hitting the window limit
- **Cache efficiency** — Percentage of input tokens served from the prompt cache

The REPL prompt also shows a compact utilization percentage: `[58%] >`

Use `/info` to see detailed context statistics, or `/state` to see the full ephemeral state
the model receives on each turn.

## Architecture

```
src/
├── index.ts              Entry point, auth detection, provider init, boot
├── repl.ts               Interactive readline loop, keybindings, tool registration
├── engine.ts             Multi-turn conversation engine with tool loop
├── commands.ts           Slash command handlers
├── channel.ts            Channel creation, persistence (JSON files)
├── state.ts              Ephemeral state injection (datetime, files, writes, context)
├── types.ts              Core type definitions (messages, channels, tools, providers)
├── presets.ts            Model presets per provider
├── modes.ts              Agent mode definitions
├── provider.ts           Provider abstraction and dispatch
├── auth.ts               Auth detection, provider construction
├── identity.ts           Agent self-identity storage and retrieval
├── autoTrim.ts           Automatic context trimming
├── dedupe.ts             Duplicate message detection
├── compaction.ts         Message summarization and dormancy
├── context.ts            Context window tracking and burn rate estimation
├── bootstrap.ts          Project orientation scan
├── prompts.ts            System prompt construction
├── subagent.ts           Background subagent management
├── selfAware.ts          Self-modification support (rebuild)
├── lispSetup.ts          lisp_eval tool construction
├── editor.ts             $EDITOR integration (temp file, sync spawn)
├── picker.ts             Interactive numbered-list picker
├── oauthFetch.ts         Custom fetch wrapper for Anthropic OAuth
├── zaiFetch.ts           Fetch wrapper for z.ai API
├── ollamaFetch.ts        Fetch wrapper for Ollama API
├── ollamaDiscovery.ts    Ollama model discovery
├── lmStudioFetch.ts      Fetch wrapper for LM Studio API
├── lmStudioDiscovery.ts  LM Studio model and server discovery
├── lisp/
│   ├── core.ts           Lisp runtime (eval, env, persistence)
│   ├── builtins.ts       Built-in functions
│   ├── stdlib.lisp       Standard library loaded at startup
│   ├── AGENT_GUIDE.md    Guide for writing and using strategies
│   └── ...               Reader, printer, types, bridge, env
├── tools/
│   ├── builtins.ts       File and search tool implementations
│   ├── staged.ts         Staged write tools (propose_write, propose_edit, propose_patch)
│   ├── stagedExec.ts     Staged exec tool (propose_exec)
│   ├── registry.ts       Tool registration, lookup, and dispatch
│   ├── runner.ts         Safe child_process.spawn with timeouts
│   ├── testRunner.ts     run_tests tool
│   ├── selfCompactTool.ts self_compact tool
│   ├── subagentTool.ts   run_subagent tool
│   ├── identityTool.ts   self_identity tool
│   └── dismissTool.ts    Tool dismissal support
└── ui/
    ├── index.ts          UI exports
    └── layout.ts         Terminal layout and rendering helpers
```

### Key Design Decisions

- **No Python dependency.** Tools use Node.js built-ins and `grep` instead of Python scripts.
- **Investigate-then-propose workflow.** The model must `read_file` before `propose_edit` — the search string must match exactly.
- **Tool loop with cap.** The engine auto-executes tool calls up to 25 steps per turn, then yields to the user.
- **Orphan cleanup.** If a session is interrupted mid-tool-call, orphaned `tool_use` blocks are stripped from history to prevent API errors.
- **Content-hash tracking.** Every file read is tracked with a SHA-256 hash, enabling drift detection for staged writes.
- **Compaction over truncation.** Old messages are summarized by the model and injected into the system prompt — preserving long-term context while freeing token budget.
- **Context-aware prompting.** The REPL prompt and post-turn display show real-time context utilization.

## Data Storage

All persistent data is stored in `~/.coding-cli/` (configurable via `CODING_CLI_DATA_DIR`):

```
~/.coding-cli/
├── auth/
│   └── anthropic_oauth.json    OAuth tokens (mode 0600)
├── channels/
│   ├── <uuid>.json             Channel data (messages, tracked files, pending writes, context)
│   └── ...
└── lisp/
    └── state.json              Lisp runtime state (definitions, strategies)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (alternative to OAuth) | — |
| `ANTHROPIC_BASE_URL` | Anthropic API base URL | `https://api.anthropic.com` |
| `ZHIPU_API_KEY` | z.ai API key | — |
| `ZAI_BASE_URL` | z.ai API base URL | `https://api.z.ai/api/coding/paas/v4` |
| `OLLAMA_BASE_URL` | Ollama server base URL | `http://localhost:11434` |
| `OLLAMA_DEBUG` | Enable Ollama discovery debug logging | — |
| `LMSTUDIO_BASE_URL` | LM Studio server base URL | `http://localhost:1234/v1` |
| `LM_STUDIO_DEBUG` | Enable LM Studio discovery debug logging | — |
| `CODING_CLI_DATA_DIR` | Custom data directory | `~/.coding-cli` |
| `EDITOR` | Editor for `/edit` and `Ctrl+X E` | `nvim` |
| `VISUAL` | Fallback editor if `$EDITOR` is not set | — |
| `CODING_CLI_SOUNDS` | Set to `1` to enable audio feedback | — |

## Development

```bash
# Build
npm run build

# Build and run
npm run dev

# Type check only
npx tsc --noEmit
```

## License

MIT
