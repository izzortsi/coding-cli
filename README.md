# coding-cli

Terminal-native coding assistant. Multi-turn LLM conversations with tool use, staged writes, and an embedded Lisp runtime.

You chat. The model reads your codebase, proposes changes, runs commands. Nothing touches disk until you approve.

```
[46%] > refactor auth.ts to use the new provider interface
```

## Why

Claude Code and Cursor are great but closed. coding-cli is the same shape — tool-using agent, staged edits, context management — built as transparent TypeScript you can read, fork, and modify. The agent can even modify its own source (`/rebuild` to recompile).

Distinctive features:

- **Staged writes** — every file change is proposed, reviewed, approved. Same for shell commands.
- **Embedded Lisp runtime** — the agent has a persistent Lisp interpreter with 100+ strategies. Strategies are S-expressions the agent inspects, rewrites, and evolves. State survives across sessions.
- **Multi-provider** — Anthropic (API + OAuth), z.ai, Ollama, LM Studio. Auto-detected.
- **Context-aware** — live utilization bar, burn rate, turns remaining, cache hit rate. Compaction, auto-trim, and dedupe keep long conversations viable.
- **Subagents** — spawn background workers that run concurrently and inject results on join.
- **Self-modification** — the CLI can read and edit its own TypeScript source.

## Install

```bash
git clone https://github.com/your-org/coding-cli.git
cd coding-cli
npm install
npm run build
```

Requires Node.js 18+.

## Auth

Pick one:

| Provider | Setup |
|---|---|
| Anthropic API | `cp .env.example .env` → set `ANTHROPIC_API_KEY` |
| Anthropic OAuth (Pro/Max) | `node dist/index.js auth` (browser flow) |
| z.ai | Set `ZHIPU_API_KEY` in `.env` |
| Ollama | Start Ollama locally — auto-detected at `localhost:11434` |
| LM Studio | Start LM Studio with local server — auto-detected at `localhost:1234/v1` |

## Run

```bash
npm start
# or single-turn
node dist/index.js -p "what does auth.ts do?"
node dist/index.js -p "list providers" -f json -q
```

## Essential Commands

```
/help                    List all commands
/model [id]              Switch model (picker if no args)
/mode [name]             Switch agent mode
/bootstrap               Orient the model — scan project structure
/compact [keep]          Summarize older messages (keep last N)
/new <name>              New channel
/load [id|name]          Switch channel
/approve [all|n|token]   Approve staged writes/exec
/reject [all|n|token]    Discard staged writes/exec
/lisp <expr>             Evaluate in the agent's Lisp runtime
/git commit [msg]        Stage all + auto-generate commit message
/spawn <name> <task>     Background subagent
/edit                    Compose message in $EDITOR
/auto                    Full auto-approve loop (model runs until done)
/quit                    Save and exit
```

Full command reference: run `/help` inside the REPL.

## Keybindings

| Key | Action |
|---|---|
| `Ctrl+X E` | Open `$EDITOR` with current line |
| `Ctrl+X Tab` | Cycle agent mode |
| `Ctrl+B` | Open channel sidebar |
| `Ctrl+C` | Cancel line / interrupt turn |
| `Ctrl+C Ctrl+C` | Quit (within 1s) |

## Staged Writes

When the model proposes a change, it's staged with a token:

```
── staged writes ──
  ✓ src/utils.ts [S&R] token: a1b2c3d4
    - const old = 'value';
    + const updated = 'new value';

/approve to apply · /reject to discard
```

Flexible selectors:

```
/approve              # auto-applies if only 1 pending
/approve all          # apply all
/approve 2            # by number
/approve a1b2         # by token prefix
/reject all           # discard all
```

Same syntax works for staged exec.

## Tools Available to the Model

`read_file`, `code_search`, `list_directory`, `directory_tree`, `find_files`, `propose_write`, `propose_edit`, `propose_patch`, `propose_exec`, `reject_write`, `run_tests`, `validate_self`, `run_subagent`, `self_compact`, `self_identity`, `lisp_eval`, `dismiss_result`/`dismiss_results`.

## Context Management

After each turn:

