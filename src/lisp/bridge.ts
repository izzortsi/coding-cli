/**
 * Lisp Agent Bridge
 *
 * Connects the Lisp runtime to external capabilities:
 *   - tool-call: invoke grove-cli tools (read_file, code_search, etc.)
 *   - llm-reflect: call back into the LLM for reasoning
 *   - introspection: inspect and rewrite agent strategies
 *
 * Dependencies are injected explicitly — no coupling to engine internals.
 */

import type { LispVal } from './types.js';
import { Str, Nil, List, Keyword, Bool, Num, Native, isList, isStr, isKeyword, isNum } from './types.js';
import type { LispRuntime } from './core.js';
import { createRuntime } from './core.js';
import { print } from './printer.js';
import { readAll } from './reader.js';
// env imports removed — unused (found by self-review)

// --- Types ---

export interface ToolBridge {
  /** Call a tool by name with args. Returns result string. */
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** List available tool names. */
  list: () => string[];
}

export interface LLMBridge {
  /** One-shot LLM completion. Returns response text. */
  reflect: (prompt: string) => Promise<string>;
}

export interface AgentRuntimeOptions {
  tools?: ToolBridge;
  llm?: LLMBridge;
  /** Boot library source to load on creation. */
  bootSource?: string;
  /** Max eval steps (default 100_000). */
  maxSteps?: number;
}

// --- Agent Runtime ---

/**
 * Create a Lisp runtime wired to agent capabilities.
 * Extends the base runtime with:
 *   - (tool-call "name" args-alist) → string result
 *   - (llm-reflect "prompt") → string response
 *   - Introspection builtins for the reflective loop
 */
export async function createAgentRuntime(opts: AgentRuntimeOptions = {}): Promise<LispRuntime> {
  const runtime = createRuntime();

  // --- Tool Bridge ---

  if (opts.tools) {
    const tools = opts.tools;

    runtime.defn('tool-call', async (name: LispVal, args: LispVal) => {
      if (!isStr(name)) throw new Error('tool-call: first arg must be tool name string');
      const jsArgs = lispToArgs(args);
      const result = await tools.call(name.val, jsArgs);
      return Str(result);
    });

    runtime.defn('tool-list', () => {
      return List(tools.list().map(Str));
    });
  }

  // --- LLM Bridge ---

  if (opts.llm) {
    const llm = opts.llm;

    runtime.defn('llm-reflect', async (...args: LispVal[]) => {
      // (llm-reflect "prompt")
      // (llm-reflect "prompt" data) — data gets appended as context
      if (args.length === 0 || !isStr(args[0])) {
        throw new Error('llm-reflect: first arg must be a prompt string');
      }
      let prompt = args[0].val;
      if (args.length > 1) {
        prompt += '\n\nContext:\n' + print(args[1]);
      }
      const response = await llm.reflect(prompt);
      return Str(response);
    });
  }

  // --- Introspection (for the reflective loop) ---

  // (inspect "name") → quoted source form of a user-defined function
  // Shared helper: reconstruct a (define ...) or (defmacro ...) form from a fn value
  function reconstructDefineForm(fn: LispVal & { tag: 'fn' }, fallbackName: string): LispVal {
    const formTag = fn.isMacro ? 'defmacro' : 'define';
    const params = List(fn.params.map(p => ({ tag: 'sym' as const, val: p })));
    if (fn.name) {
      return List([
        { tag: 'sym' as const, val: formTag },
        List([{ tag: 'sym' as const, val: fn.name }, ...params.val]),
        fn.body,
      ]);
    }
    return List([
      { tag: 'sym' as const, val: formTag },
      { tag: 'sym' as const, val: fallbackName },
      List([{ tag: 'sym' as const, val: 'lambda' }, params, fn.body]),
    ]);
  }

  runtime.defn('inspect', (name: LispVal) => {
    if (!isStr(name)) throw new Error('inspect: arg must be a string');
    const val = runtime.get(name.val);
    if (!val) return Nil;
    if (val.tag === 'fn') return reconstructDefineForm(val, name.val);
    return val;
  });

  // (strategies) → list of user-defined names
  runtime.defn('strategies', () => {
    return List(runtime.userDefinitions().map(Str));
  });

  // (source "name") → printed source string of a definition
  runtime.defn('source', (name: LispVal) => {
    if (!isStr(name)) throw new Error('source: arg must be a string');
    const val = runtime.get(name.val);
    if (!val) return Nil;
    if (val.tag === 'fn') {
      return Str(runtime.prettyPrint(reconstructDefineForm(val, name.val)));
    }
    return Str(runtime.prettyPrint(val));
  });

  // --- Load boot library ---

  if (opts.bootSource) {
    await runtime.load(opts.bootSource);
  }

  return runtime;
}

// --- Helpers ---

/** Convert a Lisp alist or value to a JS args object for tool calls. */
function lispToArgs(val: LispVal): Record<string, unknown> {
  if (val.tag === 'nil') return {};
  if (!isList(val)) return {};

  const result: Record<string, unknown> = {};

  for (const item of val.val) {
    if (isList(item) && item.val.length === 2) {
      const key = item.val[0];
      const value = item.val[1];
      const keyStr = isKeyword(key) ? key.val : isStr(key) ? key.val : null;
      if (keyStr) {
        result[keyStr] = lispValToJs(value);
      }
    }
  }

  return result;
}

/** Convert a LispVal to a JS value for tool call arguments. */
function lispValToJs(val: LispVal): unknown {
  switch (val.tag) {
    case 'num': return val.val;
    case 'str': return val.val;
    case 'bool': return val.val;
    case 'nil': return null;
    case 'keyword': return val.val;
    case 'sym': return val.val;
    case 'list': {
      // Alist detection: all 2-element lists with keyword/string keys → object
      if (val.val.length > 0 && val.val.every(item =>
        isList(item) && item.val.length === 2 &&
        (isKeyword(item.val[0]) || isStr(item.val[0])))) {
        const obj: Record<string, unknown> = {};
        for (const pair of val.val) {
          if (isList(pair)) {
            const k = isKeyword(pair.val[0]) ? pair.val[0].val : isStr(pair.val[0]) ? pair.val[0].val : '';
            obj[k] = lispValToJs(pair.val[1]);
          }
        }
        return obj;
      }
      return val.val.map(lispValToJs);
    }
    default: return null;
  }
}
