# Grove-CLI Feature Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `llm-agent.coding-cli` from the `kcg-ml-llm` monorepo into a standalone repository at `/workspace/coding-cli` (remote `github.com/izzortsi/coding-cli`) and port grove-cli's features on top of coding-cli's multi-provider architecture.

**Architecture:** coding-cli is the skeleton (multi-provider preset/registry system, non-interactive mode, z.ai/Ollama/Anthropic/OAuth). Grove-cli features grafted on top: lisp runtime, LM Studio provider (adapted to preset system), auto-trim/dedupe, self-compact + test-runner tools, sounds, engineering-principles docs. Where shared files have diverged, coding-cli wins on architectural conflicts.

**Tech Stack:** TypeScript 5.7, Node.js 18+, `@anthropic-ai/sdk`, `dotenv`, `git filter-repo`.

**Source paths referenced:**
- Monorepo root: `/workspace/kcg-ml-llm` (git root, branch `dev-izzortsi-coding-cli-agent`)
- Source subfolder: `llm-agent.coding-cli/`
- Grove-cli: `/workspace/grove-cli` (reference, read-only)
- Target: `/workspace/coding-cli` (to be created)

---

## Phase 1: Repository Extraction

### Task 1: Install git-filter-repo

**Files:** none

- [ ] **Step 1: Check whether git-filter-repo is already installed**

Run: `git filter-repo --version 2>&1 || echo "not installed"`
Expected: either a version string (skip to Task 2) or "not installed".

- [ ] **Step 2: Install git-filter-repo via pip**

Run: `pip install --user git-filter-repo`
Expected: successful install; a `git-filter-repo` binary appears on PATH (may require `~/.local/bin` on PATH).

- [ ] **Step 3: Verify installation**

Run: `git filter-repo --version`
Expected: prints a version number (e.g. `2.45.0`).

If `git filter-repo` is still not found, add `~/.local/bin` to PATH and retry: `export PATH="$HOME/.local/bin:$PATH"`.

### Task 2: Commit outstanding coding-cli changes on the feature branch

**Files:**
- Modify: `/workspace/kcg-ml-llm/llm-agent.coding-cli/src/repl.ts`
- Modify: `/workspace/kcg-ml-llm/llm-agent.coding-cli/src/tools/subagentTool.ts`
- Modify: `/workspace/kcg-ml-llm/llm-agent.coding-cli/src/ui/index.ts`
- Modify: `/workspace/kcg-ml-llm/llm-agent.coding-cli/src/ui/layout.ts`

Context: there are uncommitted modifications to four files from the user's recent work. They must be committed before filter-repo runs, otherwise they will not be in the extracted repo.

- [ ] **Step 1: Review uncommitted diff**

Run:
```
cd /workspace/kcg-ml-llm
git diff --stat llm-agent.coding-cli/
```
Expected: the four modified files listed above.

- [ ] **Step 2: Review full diff to write an accurate commit message**

Run: `git diff llm-agent.coding-cli/`
Read the output to understand what changed.

- [ ] **Step 3: Stage only the coding-cli changes and commit**

Run:
```
cd /workspace/kcg-ml-llm
git add llm-agent.coding-cli/src/repl.ts \
        llm-agent.coding-cli/src/tools/subagentTool.ts \
        llm-agent.coding-cli/src/ui/index.ts \
        llm-agent.coding-cli/src/ui/layout.ts
git commit -m "wip: in-progress coding-cli changes pre-extraction"
```
Expected: single commit on `dev-izzortsi-coding-cli-agent`.

Note: the commit message is deliberately `wip:` because without reading the diff we don't know the purpose. If the diff reveals a coherent change, rewrite the message to describe it.

- [ ] **Step 4: Verify working tree is clean for coding-cli paths**

Run: `git status llm-agent.coding-cli/`
Expected: "nothing to commit".

### Task 3: Clone monorepo into a throwaway working directory for filter-repo

**Files:** none

Context: `git filter-repo` rewrites history destructively. It must run in a fresh clone, not the user's working copy.

- [ ] **Step 1: Clone the monorepo to a scratch location**

Run:
```
cd /tmp
git clone --branch dev-izzortsi-coding-cli-agent /workspace/kcg-ml-llm kcg-ml-llm-extract
cd kcg-ml-llm-extract
```
Expected: clone succeeds, HEAD is on `dev-izzortsi-coding-cli-agent`.

- [ ] **Step 2: Verify the clone sees the right content**

Run: `ls llm-agent.coding-cli | head -5`
Expected: `.env.example .gitignore dist docs node_modules` (or similar).

- [ ] **Step 3: Verify filter-repo safety check will pass**

Run: `git log --oneline -3`
Expected: shows the `wip:` commit from Task 2 at HEAD.

### Task 4: Run filter-repo to extract the coding-cli subtree

**Files:** all

Context: extracts history for files under `llm-agent.coding-cli/` and rewrites paths so that subfolder's contents become the repo root.

- [ ] **Step 1: Run filter-repo**

Run:
```
cd /tmp/kcg-ml-llm-extract
git filter-repo --path llm-agent.coding-cli/ --path-rename llm-agent.coding-cli/:
```
Expected: filter-repo runs to completion, prints a summary including "New history written".

- [ ] **Step 2: Verify the result looks right**

Run:
```
ls
git log --oneline | head -5
```
Expected: top-level directory contains `src/`, `package.json`, `README.md`, `.gitignore`, `docs/`, etc. (i.e. the former contents of `llm-agent.coding-cli/`). History contains only commits that touched those files.

- [ ] **Step 3: Verify the spec file made it**

Run: `ls docs/superpowers/specs/`
Expected: contains `2026-04-05-grove-cli-merge-design.md`.

- [ ] **Step 4: Move the extracted repo to its final location**

Run:
```
mv /tmp/kcg-ml-llm-extract /workspace/coding-cli
cd /workspace/coding-cli
```
Expected: `/workspace/coding-cli` now exists with the extracted repo inside.

- [ ] **Step 5: Rename the current branch to `main`**

Run:
```
cd /workspace/coding-cli
git branch -m dev-izzortsi-coding-cli-agent main
git log --oneline -1
```
Expected: HEAD is on `main`, latest commit is the `wip:` one from Task 2.

### Task 5: Configure git remote

**Files:** none