```
████████████░░░░░░░░ 58% · 116.2K/200K · ~8 turns left · cache 42%
```

- **Compaction** — `/compact 20` summarizes older messages; summaries inject into the system prompt
- **Auto-Trim** — fires automatically when approaching window limit
- **Dedupe** — duplicate messages suppressed before API call
- **Branch** — `/branch` or `/new --carry` starts fresh while keeping summaries

Use `/info` for stats, `/state` to see what the model actually receives.

## Lisp Runtime

The agent has a persistent Lisp interpreter exposed via `lisp_eval`. Strategies are S-expressions — the agent inspects them as data, composes them into pipelines, and evolves them during self-improvement loops.

```lisp
(define (review-and-fix path)
  (pipeline path review-file heal))

(improve-strategy "safe-edit" "add nil guards and try/catch")
```

State persists to `~/.coding-cli/lisp/state.json`. See `src/lisp/AGENT_GUIDE.md` for the full strategy guide.

Evaluate from the REPL:

```
/lisp (self-test)
/lisp strategies
/lisp source safe-edit
```

## Architecture

```
src/
├── index.ts              Entry point, auth detection, boot
├── repl.ts               Interactive readline loop, keybindings
├── engine.ts             Multi-turn conversation engine with tool loop
├── commands.ts           Slash command handlers
├── channel.ts            Channel creation, persistence
├── state.ts              Ephemeral state injection
├── provider.ts           Provider abstraction (Anthropic/z.ai/Ollama/LM Studio)
├── auth.ts               Auth detection and OAuth login
├── compaction.ts         Message summarization and dormancy
├── context.ts            Context window tracking, burn rate
├── autoTrim.ts           Automatic context trimming
├── dedupe.ts             Duplicate message detection
├── subagent.ts           Background subagent management
├── selfAware.ts          Self-modification support
├── lisp/
│   ├── core.ts           Lisp runtime (eval, env, persistence)
│   ├── builtins.ts       Built-in functions
│   ├── stdlib.lisp       Standard library loaded at startup
│   └── AGENT_GUIDE.md    Strategy-writing guide
├── tools/
│   ├── builtins.ts       File/search tools
│   ├── staged.ts         propose_write, propose_edit, propose_patch
│   ├── stagedExec.ts     propose_exec
│   ├── registry.ts       Tool registration and dispatch
│   └── ...
└── ui/
    └── layout.ts         Terminal rendering helpers
```

### Design Decisions

- **No Python.** Tools use Node built-ins and `grep`.
- **Investigate-then-propose.** The model must `read_file` before `propose_edit` — SEARCH content must match exactly.
- **Tool loop with cap.** 25 steps per turn, then yields to user.
- **Orphan cleanup.** Interrupted tool_use blocks are stripped from history.
- **Content-hash tracking.** Every read stores a SHA-256 hash for drift detection.
- **Compaction over truncation.** Old messages are summarized, not deleted.

## Data Storage

```
~/.coding-cli/                   (override: CODING_CLI_DATA_DIR)
├── auth/
│   └── anthropic_oauth.json     (mode 0600)
├── channels/
│   └── <uuid>.json              messages, tracked files, staged writes
└── lisp/
    └── state.json               persisted strategies and definitions
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `ANTHROPIC_BASE_URL` | Anthropic API base URL | `https://api.anthropic.com` |
| `ZHIPU_API_KEY` | z.ai API key | — |
| `ZAI_BASE_URL` | z.ai API base URL | `https://api.z.ai/api/coding/paas/v4` |
| `OLLAMA_BASE_URL` | Ollama server | `http://localhost:11434` |
| `LMSTUDIO_BASE_URL` | LM Studio server | `http://localhost:1234/v1` |
| `CODING_CLI_DATA_DIR` | Data directory | `~/.coding-cli` |
| `EDITOR` / `VISUAL` | Editor for `/edit` | `nvim` |
| `CODING_CLI_SOUNDS` | Set `1` for audio feedback | — |

## Development

```bash
npm run build        # tsc
npm run dev          # tsc && node dist/index.js
npx tsc --noEmit     # type check only
```

## License

MIT
