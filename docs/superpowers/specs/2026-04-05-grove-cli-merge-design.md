# Grove-CLI Feature Merge — Design

**Date:** 2026-04-05
**Status:** Approved, ready for implementation planning

## Goal

Extract the `llm-agent.coding-cli` from the `kcg-ml-llm` monorepo into a standalone
repository at `/workspace/coding-cli`, hosted at `github.com/izzortsi/coding-cli`,
and port all grove-cli features into it. Final result is a single CLI with
coding-cli's multi-provider architecture (Anthropic/OAuth, z.ai, Ollama) plus
grove-cli's additions (lisp runtime, LM Studio provider, auto-trim/dedupe,
self-compact and test-runner tools, sounds, engineering-principles docs).

## Context

Two sibling TypeScript CLIs for multi-turn LLM conversations with tool use and
staged writes. They share ancestry (same file layout, same module names) but
diverged along different axes:

| Axis | coding-cli (wider) | grove-cli (deeper) |
|---|---|---|
| Providers | Anthropic + OAuth + z.ai + Ollama | Anthropic + OAuth + LM Studio |
| Provider architecture | preset/registry system | per-provider fetch modules |
| Non-interactive mode | `-p`/`-f`/`-q` flags | — |
| Lisp runtime | — | `src/lisp/*`, `lispSetup.ts`, stdlib.lisp |
| Auto-trim + dedupe | — | `autoTrim.ts`, `dedupe.ts` |
| Agent tools | staged/exec/dismiss/identity/subagent | + selfCompactTool, testRunner |
| Audio cues | — | `ui/sounds.ts` |
| Docs | — | 5 engineering-principle MDs |
| Auth layout | flat (`auth.ts`, `oauthFetch.ts`) | subfolder (`auth/{flow,oauth,oauthFetch}.ts`) |

coding-cli currently lives on branch `dev-izzortsi-coding-cli-agent` inside
`https://github.com/kk-digital/kcg-ml-llm.git` under path
`kcg-ml-llm/llm-agent.coding-cli/`. It has uncommitted changes that should be
committed before extraction.

## Approach

**Approach A: start from coding-cli, layer grove-cli features on top.**

Rationale: coding-cli's multi-provider architecture is structural (threaded
through `index.ts`, `repl.ts`, `auth.ts`, `provider.ts`, `presets.ts`, `engine.ts`).
Grove-cli's additions are mostly leaf files with small hook-ins. Treating
coding-cli as the skeleton and grafting grove-cli's features onto it is
significantly cheaper than the reverse.

Conflicts resolved: coding-cli's multi-provider architecture wins over any
grove-cli change that would reduce it.

## Repository Setup

- **Path:** `/workspace/coding-cli`
- **Remote:** `git@github.com:izzortsi/coding-cli.git` (new GitHub repo, to be
  created under `izzortsi`)
- **Default branch:** `main`
- **History strategy (option A2):** extract coding-cli's history from the
  monorepo using `git filter-repo --path kcg-ml-llm/llm-agent.coding-cli/`.
  This preserves commit-by-commit attribution for coding-cli's files while
  keeping a single-root repo. Grove-cli features are ported in as new commits
  on top, attributed properly in commit messages.
- **`.gitignore`:** merged from both sources (mostly overlapping:
  `node_modules/`, `dist/`, `.env`, `*.log`)

## File Merge Layout

### Group 1 — Pure additions (copy verbatim)

grove-cli has these, coding-cli does not:

```
src/autoTrim.ts
src/dedupe.ts
src/lispSetup.ts
src/lmStudioDiscovery.ts
src/lmStudioFetch.ts
src/ui/sounds.ts
src/tools/selfCompactTool.ts
src/tools/testRunner.ts
src/lisp/AGENT_GUIDE.md
src/lisp/bridge.ts
src/lisp/builtins.ts
src/lisp/core.ts
src/lisp/env.ts
src/lisp/eval.ts
src/lisp/persist.ts
src/lisp/printer.ts
src/lisp/reader.ts
src/lisp/stdlib.lisp
src/lisp/types.ts
docs/01_ENGINEERING_PRINCIPLES.md
docs/02_PERCEPTUAL_INTEGRITY.md
docs/03_PROCESS_AND_COLLABORATION.md
docs/04_SYSTEM_DESIGN_INVARIANTS.md
docs/05_PROFESSIONAL_INTEGRITY.md
docs/README.md
```

### Group 2 — Auth reorganization

Keep coding-cli's flat layout (`src/auth.ts`, `src/oauthFetch.ts`). Diff the
content of coding-cli's `src/auth.ts` against grove-cli's combined
`src/auth/{flow,oauth}.ts` and port any grove-cli improvements (newer token
refresh logic, PKCE fixes, storage handling) forward into coding-cli's
`src/auth.ts`. Same approach for `oauthFetch.ts`.

### Group 3 — Shared files that diverged (inspect-and-merge case-by-case)

Process: for each file, diff grove-cli against coding-cli. coding-cli is the
base. Port grove-cli changes forward only if they do not collide with
coding-cli's multi-provider architecture. On collision, coding-cli wins.