Context: link the new repo to its forthcoming GitHub home.

- [ ] **Step 1: Remove the inherited origin (points at the monorepo)**

Run:
```
cd /workspace/coding-cli
git remote -v
git remote remove origin
```
Expected: origin removed. (If no origin existed, ignore the "no such remote" error.)

- [ ] **Step 2: Add the new origin**

Run: `git remote add origin git@github.com:izzortsi/coding-cli.git`
Expected: no output (success).

- [ ] **Step 3: Verify remote configuration**

Run: `git remote -v`
Expected: both fetch and push point to `git@github.com:izzortsi/coding-cli.git`.

Note: the GitHub repo must be created manually (or via `gh repo create izzortsi/coding-cli --private --source=. --remote=origin`) before `git push -u origin main` will succeed. Creating the GitHub repo is outside the scope of this plan.

### Task 6: Baseline build check

**Files:** none

Context: establish that the extracted repo builds cleanly before we start porting grove-cli features. Any failures here are pre-existing.

- [ ] **Step 1: Install dependencies**

Run:
```
cd /workspace/coding-cli
npm install
```
Expected: node_modules populated, no errors.

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean build; `dist/` populated.

- [ ] **Step 4: Smoke test help output**

Run: `node dist/index.js --help`
Expected: prints help text.

- [ ] **Step 5: Commit the extraction milestone**

Run:
```
git add -A
git status
git commit -m "chore: extract coding-cli from kcg-ml-llm monorepo

Repository extracted using git filter-repo with --path
llm-agent.coding-cli/ and --path-rename to strip the prefix.
Branch renamed to main. Remote reset to
git@github.com:izzortsi/coding-cli.git. Baseline build verified
clean." --allow-empty
```
Expected: if there's nothing new to commit, `--allow-empty` creates a checkpoint commit documenting the extraction.

---

## Phase 2: Pure Additions from Grove-CLI (Group 1)

### Task 7: Copy grove-cli engineering docs

**Files:**
- Create: `/workspace/coding-cli/docs/01_ENGINEERING_PRINCIPLES.md`
- Create: `/workspace/coding-cli/docs/02_PERCEPTUAL_INTEGRITY.md`
- Create: `/workspace/coding-cli/docs/03_PROCESS_AND_COLLABORATION.md`
- Create: `/workspace/coding-cli/docs/04_SYSTEM_DESIGN_INVARIANTS.md`
- Create: `/workspace/coding-cli/docs/05_PROFESSIONAL_INTEGRITY.md`
- Create: `/workspace/coding-cli/docs/README.md`

- [ ] **Step 1: Copy the six doc files from grove-cli**

Run:
```
cp /workspace/grove-cli/docs/01_ENGINEERING_PRINCIPLES.md /workspace/coding-cli/docs/
cp /workspace/grove-cli/docs/02_PERCEPTUAL_INTEGRITY.md /workspace/coding-cli/docs/
cp /workspace/grove-cli/docs/03_PROCESS_AND_COLLABORATION.md /workspace/coding-cli/docs/
cp /workspace/grove-cli/docs/04_SYSTEM_DESIGN_INVARIANTS.md /workspace/coding-cli/docs/
cp /workspace/grove-cli/docs/05_PROFESSIONAL_INTEGRITY.md /workspace/coding-cli/docs/
cp /workspace/grove-cli/docs/README.md /workspace/coding-cli/docs/README.md
```
Expected: files created.

- [ ] **Step 2: Verify**

Run: `ls /workspace/coding-cli/docs/`
Expected: six new `.md` files plus the existing `superpowers/` subfolder.

- [ ] **Step 3: Commit**

Run:
```
cd /workspace/coding-cli
git add docs/
git commit -m "docs: import grove-cli engineering principles docs"
```

### Task 8: Copy the lisp runtime subsystem

**Files:**
- Create: `/workspace/coding-cli/src/lisp/AGENT_GUIDE.md`
- Create: `/workspace/coding-cli/src/lisp/bridge.ts`
- Create: `/workspace/coding-cli/src/lisp/builtins.ts`
- Create: `/workspace/coding-cli/src/lisp/core.ts`
- Create: `/workspace/coding-cli/src/lisp/env.ts`
- Create: `/workspace/coding-cli/src/lisp/eval.ts`
- Create: `/workspace/coding-cli/src/lisp/persist.ts`
- Create: `/workspace/coding-cli/src/lisp/printer.ts`
- Create: `/workspace/coding-cli/src/lisp/reader.ts`
- Create: `/workspace/coding-cli/src/lisp/stdlib.lisp`
- Create: `/workspace/coding-cli/src/lisp/types.ts`

Context: self-contained lisp runtime from grove-cli. Orthogonal to auth/provider layer; no coding-cli-specific adaptation needed here.

- [ ] **Step 1: Copy the lisp/ directory wholesale**

Run:
```
cp -r /workspace/grove-cli/src/lisp /workspace/coding-cli/src/lisp
ls /workspace/coding-cli/src/lisp
```
Expected: 11 files listed.

- [ ] **Step 2: Type-check to see what imports break**

Run: `cd /workspace/coding-cli && npx tsc --noEmit 2>&1 | head -40`
Expected: type errors likely reference missing imports from `../` since lisp files may import siblings that don't exist yet. Note the errors — they'll be resolved as other modules are copied or merged.

- [ ] **Step 3: Commit**

Run:
```
cd /workspace/coding-cli
git add src/lisp/
git commit -m "feat(lisp): import lisp runtime subsystem from grove-cli"
```

### Task 9: Copy standalone grove-cli modules

**Files:**
- Create: `/workspace/coding-cli/src/autoTrim.ts`
- Create: `/workspace/coding-cli/src/dedupe.ts`
- Create: `/workspace/coding-cli/src/lispSetup.ts`
- Create: `/workspace/coding-cli/src/lmStudioDiscovery.ts`
- Create: `/workspace/coding-cli/src/lmStudioFetch.ts`
- Create: `/workspace/coding-cli/src/ui/sounds.ts`

- [ ] **Step 1: Copy the six files**

