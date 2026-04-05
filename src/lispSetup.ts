/**
 * Lisp Runtime Setup — Extracted from repl.ts
 *
 * Initializes the Lisp agent runtime:
 *   1. Loads stdlib.lisp from grove-cli source
 *   2. Creates runtime with tool and LLM bridges
 *   3. Restores persisted state from channel
 *   4. Registers the `lisp_eval` tool
 *
 * Failure is non-fatal — returns undefined if anything goes wrong.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Provider, TextContent } from './types.js';
import type { ToolRegistry } from './tools/registry.js';
import { createAgentRuntime, type LispRuntime } from './lisp/core.js';

export interface LispSetupOptions {
  /** Root directory of grove-cli installation (for finding stdlib.lisp) */
  groveRoot: string;
  /** Tool registry to register lisp_eval on */
  registry: ToolRegistry;
  /** Persisted Lisp state from channel (defines as S-expressions) */
  channelLispState?: string;
  /** Get the current provider (deferred — may change during session) */
  getProvider: () => Provider;
  /** Get the current model ID (deferred — may change during session) */
  getModelId: () => string;
}

/**
 * Initialize the Lisp agent runtime and register lisp_eval.
 * Returns the runtime, or undefined if initialization fails.
 */
export async function initLispRuntime(opts: LispSetupOptions): Promise<LispRuntime | undefined> {
  try {
    // Load stdlib from grove-cli's own source
    let bootSource: string | undefined;
    try {
      const stdlibPath = path.join(opts.groveRoot, 'src', 'lisp', 'stdlib.lisp');
      bootSource = await readFile(stdlibPath, 'utf-8');
    } catch {
      // stdlib not found — that's OK, runtime works without it
    }

    const runtime = await createAgentRuntime({
      tools: {
        call: async (name, args) => {
          // Use executeDirect to bypass mode filter — Lisp strategies
          // are the approved channel in Lisp mode, they need all tools.
          const result = await opts.registry.executeDirect({
            type: 'tool_use',
            id: `lisp_${Date.now().toString(36)}`,
            name,
            input: args,
          });
          return result.content;
        },
        list: () => opts.registry.allToolNames(),
      },
      llm: {
        reflect: async (prompt) => {
          const provider = opts.getProvider();
          const response = await provider.chat(
            [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            opts.getModelId(),
            [],
            { maxTokens: 8192 },
          );
          return response.content
            .filter(b => b.type === 'text')
            .map(b => (b as TextContent).text)
            .join('');
        },
      },
      bootSource,
    });

    // Restore persisted Lisp state from channel
    // Wrapped in its own try/catch — corrupt state must not prevent lisp_eval registration
    if (opts.channelLispState && runtime) {
      try {
        await runtime.load(opts.channelLispState);
      } catch (loadErr) {
        process.stderr.write(`[grove-cli] Lisp state restore failed (continuing with fresh state): ${loadErr instanceof Error ? loadErr.message : String(loadErr)}\n`);
      }
    }

    // Register lisp_eval as a tool so the agent can call Lisp strategies during turns
    opts.registry.register({
      name: 'lisp_eval',
      // Lazy getter — called fresh each time getDefinitions() is invoked.
      // This ensures the strategy list reflects strategies defined mid-session.
      description: () => [
        'Evaluate a Lisp expression in the agent\'s Lisp runtime. Use this to call strategies,',
        'compose behaviors, inspect/rewrite code-as-data, and self-improve.',
        '',
        'The runtime has these user-defined strategies:',
        `  ${runtime.userDefinitions().join(', ')}`,
        '',
        'Key strategies:',
        '  (read-file "path")             — Read a file (with error handling)',
        '  (search-code "pattern" "dir")  — Search for text in code',
        '  (ls "dir")                     — List directory contents',
        '  (analyze "prompt" data)        — Ask the LLM to analyze data',
        '  (improve-strategy "name" "goal") — Rewrite a strategy via LLM reflection',
        '  (inspect "name")              — Get strategy source as data',
        '  (source "name")               — Get strategy source as string',
        '  (strategies)                   — List all strategy names',
        '',
        'Dataset persistence (file-backed in ~/.grove-cli/datasets/):',
        '  (save-dataset "name" data)    — Save sexp as JSON dataset',
        '  (load-dataset "name")         — Load dataset as sexp',
        '  (list-datasets)               — Show all datasets with sizes',
        '  (delete-dataset "name")       — Remove a dataset',
        '  (dataset-append "name" entry) — Add entry to existing dataset',
        '  (dataset-query "name" pred)   — Filter dataset with predicate fn',
        '  (dataset-keys "name")         — Get keys of an alist dataset',
        '  (dataset-count "name")        — Count entries in dataset',
        '  (dataset-merge "a" "b")       — Merge two list datasets',
        '  (dataset-upsert "name" key value) — Insert or update alist entry',
        '  (dataset-entries "name" n offset) — Paginated entries',
        '  (remember-persist cat note)   — Remember + persist to dataset',
        '  (recall-persisted)            — Restore memories from dataset',
        '',
        'Structured memory system (persistent, searchable, linkable):',
        '  (mem "cat" "text")            — Create a memory (returns "✓ m1 [cat] text")',
        '  (mem "cat" "text" \'("tags"))  — Create with tags',
        '  (mem-all)                     — Get all memories as list of alists',
        '  (mem-count)                   — Count total memories',
        '  (mem-get "m1")               — Get memory by ID',
        '  (mem-search "keyword")        — Full-text search across all memories',
        '  (mem-by-cat "fact")           — Filter by category',
        '  (mem-by-tag "arch")           — Filter by tag',
        '  (mem-fmt m)                   — Format a single memory for display',
        '  (mem-show memories)           — Format a list of memories',
        '  (mem-ls)                      — List all memories formatted',
        '  (mem-ls-cat "fact")           — List memories in category',
        '  (mem-update! "m1" :text "new") — Update a field',
        '  (mem-link! "m1" "m2")         — Link two memories (m1 → m2)',
        '  (mem-delete! "m1")            — Delete by ID',
        '  (mem-delete-cat! "todo")      — Delete all in category',
        '  (mem-restore-counter!)        — Restore ID counter from store (session start)',
        '',
        'Native fs builtins (direct filesystem access):',
        '  (file-read "path")           — Read file contents as string',
        '  (file-write "path" content)  — Write string to file (creates dirs)',
        '  (file-delete "path")         — Delete a file',
        '  (file-exists? "path")        — Check if file exists',
        '  (file-list-dir "path")       — List directory entries ((name :dir/:file) ...)',
        '  (file-stat "path")           — File stats ((:size N) (:modified N) ...)',
        '  (file-mkdir "path")          — Create directory (recursive)',
        '  (grove-data-dir)             — Returns ~/.grove-cli path',
        '',
        'You can also define new strategies: (define (my-fn x) (+ x 1))',
        'And compose them: (pipeline data fn1 fn2 fn3)',
        '',
        'Strategies are S-expressions — inspectable and rewritable as data.',
        'Changes persist across sessions.',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Lisp expression to evaluate. Can be any valid S-expression.',
          },
        },
        required: ['expression'],
      },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const expr = args.expression as string;
        if (!expr) return 'Error: expression is required';
        try {
          const result = await runtime.eval(expr);
          return runtime.print(result);
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    });

    return runtime;
  } catch (err) {
    // Lisp runtime failed to initialize — non-fatal, continue without it
    process.stderr.write(`[grove-cli] Lisp runtime init error: ${err instanceof Error ? err.message : String(err)}\n`);
    return undefined;
  }
}