Files in this group:

```
src/engine.ts          src/repl.ts            src/state.ts
src/commands.ts        src/compaction.ts      src/context.ts
src/channel.ts         src/editor.ts          src/fileTracking.ts
src/identity.ts        src/modes.ts           src/picker.ts
src/prompts.ts         src/selfAware.ts       src/subagent.ts
src/index.ts           src/types.ts           src/provider.ts
src/tools/builtins.ts  src/tools/dismissTool.ts
src/tools/identityTool.ts  src/tools/registry.ts
src/tools/runner.ts    src/tools/scriptRegistry.ts
src/tools/staged.ts    src/tools/stagedExec.ts
src/tools/subagentTool.ts
src/ui/channelSidebar.ts  src/ui/colors.ts    src/ui/index.ts
src/ui/layout.ts       src/ui/markdown.ts     src/ui/markdownCore.ts
src/ui/rawSelect.ts    src/ui/spinner.ts      src/ui/streamRenderer.ts
```

Special-handling notes within Group 3:

- `engine.ts` — add autoTrim/dedupe hooks from grove-cli's version.
- `state.ts` — add trim-config display block from grove-cli's most recent
  commit ("show trim config in state injection").
- `commands.ts` — add slash-command surface for the new features (exact
  commands determined at implementation time by reading grove-cli's
  `commands.ts`).
- `subagent.ts` and `tools/subagentTool.ts` — add grove-cli's lisp bridge.
- `tools/builtins.ts` — register `selfCompactTool` and `testRunner`.

## Feature Integration

### Lisp runtime
Copy `src/lisp/*` verbatim. Wire up via `src/lispSetup.ts`, invoked once at
REPL bootstrap. The `subagent.ts` and `tools/subagentTool.ts` changes above
connect lisp to the agent tool loop. `stdlib.lisp` ships as a data file.
Runtime is orthogonal to the auth/provider layer.

### autoTrim + dedupe
Copy `autoTrim.ts`, `dedupe.ts`. Hook into `compaction.ts` at the points
grove-cli uses them. Expose via new slash commands in `commands.ts`.
Trim-config visible in `state.ts` injection.

### LM Studio provider (only architectural adaptation)
Grove-cli has `lmStudioDiscovery.ts` + `lmStudioFetch.ts` as plain fetch
utilities. Coding-cli uses a preset/provider registry. Plan:

1. Keep the wire-protocol content of `lmStudioFetch.ts` and
   `lmStudioDiscovery.ts` unchanged.
2. Add an `LmStudioProvider` class mirroring the shape of the existing
   `OllamaProvider`.
3. Add LM Studio presets to `src/presets.ts`.
4. Add LM Studio detection to `src/auth.ts` (discover server URL, health check,
   same pattern as Ollama).
5. Add `LMSTUDIO_BASE_URL` env var.

### selfCompactTool + testRunner
Copy both. Register in `tools/builtins.ts`. No further hooks.

### Sounds
Copy `ui/sounds.ts`. Hook at grove-cli's call sites (likely REPL on turn
completion and on staged-write notifications). Gated by env var or config
flag (default off) so terminal users without audio are not affected.

### Docs
Copy `docs/*` verbatim. No runtime impact.

## Package Identity

- **Name:** `coding-cli` (unchanged)
- **Version:** `0.2.0` (bump to mark the grove-cli feature integration)
- **Data dir:** `~/.coding-cli` (unchanged; `CODING_CLI_DATA_DIR` env var)
- **Binary:** `coding-cli` (unchanged)
- **Description:** updated to mention providers (Anthropic/OAuth/z.ai/Ollama/
  LM Studio), lisp runtime, staged writes, compaction
- **Dependencies:** unchanged (`@anthropic-ai/sdk`, `dotenv`, TypeScript).
  Neither lisp nor LM Studio introduce new deps.

## Documentation

- **README.md:** rewrite using grove-cli's README as template, adjusted for
  multiple providers, non-interactive mode flags, lisp runtime section, and
  LM Studio setup.
- **.env.example:** merge all vars — `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`,
  `ZHIPU_API_KEY`, `ZAI_BASE_URL`, `OLLAMA_BASE_URL`, `LMSTUDIO_BASE_URL`,
  `CODING_CLI_DATA_DIR`, `EDITOR`, `VISUAL`.

## Verification

1. `npx tsc --noEmit` → zero type errors
2. `npm run build` → clean build, no warnings
3. `node dist/index.js --help` → prints help
4. `node dist/index.js -p "hello" -q` → single-turn non-interactive mode runs
   with at least one configured provider
5. Interactive REPL boot with each configured provider (smoke test: start,
   confirm prompt renders, send one message, quit)
6. Lisp smoke test: one round trip through the agent lisp bridge
7. Staged write round trip: ask model to edit a file, verify staged-write flow
   works end-to-end
8. Each new slash command invoked once: `/autotrim`, `/dedupe`, and the
   self-compact tool exercised by the agent