Run:
```
cp /workspace/grove-cli/src/autoTrim.ts /workspace/coding-cli/src/autoTrim.ts
cp /workspace/grove-cli/src/dedupe.ts /workspace/coding-cli/src/dedupe.ts
cp /workspace/grove-cli/src/lispSetup.ts /workspace/coding-cli/src/lispSetup.ts
cp /workspace/grove-cli/src/lmStudioDiscovery.ts /workspace/coding-cli/src/lmStudioDiscovery.ts
cp /workspace/grove-cli/src/lmStudioFetch.ts /workspace/coding-cli/src/lmStudioFetch.ts
cp /workspace/grove-cli/src/ui/sounds.ts /workspace/coding-cli/src/ui/sounds.ts
```
Expected: files present.

- [ ] **Step 2: Read each file to confirm it only imports from known modules**

Run: `grep -n "^import" /workspace/coding-cli/src/autoTrim.ts /workspace/coding-cli/src/dedupe.ts /workspace/coding-cli/src/lispSetup.ts /workspace/coding-cli/src/lmStudioDiscovery.ts /workspace/coding-cli/src/lmStudioFetch.ts /workspace/coding-cli/src/ui/sounds.ts`
Expected: note all import paths; identify any that reference modules not present in coding-cli.

- [ ] **Step 3: Commit**

Run:
```
cd /workspace/coding-cli
git add src/autoTrim.ts src/dedupe.ts src/lispSetup.ts src/lmStudioDiscovery.ts src/lmStudioFetch.ts src/ui/sounds.ts
git commit -m "feat: import grove-cli modules (autoTrim, dedupe, lispSetup, lmStudio, sounds)"
```

### Task 10: Copy new agent tools

**Files:**
- Create: `/workspace/coding-cli/src/tools/selfCompactTool.ts`
- Create: `/workspace/coding-cli/src/tools/testRunner.ts`

- [ ] **Step 1: Copy the two tool files**

Run:
```
cp /workspace/grove-cli/src/tools/selfCompactTool.ts /workspace/coding-cli/src/tools/selfCompactTool.ts
cp /workspace/grove-cli/src/tools/testRunner.ts /workspace/coding-cli/src/tools/testRunner.ts
```

- [ ] **Step 2: Commit**

Run:
```
cd /workspace/coding-cli
git add src/tools/selfCompactTool.ts src/tools/testRunner.ts
git commit -m "feat(tools): import selfCompactTool and testRunner from grove-cli"
```

### Task 11: Type-check baseline after pure additions

**Files:** none

Context: establish what's broken before we start merging shared files. Any errors now are from: (a) new grove-cli files importing siblings that haven't been merged yet, or (b) conflicts with coding-cli's type definitions.

- [ ] **Step 1: Type check**

Run: `cd /workspace/coding-cli && npx tsc --noEmit 2>&1 | tee /tmp/baseline-tc.log | tail -30`
Expected: likely errors — read them all. Note which files are source of errors vs consumers of missing exports.

- [ ] **Step 2: Categorize errors**

For each error in `/tmp/baseline-tc.log`, note:
- Which grove-cli file raises it
- What coding-cli symbol/type it references
- Whether the coding-cli symbol exists under a different name or structure

This categorization informs how Group 3 shared-file merges need to proceed.

---

## Phase 3: Merge Shared Files (Group 3)

For every task in this phase, the pattern is:
1. `diff -u` grove-cli's file against coding-cli's current file
2. Identify grove-cli-only changes that are **additive** (new fields, new branches, new helper functions)
3. Identify grove-cli-only changes that **conflict** with coding-cli's multi-provider architecture — skip those (coding-cli wins)
4. Apply the additive changes to coding-cli's file using the Edit tool
5. Type check and fix any fallout
6. Commit

### Task 12: Merge src/types.ts

**Files:**
- Modify: `/workspace/coding-cli/src/types.ts`
- Reference: `/workspace/grove-cli/src/types.ts`

Context: types are the foundation. Grove-cli may have added new type fields used by autoTrim/dedupe/lisp/LM Studio. These additions are cheap to bring in first.

- [ ] **Step 1: Diff the two files**

Run: `diff -u /workspace/coding-cli/src/types.ts /workspace/grove-cli/src/types.ts | head -200`
Read carefully. Any line starting with `+` in grove-cli's column is a candidate addition.

- [ ] **Step 2: For each additive grove-cli change, apply it to coding-cli's types.ts**

Use the Edit tool, one change at a time. Look specifically for:
- New fields on `Channel` type (likely: autoTrim config, dedupe state, lisp env ref)
- New fields on `Message` type (likely: dormancy markers for compaction)
- New types for LM Studio provider shape
- New types for lisp state

Skip any grove-cli change that removes a multi-provider field coding-cli has (e.g. `providerId` on a preset).

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: probably still broken elsewhere, but `types.ts` itself should compile.

- [ ] **Step 4: Commit**

Run:
```
cd /workspace/coding-cli
git add src/types.ts
git commit -m "types: add fields for autoTrim/dedupe/lisp/LM Studio from grove-cli"
```

### Task 13: Merge src/engine.ts (add autoTrim/dedupe hooks)

**Files:**
- Modify: `/workspace/coding-cli/src/engine.ts`
- Reference: `/workspace/grove-cli/src/engine.ts`

Context: grove-cli calls autoTrim and dedupe inside the conversation engine's turn loop. These calls must be ported into coding-cli's engine.

- [ ] **Step 1: Diff the two files**

Run: `diff -u /workspace/coding-cli/src/engine.ts /workspace/grove-cli/src/engine.ts > /tmp/engine.diff && wc -l /tmp/engine.diff && head -100 /tmp/engine.diff`
Read the full diff.

- [ ] **Step 2: Identify autoTrim/dedupe call sites in grove-cli's engine**

Run: `grep -n "autoTrim\|dedupe" /workspace/grove-cli/src/engine.ts`
Expected: a handful of lines. Note function call positions (pre-turn vs post-turn, before tool-loop vs after).

- [ ] **Step 3: Port the autoTrim/dedupe hook calls into coding-cli's engine**

