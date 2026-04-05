/**
 * Lisp Environment
 *
 * Lexically scoped environment chain. Each env holds bindings
 * and a reference to its parent scope.
 */

import type { Env, LispVal } from './types.js';

/** Create a new empty environment with optional parent. */
export function createEnv(parent: Env | null = null): Env {
  return {
    bindings: new Map(),
    parent,
  };
}

/** Create a child environment with bindings from params/args pairs. */
export function childEnv(parent: Env, params: string[], args: LispVal[]): Env {
  const env = createEnv(parent);
  for (let i = 0; i < params.length; i++) {
    // Support variadic: if param starts with &, bind rest as list
    if (params[i] === '&' && i + 1 < params.length) {
      env.bindings.set(params[i + 1], { tag: 'list', val: args.slice(i) });
      break;
    }
    env.bindings.set(params[i], args[i] ?? { tag: 'nil' });
  }
  return env;
}

/** Look up a symbol in the environment chain. */
export function envGet(env: Env, name: string): LispVal | undefined {
  const val = env.bindings.get(name);
  if (val !== undefined) return val;
  if (env.parent) return envGet(env.parent, name);
  return undefined;
}

/** Set a binding in the current (innermost) environment. */
export function envSet(env: Env, name: string, val: LispVal): void {
  env.bindings.set(name, val);
}

/** Update an existing binding in the closest scope that has it. */
export function envUpdate(env: Env, name: string, val: LispVal): boolean {
  if (env.bindings.has(name)) {
    env.bindings.set(name, val);
    return true;
  }
  if (env.parent) return envUpdate(env.parent, name, val);
  return false;
}

/** List all binding names visible from this env (including parents). */
export function envKeys(env: Env): string[] {
  const keys = new Set<string>();
  let current: Env | null = env;
  while (current) {
    for (const k of current.bindings.keys()) {
      keys.add(k);
    }
    current = current.parent;
  }
  return [...keys];
}

/** Get all bindings from the current (innermost) scope only. */
export function envOwnBindings(env: Env): Map<string, LispVal> {
  return new Map(env.bindings);
}
