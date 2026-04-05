# Lisp Agent Guide

## What This Is

You have a Lisp runtime embedded in grove-cli. In Lisp mode, `lisp_eval` is your only tool for real work. All file I/O, code search, edits, and shell commands go through Lisp strategies — S-expressions that compose tool calls and LLM reflection.

The strategies are your behaviors. You can inspect them, rewrite them, and create new ones. They persist across sessions. This is a self-improving system.

## Critical Conventions

### Variadic Parameters
Use `&`, NOT `.` (dot):
```lisp
;; CORRECT
(define (my-fn a b & rest) ...)

;; WRONG — dot creates pairs, not variadics
(define (my-fn a b . rest) ...)
```

### Builtin Argument Orders
These trip up LLM-generated code constantly:
```lisp
(str-split separator string)      ;; separator FIRST
(str-contains? needle haystack)   ;; needle FIRST
(str-starts? prefix string)       ;; prefix FIRST
(str-ends? suffix string)         ;; suffix FIRST
```

### read-file Output Format
`read-file` returns lines with number prefixes: `"1 | code here\
2 | more code"`. When matching text for `propose-edit`, use the raw content WITHOUT line numbers. The `propose-edit` tool receives the file directly from disk.

### safe-edit vs propose-edit
Always prefer `safe-edit` over raw `propose-edit`. It reads the file first, verifies the search text exists, and shows context around the match. Never call `propose-edit` without reading the file first.

## Core Strategies

### File Operations
```lisp
(read-file "path")                    ;; Read file (line-numbered output)
(search-code "pattern" "dir")         ;; Search across files
(ls "dir")                            ;; List directory
(directory-tree "dir" "ext")          ;; Recursive tree, optional extension filter
(find-files "dir" "glob")             ;; Find by name pattern
(grep "path" "pattern")               ;; Search within a file
(grep "path" "pattern" "i")           ;; Case-insensitive
(head "path" 20)                      ;; First N lines
(head "path" 10 "tail")               ;; Last N lines
(loc-count "path")                    ;; Line count (total + non-blank)
```

### Write Operations
```lisp
(safe-edit "path" "search" "replace" "rationale")  ;; Read → verify → context → edit
(test-edit "path" "search" "replace" "why")         ;; safe-edit + validate-self
(propose-write "path" "content" "rationale")         ;; Full file write
(propose-exec "command" "rationale")                  ;; Shell command
(validate-self)                                        ;; TypeScript compilation check
```

### LLM-Powered Analysis
```lisp
(analyze "prompt" data)             ;; General LLM analysis
(file-summary "path")               ;; 2-3 sentence file summary
(review-file "path")                ;; Code review with line references
(explain "strategy-name")           ;; Explain a strategy in plain English
(scan-dir "dir")                    ;; Directory structure + LLM analysis
(trace-imports "path")              ;; Import/dependency tracing
(find-todos "dir")                  ;; Find TODO/FIXME/HACK
(batch-summary "dir" ".ts")         ;; Summarize every file in a directory
```

### Self-Improvement
```lisp
;; Inspect strategies as data
(strategies)                        ;; List all strategy names
(inspect "name")                    ;; Get definition as S-expression
(source "name")                     ;; Get printed source string

;; Version control for strategies
(save-version "name")               ;; Save before modifying
(rollback "name")                   ;; Restore last saved version

;; LLM-powered evolution
(improve-strategy "name" "goal")    ;; Ask LLM to rewrite a strategy
(evolve "name" "goal")              ;; improve + install (3 retries on failure)
(evolve "name" "goal" "test-expr")  ;; improve + install + test + rollback if fail

;; Autonomous improvement
(meta-evolve "high-level goal" 3)   ;; Plan + execute multiple evolutions
```

### Composition
```lisp
(pipeline val fn1 fn2 fn3)          ;; Thread value through functions
(fan-out val fn1 fn2 fn3)           ;; Apply multiple fns to same value
(first-success thunk1 thunk2)       ;; Try alternatives until one works
(retry 3 (fn () ...))               ;; Retry on failure
(safe-call "tool" args)             ;; Tool call with error handling
```

### Testing
```lisp
(assert-eq "name" expected actual)  ;; Returns ✓/✗ string
(run-tests thunk1 thunk2 ...)       ;; Run test thunks, report results
(self-test)                         ;; 16-point regression suite
```

## The Self-Improvement Loop

The most powerful pattern:

```lisp
;; 1. Save current version (safety net)
(save-version "strategy-name")

;; 2. Evolve with a test
(evolve "strategy-name" "what to improve" "(= expected (strategy-name test-input))")

;; 3. If the test passes, the new version is live
;; If it fails, it auto-rolls back

;; 4. Verify no regressions
(self-test)
```

For bigger goals, use `meta-evolve`:
```lisp
(meta-evolve "make the agent better at refactoring" 5)
;; Plans 5 improvement steps via LLM, executes each with evolve
```

## How the Bridge Works

- In Lisp mode, raw tools (read_file, code_search, etc.) are hidden from the model
- But Lisp strategies call them via `tool-call` → `executeDirect` which bypasses the mode filter
- `(tool-list)` shows ALL available tools (unfiltered)
- `(tool-call "tool_name" (list (list :param value)))` calls any tool directly
- `(llm-reflect "prompt")` calls back into the LLM for reasoning

## Common Patterns

### Investigate then edit
```lisp
(let ((contents (read-file "path")))
  (let ((matches (grep "path" "pattern")))
    (safe-edit "path" "exact search text" "replacement" "why")))
```

### Define a new strategy on the fly
```lisp
(define (my-strategy x)
  (let ((data (read-file x)))
    (analyze "What patterns do you see?" data)))
```

### Create and test a strategy
```lisp
(define (my-fn x) "todo")
(evolve "my-fn" "implement: does X and returns Y" "(= expected (my-fn test-input))")
```

## Known Quirks

1. **No `error` builtin in pre-restart sessions** — `error` was added as a builtin but requires restart to take effect. Use `(car nil)` as a workaround to throw.
2. **`let` is actually `let*`** — each binding sees previous bindings. This is intentional.
3. **`do` is an alias for `begin`** — not a loop construct.
4. **Step limit is 100K** — infinite recursion throws `LispEvalError`. Use TCO (tail calls) for loops.
5. **Closures don't serialize perfectly** — functions that close over local variables may not survive save/load. Define dependencies at top level.
6. **`evolve` bootstraps through `lisp_eval` tool** — it calls `tool-call "lisp_eval"` to evaluate LLM-generated code, which means it goes through the tool bridge. This is intentional — it shares the step counter and safety limits.