Use Edit to add the imports and the call sites in matching positions. Preserve all coding-cli-specific engine logic (provider abstraction, preset handling).

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit 2>&1 | grep -E "engine\.ts|autoTrim|dedupe" | head -10`
Fix any type errors introduced.

- [ ] **Step 5: Commit**

Run:
```
git add src/engine.ts
git commit -m "engine: add autoTrim and dedupe hooks from grove-cli"
```

### Task 14: Merge src/compaction.ts

**Files:**
- Modify: `/workspace/coding-cli/src/compaction.ts`
- Reference: `/workspace/grove-cli/src/compaction.ts`

Context: grove-cli integrates dedupe into compaction and may have improved the summarization prompt or dormancy logic.

- [ ] **Step 1: Diff and read**

Run: `diff -u /workspace/coding-cli/src/compaction.ts /workspace/grove-cli/src/compaction.ts | head -200`

- [ ] **Step 2: Port additive grove-cli changes**

Use Edit to apply each additive change. Likely candidates:
- dedupe call prior to compaction
- refinements to the summary prompt
- changes to dormancy marker handling

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit 2>&1 | grep compaction.ts | head -10`

- [ ] **Step 4: Commit**

Run:
```
git add src/compaction.ts
git commit -m "compaction: integrate dedupe and port grove-cli improvements"
```

### Task 15: Merge src/state.ts (trim-config display)

**Files:**
- Modify: `/workspace/coding-cli/src/state.ts`
- Reference: `/workspace/grove-cli/src/state.ts`

Context: grove-cli's most recent commit "show trim config in state injection" adds trim-config visibility to the ephemeral-state block the model sees every turn.

- [ ] **Step 1: Diff**

Run: `diff -u /workspace/coding-cli/src/state.ts /workspace/grove-cli/src/state.ts | head -100`

- [ ] **Step 2: Port the trim-config display block**

Use Edit to add the new state section where grove-cli emits it.

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit 2>&1 | grep state.ts | head -10`

- [ ] **Step 4: Commit**

Run:
```
git add src/state.ts
git commit -m "state: show trim config in ephemeral state injection (from grove-cli)"
```

### Task 16: Merge src/subagent.ts and src/tools/subagentTool.ts (lisp bridge)

**Files:**
- Modify: `/workspace/coding-cli/src/subagent.ts`
- Modify: `/workspace/coding-cli/src/tools/subagentTool.ts`
- Reference: `/workspace/grove-cli/src/subagent.ts`
- Reference: `/workspace/grove-cli/src/tools/subagentTool.ts`

Context: grove-cli wires lisp as a sub-agent or as a tool. The lisp bridge (`src/lisp/bridge.ts`) is the interface between the TypeScript side and the lisp interpreter.

- [ ] **Step 1: Diff both files**

Run:
```
diff -u /workspace/coding-cli/src/subagent.ts /workspace/grove-cli/src/subagent.ts | head -200
diff -u /workspace/coding-cli/src/tools/subagentTool.ts /workspace/grove-cli/src/tools/subagentTool.ts | head -200
```

- [ ] **Step 2: Inspect the bridge API**

Run: `grep -n "^export" /workspace/coding-cli/src/lisp/bridge.ts`
Note exported functions — these are called from `subagent.ts` or `subagentTool.ts`.

- [ ] **Step 3: Port lisp-bridge additions into subagent.ts**

Use Edit to add the lisp invocation path.

- [ ] **Step 4: Port lisp-bridge additions into tools/subagentTool.ts**

Use Edit. Note: Task 2 committed pre-existing modifications to this file; reconcile those with grove-cli's changes.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit 2>&1 | grep -E "subagent" | head -20`

- [ ] **Step 6: Commit**

Run:
```
git add src/subagent.ts src/tools/subagentTool.ts
git commit -m "subagent: wire lisp bridge from grove-cli"
```

### Task 17: Merge src/tools/builtins.ts (register selfCompactTool + testRunner)

**Files:**
- Modify: `/workspace/coding-cli/src/tools/builtins.ts`
- Reference: `/workspace/grove-cli/src/tools/builtins.ts`

Context: new tools must be added to the `buildBuiltinTools(projectRoot)` list returned by this file.

- [ ] **Step 1: Diff**

Run: `diff -u /workspace/coding-cli/src/tools/builtins.ts /workspace/grove-cli/src/tools/builtins.ts | head -100`

- [ ] **Step 2: Identify the registration pattern**

Look at how existing tools (e.g. `stagedExec`, `identityTool`) are imported and added to the returned list in coding-cli's `builtins.ts`.

- [ ] **Step 3: Add selfCompactTool and testRunner to the registry**

Use Edit:
- Add `import { selfCompactTool } from './selfCompactTool.js';`
- Add `import { testRunnerTool } from './testRunner.js';` (check exact exported name)
- Add them to the tools array in the matching position from grove-cli.

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit 2>&1 | grep builtins.ts | head -10`

- [ ] **Step 5: Commit**

Run:
```
git add src/tools/builtins.ts
git commit -m "tools: register selfCompactTool and testRunner as builtins"
```

### Task 18: Merge src/commands.ts (new slash commands)

**Files:**
- Modify: `/workspace/coding-cli/src/commands.ts`
- Reference: `/workspace/grove-cli/src/commands.ts`

Context: grove-cli has user-facing slash commands for new features. Likely candidates: autoTrim config, dedupe, lisp REPL, self-compact invocation. Exact names determined by reading grove-cli's file.

- [ ] **Step 1: Diff**

Run: `diff -u /workspace/coding-cli/src/commands.ts /workspace/grove-cli/src/commands.ts > /tmp/commands.diff && wc -l /tmp/commands.diff && head -200 /tmp/commands.diff`

- [ ] **Step 2: List new slash commands in grove-cli's version**

Run: `grep -nE "case '/" /workspace/grove-cli/src/commands.ts | head -40`

Compare with: `grep -nE "case '/" /workspace/coding-cli/src/commands.ts | head -40`

Note the grove-cli-only entries.

- [ ] **Step 3: Port each grove-cli-only slash command handler**

Use Edit. For each new command, copy the `case '/xxx':` block from grove-cli verbatim into coding-cli's commands.ts, inserted in the switch statement.

- [ ] **Step 4: Port the help text updates**

If grove-cli's `/help` output includes the new commands, update coding-cli's help text to match.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit 2>&1 | grep commands.ts | head -10`

- [ ] **Step 6: Commit**

Run:
```
git add src/commands.ts
git commit -m "commands: add slash commands for autoTrim/dedupe/lisp/self-compact"
```

### Task 19: Merge src/repl.ts (sounds hook + other UI changes)

**Files:**
- Modify: `/workspace/coding-cli/src/repl.ts`
- Reference: `/workspace/grove-cli/src/repl.ts`

