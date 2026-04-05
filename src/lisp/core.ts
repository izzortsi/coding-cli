/**
 * Lisp Core — Public API
 *
 * Creates and manages the Lisp runtime for the agent.
 * Entry point for all Lisp operations from TypeScript.
 */

import type { LispVal, Env } from './types.js';
import { Nil, Str, Num, Bool, List, Native } from './types.js';
import { createEnv, envSet, envGet, envKeys } from './env.js';
import { read, readAll, LispReadError } from './reader.js';
import { lispEval, LispEvalError, DEFAULT_MAX_STEPS } from './eval.js';
import type { EvalContext } from './eval.js';
import { print, display, prettyPrint } from './printer.js';
import { installBuiltins } from './builtins.js';
import { serializeEnv, extractDefines } from './persist.js';

export interface LispRuntime {
  /** The top-level environment */
  env: Env;

  /** Evaluate a string of Lisp source. Returns the last result. */
  eval: (source: string, maxSteps?: number) => Promise<LispVal>;

  /** Evaluate and return all results. */
  evalAll: (source: string, maxSteps?: number) => Promise<LispVal[]>;

  /** Define a value from TypeScript. */
  define: (name: string, val: LispVal) => void;

  /** Register a TypeScript function as a Lisp native. */
  defn: (name: string, fn: (...args: LispVal[]) => LispVal | Promise<LispVal>) => void;

  /** Look up a binding. */
  get: (name: string) => LispVal | undefined;

  /** Serialize the runtime state for persistence. */
  serialize: () => string;

  /** Load a serialized image into the runtime. */
  load: (source: string) => Promise<void>;

  /** List all user-defined names (excludes builtins). */
  userDefinitions: () => string[];

  /** Print a value. */
  print: (val: LispVal) => string;

  /** Pretty-print a value. */
  prettyPrint: (val: LispVal) => string;
}

/**
 * Create a new Lisp runtime with builtins installed.
 */
export function createRuntime(): LispRuntime {
  // Base env holds builtins (never serialized)
  const baseEnv = createEnv();
  installBuiltins(baseEnv);

  // User env sits on top (this is what gets serialized)
  const userEnv = createEnv(baseEnv);

  // Track which names are builtins
  const builtinNames = new Set(envKeys(baseEnv));

  // Register eval builtin — evaluates a LispVal form in the user env.
  // This is the key primitive for self-improving code: generate code as data, then eval it.
  envSet(baseEnv, 'eval', Native('eval', (expr) => lispEval(expr, userEnv)));

  // Track which names are builtins (AFTER registering eval so it's excluded from userDefinitions)
  // Re-compute to include 'eval' which was added after the initial builtinNames snapshot.
  builtinNames.add('eval');

  const runtime: LispRuntime = {
    env: userEnv,

    async eval(source: string, maxSteps?: number): Promise<LispVal> {
      const ctx: EvalContext = { steps: 0, maxSteps: maxSteps ?? DEFAULT_MAX_STEPS };
      const forms = readAll(source);
      if (forms.length === 0) return Nil;
      let result: LispVal = Nil;
      for (const form of forms) {
        result = await lispEval(form, userEnv, ctx);
      }
      return result;
    },

    async evalAll(source: string, maxSteps?: number): Promise<LispVal[]> {
      const ctx: EvalContext = { steps: 0, maxSteps: maxSteps ?? DEFAULT_MAX_STEPS };
      const forms = readAll(source);
      const results: LispVal[] = [];
      for (const form of forms) {
        results.push(await lispEval(form, userEnv, ctx));
      }
      return results;
    },

    define(name: string, val: LispVal): void {
      envSet(userEnv, name, val);
    },

    defn(name: string, fn: (...args: LispVal[]) => LispVal | Promise<LispVal>): void {
      envSet(userEnv, name, Native(name, fn));
    },

    get(name: string): LispVal | undefined {
      return envGet(userEnv, name);
    },

    serialize(): string {
      return serializeEnv(userEnv);
    },

    async load(source: string): Promise<void> {
      const clean = extractDefines(source);
      if (clean.trim().length === 0) return;
      const forms = readAll(clean);
      // Fresh context for loading — don't share step budget with active evals.
      // Use a generous limit since loading stdlib/persisted state can be large.
      const ctx: EvalContext = { steps: 0, maxSteps: DEFAULT_MAX_STEPS * 10 };
      for (const form of forms) {
        await lispEval(form, userEnv, ctx);
      }
    },

    userDefinitions(): string[] {
      return envKeys(userEnv).filter(k => !builtinNames.has(k));
    },

    print(val: LispVal): string {
      return print(val);
    },

    prettyPrint(val: LispVal): string {
      return prettyPrint(val);
    },
  };

  return runtime;
}

// Re-export key types and utilities
export { LispReadError } from './reader.js';
export { LispEvalError } from './eval.js';
export type { EvalContext } from './eval.js';
export { DEFAULT_MAX_STEPS } from './eval.js';
export { read, readAll } from './reader.js';
export { print, display, prettyPrint } from './printer.js';
export { serializeEnv } from './persist.js';
export type { LispVal, Env } from './types.js';
export { Num, Str, Bool, Nil, List, Sym, Keyword, Native } from './types.js';
export { createAgentRuntime } from './bridge.js';
export type { ToolBridge, LLMBridge, AgentRuntimeOptions } from './bridge.js';