- [ ] **Step 1: Diff**

Run: `diff -u /workspace/coding-cli/src/repl.ts /workspace/grove-cli/src/repl.ts > /tmp/repl.diff && wc -l /tmp/repl.diff && head -200 /tmp/repl.diff`

- [ ] **Step 2: Find sounds call sites**

Run: `grep -n "sounds\|playSound" /workspace/grove-cli/src/repl.ts`

- [ ] **Step 3: Port the sounds import and call sites**

Use Edit. Add the sounds import and the calls at matching positions. Gate the calls behind an env var (e.g. `process.env.CODING_CLI_SOUNDS === '1'`) so default behaviour is silent.

- [ ] **Step 4: Port any other additive grove-cli REPL changes**

Look for: prompt format tweaks, new keybindings, context-bar additions. Skip anything that touches the non-interactive mode logic (coding-cli-specific).

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit 2>&1 | grep repl.ts | head -10`

- [ ] **Step 6: Commit**

Run:
```
git add src/repl.ts
git commit -m "repl: wire sounds hook and port grove-cli ui tweaks"
```

### Task 20: Merge remaining shared files (batch)

**Files:**
- Modify: `/workspace/coding-cli/src/channel.ts`
- Modify: `/workspace/coding-cli/src/context.ts`
- Modify: `/workspace/coding-cli/src/editor.ts`
- Modify: `/workspace/coding-cli/src/fileTracking.ts`
- Modify: `/workspace/coding-cli/src/identity.ts`
- Modify: `/workspace/coding-cli/src/modes.ts`
- Modify: `/workspace/coding-cli/src/picker.ts`
- Modify: `/workspace/coding-cli/src/prompts.ts`
- Modify: `/workspace/coding-cli/src/selfAware.ts`
- Modify: `/workspace/coding-cli/src/bootstrap.ts`
- Modify: `/workspace/coding-cli/src/index.ts`
- Reference: `/workspace/grove-cli/src/<same>.ts`

Context: these files have likely diverged but not dramatically. Process each one in turn using the same diff-and-port pattern.

- [ ] **Step 1: Generate diffs for all eleven files**

Run:
```
cd /workspace
for f in channel context editor fileTracking identity modes picker prompts selfAware bootstrap index; do
  echo "=== $f ==="
  diff -u coding-cli/src/$f.ts grove-cli/src/$f.ts | wc -l
done
```
Expected: for each file, a diff line count. Zero means identical (skip). Large counts need closer reading.

- [ ] **Step 2: For each non-zero diff, inspect and port**

For each file with non-zero diff, run `diff -u coding-cli/src/$f.ts grove-cli/src/$f.ts` and apply additive changes via Edit.

Key file-specific guidance:
- `src/bootstrap.ts`: port the `lispSetup()` call if grove-cli calls it here.
- `src/index.ts`: skip any provider-detection changes (coding-cli's multi-provider detection wins). Port any additive init logic.
- `src/prompts.ts`: grove-cli may have updated `DEFAULT_SYSTEM_PROMPT` to mention lisp or new tools. Port that.
- `src/selfAware.ts`, `src/identity.ts`: usually stable, small diffs.

- [ ] **Step 3: Type check after each file**

After porting each file, run `npx tsc --noEmit 2>&1 | tail -20` and fix errors before moving to the next file.

- [ ] **Step 4: Commit the batch**

Run:
```
cd /workspace/coding-cli
git add src/channel.ts src/context.ts src/editor.ts src/fileTracking.ts src/identity.ts src/modes.ts src/picker.ts src/prompts.ts src/selfAware.ts src/bootstrap.ts src/index.ts
git commit -m "merge: port additive grove-cli changes to shared files"
```

### Task 21: Merge UI files (batch)

**Files:**
- Modify: `/workspace/coding-cli/src/ui/channelSidebar.ts`
- Modify: `/workspace/coding-cli/src/ui/colors.ts`
- Modify: `/workspace/coding-cli/src/ui/index.ts`
- Modify: `/workspace/coding-cli/src/ui/layout.ts`
- Modify: `/workspace/coding-cli/src/ui/markdown.ts`
- Modify: `/workspace/coding-cli/src/ui/markdownCore.ts`
- Modify: `/workspace/coding-cli/src/ui/rawSelect.ts`
- Modify: `/workspace/coding-cli/src/ui/spinner.ts`
- Modify: `/workspace/coding-cli/src/ui/streamRenderer.ts`

- [ ] **Step 1: Diff all nine UI files**

Run:
```
cd /workspace
for f in channelSidebar colors index layout markdown markdownCore rawSelect spinner streamRenderer; do
  echo "=== ui/$f ==="
  diff -u coding-cli/src/ui/$f.ts grove-cli/src/ui/$f.ts | wc -l
done
```

- [ ] **Step 2: For each non-zero diff, inspect and port**

Same pattern as Task 20. Be especially attentive to `ui/index.ts` and `ui/layout.ts` — Task 2 committed user edits there; reconcile with grove-cli's additions.

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit 2>&1 | grep "ui/" | head -20`

- [ ] **Step 4: Commit**

Run:
```
git add src/ui/
git commit -m "merge: port additive grove-cli changes to ui modules"
```

### Task 22: Merge remaining tools files (batch)

**Files:**
- Modify: `/workspace/coding-cli/src/tools/dismissTool.ts`
- Modify: `/workspace/coding-cli/src/tools/identityTool.ts`
- Modify: `/workspace/coding-cli/src/tools/registry.ts`
- Modify: `/workspace/coding-cli/src/tools/runner.ts`
- Modify: `/workspace/coding-cli/src/tools/scriptRegistry.ts`
- Modify: `/workspace/coding-cli/src/tools/staged.ts`
- Modify: `/workspace/coding-cli/src/tools/stagedExec.ts`

- [ ] **Step 1: Diff all seven tools files**

Run:
```
cd /workspace
for f in dismissTool identityTool registry runner scriptRegistry staged stagedExec; do
  echo "=== tools/$f ==="
  diff -u coding-cli/src/tools/$f.ts grove-cli/src/tools/$f.ts | wc -l
done
```

- [ ] **Step 2: For each non-zero diff, inspect and port**

Same pattern as Task 20.

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit 2>&1 | grep "tools/" | head -20`

- [ ] **Step 4: Commit**

Run:
```
git add src/tools/
git commit -m "merge: port additive grove-cli changes to tools modules"
```

### Task 23: Merge auth files (auth.ts + oauthFetch.ts)

**Files:**
- Modify: `/workspace/coding-cli/src/auth.ts`
- Modify: `/workspace/coding-cli/src/oauthFetch.ts`
- Reference: `/workspace/grove-cli/src/auth/flow.ts`
- Reference: `/workspace/grove-cli/src/auth/oauth.ts`
- Reference: `/workspace/grove-cli/src/auth/oauthFetch.ts`

Context: grove-cli's `src/auth/` subfolder splits OAuth flow into three files; coding-cli keeps it flat. Port any grove-cli improvements (newer token refresh, PKCE fixes, storage handling) from grove-cli's three files into coding-cli's flat `auth.ts` and `oauthFetch.ts`. **Do not** reorganize coding-cli's auth into a subfolder.

- [ ] **Step 1: Read grove-cli's three auth files**

Run:
```
wc -l /workspace/grove-cli/src/auth/flow.ts /workspace/grove-cli/src/auth/oauth.ts /workspace/grove-cli/src/auth/oauthFetch.ts
wc -l /workspace/coding-cli/src/auth.ts /workspace/coding-cli/src/oauthFetch.ts
```

- [ ] **Step 2: Compare OAuth token refresh logic**

Run: `grep -n "refresh" /workspace/grove-cli/src/auth/oauth.ts /workspace/coding-cli/src/auth.ts`
Note any refresh logic grove-cli has that coding-cli doesn't.

- [ ] **Step 3: Compare PKCE handling**

Run: `grep -n "pkce\|verifier\|challenge" /workspace/grove-cli/src/auth/*.ts /workspace/coding-cli/src/auth.ts`

- [ ] **Step 4: Compare oauthFetch wrappers**

Run: `diff -u /workspace/coding-cli/src/oauthFetch.ts /workspace/grove-cli/src/auth/oauthFetch.ts`

- [ ] **Step 5: Port improvements into coding-cli's flat files**

Use Edit to apply each improvement found. Preserve coding-cli's multi-provider auth detection (`detectAuth()` returning a map of providers).

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit 2>&1 | grep -E "auth\.ts|oauthFetch\.ts" | head -10`

- [ ] **Step 7: Commit**

Run:
```
git add src/auth.ts src/oauthFetch.ts
git commit -m "auth: port grove-cli oauth improvements into flat auth layout"
```

### Task 24: Final build-green checkpoint

**Files:** none

Context: after all shared-file merges, the project should type-check and build cleanly, even though LM Studio isn't yet wired into the preset system.

- [ ] **Step 1: Type check**

Run: `cd /workspace/coding-cli && npx tsc --noEmit 2>&1 | tail -20`
Expected: zero errors.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Help smoke test**

Run: `node dist/index.js --help`
Expected: prints help text; no crashes.

- [ ] **Step 4: Commit a green-checkpoint marker (only if there are changes)**

Run:
```
git status --short
```
If anything is modified (build artefacts, etc.), commit. Otherwise skip.

---

## Phase 4: LM Studio Provider Integration

### Task 25: Study coding-cli's Ollama provider shape

**Files:** none (reading only)

Context: LM Studio will plug into coding-cli's preset/provider architecture using Ollama as the closest template (local-server provider with a base URL and discovery probe).

- [ ] **Step 1: Find where Ollama is registered as a provider**

Run: `grep -rn "Ollama\|ollama" /workspace/coding-cli/src --include="*.ts" | grep -v node_modules | head -30`

- [ ] **Step 2: Read the provider-registration code**

Read the files identified above (likely `provider.ts`, `auth.ts`, `presets.ts`). Understand:
- How is a Provider interface defined?
- What does `detectAuth()` return for Ollama?
- How are Ollama presets declared in `presets.ts`?
- What env var triggers Ollama detection?

- [ ] **Step 3: Write notes in /tmp/lmstudio-plan.txt**

Jot the Ollama provider shape: interface methods, discovery flow, preset structure. This becomes the template for LM Studio.

### Task 26: Add LMSTUDIO_BASE_URL env var to .env.example

**Files:**
- Modify: `/workspace/coding-cli/.env.example`

- [ ] **Step 1: Read current .env.example**

Run: `cat /workspace/coding-cli/.env.example`

- [ ] **Step 2: Append LM Studio section**

Use Edit to add:
```
# LM Studio local server (optional)
# LMSTUDIO_BASE_URL=http://localhost:1234/v1
```

- [ ] **Step 3: Commit**

Run:
```
git add .env.example
git commit -m "env: document LMSTUDIO_BASE_URL"
```

### Task 27: Add LmStudioProvider class

**Files:**
- Modify: `/workspace/coding-cli/src/provider.ts` (or create `/workspace/coding-cli/src/lmStudioProvider.ts` if that matches coding-cli's pattern)

Context: create a provider class matching the Ollama provider's shape. The fetch logic already exists in `src/lmStudioFetch.ts` (imported from grove-cli in Task 9).

- [ ] **Step 1: Locate the OllamaProvider class**

Run: `grep -n "class.*Provider\|OllamaProvider" /workspace/coding-cli/src/provider.ts`

- [ ] **Step 2: Create LmStudioProvider by mirroring OllamaProvider**

Read the OllamaProvider class. Create an LmStudioProvider with:
- Same interface methods (likely `sendRequest`, `streamRequest`, `listModels`, or similar)
- Internal calls delegated to `lmStudioFetch.ts` functions
- Constructor that takes a base URL

Use Edit to add the class to whichever file fits coding-cli's convention (same file as OllamaProvider if that's the pattern).

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit 2>&1 | grep -E "provider|lmStudio" | head -10`
Fix any errors.

- [ ] **Step 4: Commit**

Run:
```
git add src/provider.ts  # or src/lmStudioProvider.ts if that path was used
git commit -m "provider: add LmStudioProvider class mirroring OllamaProvider"
```

### Task 28: Add LM Studio detection in src/auth.ts

**Files:**
- Modify: `/workspace/coding-cli/src/auth.ts`

Context: `detectAuth()` returns a map of configured providers. LM Studio detection follows the Ollama pattern: try a discovery probe, if it responds, add LmStudioProvider to the map.

- [ ] **Step 1: Read the Ollama detection block**

Run: `grep -n "Ollama\|ollama" /workspace/coding-cli/src/auth.ts`

- [ ] **Step 2: Add an analogous LM Studio detection block**

Use Edit. Pattern:
```ts
// LM Studio detection
const lmStudioUrl = process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1';
const lmStudioAvailable = await discoverLmStudio(lmStudioUrl);
if (lmStudioAvailable) {
  providers.set('lmstudio', {
    provider: new LmStudioProvider(lmStudioUrl),
    label: 'LM Studio',
  });
}
```
(Exact shape to match coding-cli's conventions.)

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit 2>&1 | grep auth.ts | head -10`

- [ ] **Step 4: Commit**

Run:
```
git add src/auth.ts
git commit -m "auth: detect LM Studio provider from LMSTUDIO_BASE_URL"
```

### Task 29: Add LM Studio presets in src/presets.ts

**Files:**
- Modify: `/workspace/coding-cli/src/presets.ts`

Context: add one or more model presets so `getAvailablePresets(new Set(['lmstudio']))` returns something.

- [ ] **Step 1: Read an existing Ollama preset entry**

Run: `grep -nB2 -A8 "providerId.*ollama" /workspace/coding-cli/src/presets.ts`

- [ ] **Step 2: Add LM Studio preset(s) after the Ollama block**

Use Edit. Add at least one preset with `providerId: 'lmstudio'`. Model name can be a placeholder that LM Studio users override (LM Studio hosts user-selected models, so the preset's modelId is more a hint than a fixed selection). Example:
```ts
{
  id: 'lmstudio-default',
  providerId: 'lmstudio',
  displayName: 'LM Studio (local)',
  modelId: 'local-model',
  maxTokens: 4096,
  temperature: 0.7,
  thinkingBudget: null,
},
```
(Adjust to match existing preset shape exactly.)

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit 2>&1 | grep presets.ts | head -10`

- [ ] **Step 4: Commit**

Run:
```
git add src/presets.ts
git commit -m "presets: add LM Studio preset"
```

### Task 30: Update help text and startup banner to mention LM Studio

**Files:**
- Modify: `/workspace/coding-cli/src/index.ts`

- [ ] **Step 1: Find help-text block that lists providers**

Run: `grep -n "ANTHROPIC_API_KEY\|ZHIPU_API_KEY\|OLLAMA" /workspace/coding-cli/src/index.ts`
Two call sites: the `coding-cli help` output and the "No authentication configured" error message.

- [ ] **Step 2: Add LM Studio to both blocks**

Use Edit twice. Add lines like:
```
LM Studio running     — local models
LMSTUDIO_BASE_URL     LM Studio server URL (default: http://localhost:1234/v1)
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit 2>&1 | grep index.ts | head -10`

- [ ] **Step 4: Commit**

Run:
```
git add src/index.ts
git commit -m "index: document LM Studio in help and startup messages"
```

---

## Phase 5: Package Identity and Docs

### Task 31: Bump version and update package.json description

**Files:**
- Modify: `/workspace/coding-cli/package.json`

- [ ] **Step 1: Update version and description**

Use Edit:
- Change `"version": "0.1.0"` to `"version": "0.2.0"`
- Update `"description"` to: `"Interactive CLI for multi-turn LLM conversations with tool use, staged writes, and a lisp runtime. Providers: Anthropic (API + OAuth), z.ai, Ollama, LM Studio."`

- [ ] **Step 2: Verify**

Run: `cat /workspace/coding-cli/package.json`

- [ ] **Step 3: Commit**

Run:
```
git add package.json
git commit -m "chore: bump to 0.2.0 and update description for grove-cli merge"
```

### Task 32: Rewrite README.md

**Files:**
- Modify: `/workspace/coding-cli/README.md`

Context: base on grove-cli's README but adapt for multi-provider, non-interactive mode, lisp runtime, LM Studio.

- [ ] **Step 1: Read both READMEs**

Run:
```
cat /workspace/grove-cli/README.md | head -100
echo "---"
cat /workspace/coding-cli/README.md 2>/dev/null | head -100
```

- [ ] **Step 2: Write the new README**

Structure:
1. **Title + tagline** — "coding-cli — interactive CLI for LLM conversations with tool use and staged writes"
2. **Features** — multi-provider, staged writes, file tracking, compaction, lisp runtime, sounds, etc.
3. **Quick Start** — install, configure auth for each provider
4. **Usage** — interactive REPL + non-interactive `-p`/`-f`/`-q` flags
5. **Slash Commands** — full table including new commands from Task 18
6. **Tools** — full table including selfCompactTool, testRunner
7. **Architecture** — src/ tree with lisp/ included
8. **Data Storage** — `~/.coding-cli/`
9. **Environment Variables** — full list including LMSTUDIO_BASE_URL
10. **Development** — build + type check

Use the Write tool to replace the README content. Do not include emojis. Use plain markdown.

- [ ] **Step 3: Commit**

Run:
```
git add README.md
git commit -m "docs: rewrite README for merged feature set"
```

### Task 33: Merge .gitignore

**Files:**
- Modify: `/workspace/coding-cli/.gitignore`

Context: grove-cli's `.gitignore` includes `*.tsbuildinfo`; coding-cli's doesn't. Merge the two.

- [ ] **Step 1: Check current content**

Run: `cat /workspace/coding-cli/.gitignore`

- [ ] **Step 2: Add `*.tsbuildinfo` if missing**

Use Edit to append the line.

- [ ] **Step 3: Commit**

Run:
```
git add .gitignore
git commit -m "chore: ignore *.tsbuildinfo"
```

### Task 34: Sanity-check all .env.example entries

**Files:**
- Modify: `/workspace/coding-cli/.env.example` (if anything is missing)

- [ ] **Step 1: Verify all referenced env vars are documented**

Run:
```
cd /workspace/coding-cli
grep -hoE "process\.env\.[A-Z_]+" src -r --include="*.ts" | sort -u
```
Compare that list against `.env.example`. Add any missing entries with commented-out defaults.

- [ ] **Step 2: Commit if changes were made**

Run:
```
git add .env.example
git status --short
git diff --cached
git commit -m "env: document remaining environment variables" 2>&1 || echo "nothing to commit"
```

---

## Phase 6: Verification

### Task 35: Clean type check

**Files:** none

- [ ] **Step 1: Run type check**

Run: `cd /workspace/coding-cli && npx tsc --noEmit 2>&1 | tee /tmp/final-tc.log`
Expected: zero errors, zero output.

- [ ] **Step 2: If errors exist, fix them before moving on**

Read `/tmp/final-tc.log` and resolve each error.

### Task 36: Clean build

**Files:** none

- [ ] **Step 1: Fresh build**

Run: `cd /workspace/coding-cli && rm -rf dist && npm run build 2>&1 | tee /tmp/final-build.log`
Expected: clean build, `dist/` populated, no errors.

### Task 37: Help smoke test

**Files:** none

- [ ] **Step 1: Print help**

Run: `node dist/index.js --help`
Expected: help text includes LM Studio references from Task 30.

- [ ] **Step 2: Print alternate help**

Run: `node dist/index.js help`
Expected: same output.

### Task 38: Non-interactive mode smoke test (requires configured provider)

**Files:** none

Context: requires at least one configured auth provider (env var or Ollama/LM Studio running). Skip individual sub-steps for providers not configured on this machine.

- [ ] **Step 1: Verify at least one provider is configured**

Run: `cd /workspace/coding-cli && node dist/index.js -p "say hi" -q 2>&1 | head -20`
Expected: either a model response (success) or "No authentication configured" (in which case configure one env var and retry).

- [ ] **Step 2: Try JSON format**

Run: `node dist/index.js -p "say hi" -q -f json 2>&1 | head -20`
Expected: JSON-formatted output with `text`, `toolCalls`, `usage` fields.

### Task 39: Interactive REPL smoke test

**Files:** none

Context: manual test. Start the REPL, confirm it boots and prompt renders, send one message, quit.

- [ ] **Step 1: Start REPL**

Run: `cd /workspace/coding-cli && node dist/index.js`
Expected: startup banner lists configured providers, channel resume message (if applicable), prompt renders with context-utilization percentage.

- [ ] **Step 2: Send a message**

Type: `hello`, press Enter.
Expected: model responds; context bar updates.

- [ ] **Step 3: Exercise new slash commands**

Type `/help`, press Enter.
Expected: help output lists new commands (autoTrim/dedupe/etc. per Task 18).

Try one new command from the output. Expected: runs without crashing.

- [ ] **Step 4: Quit cleanly**

Type `/quit`, press Enter.
Expected: channel saved, exit code 0.

### Task 40: Lisp smoke test

**Files:** none

Context: verify the lisp runtime is wired. Exact invocation depends on the slash-command/tool surface established by grove-cli and ported in Tasks 16 and 18.

- [ ] **Step 1: Identify the lisp entry point**

Run: `grep -rn "lisp" /workspace/coding-cli/src --include="*.ts" | grep -i "command\|tool\|bridge" | head -20`
Note the invocation path.

- [ ] **Step 2: Invoke lisp via REPL**

Start the REPL. Trigger lisp (e.g. `/lisp (+ 1 2)` if grove-cli added such a slash command, or ask the model to use the lisp tool).
Expected: evaluator returns `3` (or similar basic arithmetic result).

- [ ] **Step 3: Verify lisp persistence works**

Run a lisp expression that writes to persistent storage (refer to `src/lisp/persist.ts` for the storage path). Restart the REPL. Verify the stored value is accessible on next session.

### Task 41: Staged-write round trip

**Files:** create a throwaway file under `/tmp` as the edit target

- [ ] **Step 1: Create a target file**

Run: `echo "hello world" > /tmp/coding-cli-test.txt`

- [ ] **Step 2: Start REPL and ask the model to edit it**

Run: `cd /tmp && node /workspace/coding-cli/dist/index.js`
Then ask the model: `Please change /tmp/coding-cli-test.txt to say "hello, coding-cli" and stage the write.`

Expected: the model uses `propose_edit` (or similar); a staged write is shown with a diff and a token.

- [ ] **Step 3: Approve the staged write**

Type `/approve`, press Enter.
Expected: `/tmp/coding-cli-test.txt` is updated on disk.

- [ ] **Step 4: Verify**

Run: `cat /tmp/coding-cli-test.txt`
Expected: new content.

- [ ] **Step 5: Quit**

Type `/quit`, press Enter.

### Task 42: Final commit and push preparation

**Files:** none

- [ ] **Step 1: Ensure clean working tree**

Run: `cd /workspace/coding-cli && git status`
Expected: "nothing to commit, working tree clean".

- [ ] **Step 2: Review commit history**

Run: `git log --oneline | head -30`
Expected: chronological sequence of feature-merge commits on top of the extracted history.

- [ ] **Step 3: Verify remote is set**

Run: `git remote -v`
Expected: points to `git@github.com:izzortsi/coding-cli.git`.

- [ ] **Step 4: Report to user**

Print a summary:
- Total commits made
- Current HEAD commit hash
- Verification status of Tasks 35-41
- Outstanding work (if any) — for example, if the user's machine had no configured provider, note which smoke tests were skipped

The user will run `git push -u origin main` once the GitHub repo has been created under `izzortsi`.

---

## Self-Review Notes

**Spec coverage check:** every section of the design doc maps to at least one task:
- Repository setup → Tasks 1-6
- File merge layout Group 1 → Tasks 7-10
- File merge layout Group 2 (auth) → Task 23
- File merge layout Group 3 → Tasks 12-22
- Lisp runtime feature → Tasks 8, 16
- autoTrim + dedupe feature → Tasks 9, 13, 14, 15, 18
- LM Studio provider → Tasks 9, 25-30
- selfCompactTool + testRunner → Tasks 10, 17
- Sounds → Tasks 9, 19
- Docs → Task 7
- Package identity → Tasks 31, 33, 34
- README → Task 32
- Verification → Tasks 35-41

**Known deferrals:** two items depend on reading grove-cli source at implementation time — exact slash-command names (Task 18) and sound call-site hook points (Task 19). These are marked explicitly in the tasks and have concrete `grep` commands to resolve the unknowns.

**Type consistency:** provider/preset terminology used throughout matches coding-cli's existing naming (`Provider`, `Preset`, `providerId`, `detectAuth()`, `getAvailablePresets`).
