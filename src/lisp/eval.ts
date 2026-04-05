/**
 * Lisp Evaluator
 *
 * Async eval/apply with tail-call optimization (TCO) and step limiting.
 * Special forms: define, lambda, if, cond, let, begin, quote,
 *                quasiquote, set!, and, or, do, try.
 *
 * Async enables native functions (tool-call, llm-reflect) to perform
 * I/O without blocking. Sync natives pay negligible overhead (await on
 * a non-promise is a microtask bounce).
 */

import type { LispVal, Env } from './types.js';
import { Nil, Bool, Str, List, isSym, isList, isTruthy } from './types.js';
import { childEnv, createEnv, envGet, envSet, envUpdate } from './env.js';

export class LispEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LispEvalError';
  }
}

// --- Step Limiting ---

export interface EvalContext {
  steps: number;
  maxSteps: number;
}

export const DEFAULT_MAX_STEPS = 100_000;

// Module-level context shared across nested eval/apply calls.
// Safe in single-threaded JS. Set by top-level eval, inherited by all
// nested calls (including through applyFn from builtins).
let activeCtx: EvalContext = { steps: 0, maxSteps: DEFAULT_MAX_STEPS };

/** Evaluate a LispVal in an environment. Uses TCO via loop.
 *  Pass ctx to set a fresh step budget; omit to share the active one. */
export async function lispEval(ast: LispVal, env: Env, ctx?: EvalContext): Promise<LispVal> {
  if (ctx) activeCtx = ctx;
  let currentAst = ast;
  let currentEnv = env;

  // TCO trampoline
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Step limit check
    if (++activeCtx.steps > activeCtx.maxSteps) {
      throw new LispEvalError(`Evaluation exceeded step limit (${activeCtx.maxSteps})`);
    }

    // Non-list atoms
    if (currentAst.tag === 'sym') {
      const val = envGet(currentEnv, currentAst.val);
      if (val === undefined) {
        throw new LispEvalError(`Undefined symbol: ${currentAst.val}`);
      }
      return val;
    }

    if (currentAst.tag !== 'list') {
      // Numbers, strings, booleans, nil, keywords self-evaluate
      return currentAst;
    }

    const items = currentAst.val;
    if (items.length === 0) return Nil;

    const head = items[0];

    // --- Special Forms ---

    if (isSym(head)) {
      switch (head.val) {
        // (quote expr)
        case 'quote':
          return items[1] ?? Nil;

        // (quasiquote expr)
        case 'quasiquote':
          return await evalQuasiquote(items[1] ?? Nil, currentEnv);

        // (define name expr)  or  (define (name params...) body)
        case 'define': {
          if (items.length < 3) throw new LispEvalError('define requires at least 2 arguments');
          const target = items[1];
          if (isSym(target)) {
            // Simple define
            const val = await lispEval(items[2], currentEnv);
            envSet(currentEnv, target.val, val);
            return val;
          }
          if (isList(target) && target.val.length > 0 && isSym(target.val[0])) {
            // Function shorthand: (define (f x y) body)
            const name = target.val[0].val;
            const params = target.val.slice(1).map(p => {
              if (!isSym(p)) throw new LispEvalError('Function params must be symbols');
              return p.val;
            });
            const body = items.length === 3 ? items[2] : List([{ tag: 'sym', val: 'begin' }, ...items.slice(2)]);
            const fn: LispVal = { tag: 'fn', params, body, env: currentEnv, name };
            envSet(currentEnv, name, fn);
            return fn;
          }
          throw new LispEvalError('Invalid define form');
        }

        // (defmacro (name params...) body)  or  (defmacro name (params...) body)
        case 'defmacro': {
          if (items.length < 3) throw new LispEvalError('defmacro requires at least 2 arguments');
          const target = items[1];
          let name: string;
          let params: string[];
          let body: LispVal;
          if (isList(target) && target.val.length > 0 && isSym(target.val[0])) {
            // Shorthand: (defmacro (name params...) body)
            name = target.val[0].val;
            params = target.val.slice(1).map(p => {
              if (!isSym(p)) throw new LispEvalError('Macro params must be symbols');
              return p.val;
            });
            body = items.length === 3 ? items[2] : List([{ tag: 'sym', val: 'begin' }, ...items.slice(2)]);
          } else if (isSym(target)) {
            // Long form: (defmacro name (params...) body)
            name = target.val;
            const paramList = items[2];
            if (!isList(paramList)) throw new LispEvalError('defmacro params must be a list');
            params = paramList.val.map(p => {
              if (!isSym(p)) throw new LispEvalError('Macro params must be symbols');
              return p.val;
            });
            body = items.length === 4 ? items[3] : List([{ tag: 'sym', val: 'begin' }, ...items.slice(3)]);
          } else {
            throw new LispEvalError('Invalid defmacro form');
          }
          const macro: LispVal = { tag: 'fn', params, body, env: currentEnv, name, isMacro: true };
          envSet(currentEnv, name, macro);
          return macro;
        }

        // (lambda (params...) body...)
        case 'lambda':
        case 'fn': {
          if (items.length < 3) throw new LispEvalError('lambda requires params and body');
          const paramList = items[1];
          if (!isList(paramList)) throw new LispEvalError('lambda params must be a list');
          const params = paramList.val.map(p => {
            if (!isSym(p)) throw new LispEvalError('lambda params must be symbols');
            return p.val;
          });
          const body = items.length === 3 ? items[2] : List([{ tag: 'sym', val: 'begin' }, ...items.slice(2)]);
          return { tag: 'fn', params, body, env: currentEnv };
        }

        // (if test then else?)
        case 'if': {
          if (items.length < 3) throw new LispEvalError('if requires at least (if test then)');
          const test = await lispEval(items[1], currentEnv);
          if (isTruthy(test)) {
            currentAst = items[2] ?? Nil;
          } else {
            currentAst = items[3] ?? Nil;
          }
          continue; // TCO
        }

        // (cond (test expr...)... (else expr...)?)
        // Multi-expression clauses are wrapped in begin (like let body)
        case 'cond': {
          for (let i = 1; i < items.length; i++) {
            const clause = items[i];
            if (!isList(clause) || clause.val.length < 2) {
              throw new LispEvalError('cond clause must be (test expr...)');
            }
            const test = clause.val[0];
            if (isSym(test) && test.val === 'else') {
              currentAst = clause.val.length === 2
                ? clause.val[1]
                : List([{ tag: 'sym' as const, val: 'begin' }, ...clause.val.slice(1)]);
              break;
            }
            if (isTruthy(await lispEval(test, currentEnv))) {
              currentAst = clause.val.length === 2
                ? clause.val[1]
                : List([{ tag: 'sym' as const, val: 'begin' }, ...clause.val.slice(1)]);
              break;
            }
            if (i === items.length - 1) return Nil;
          }
          continue; // TCO
        }

        // (let ((name val)...) body...)
        case 'let': {
          if (items.length < 3) throw new LispEvalError('let requires bindings and body');
          const bindings = items[1];
          if (!isList(bindings)) throw new LispEvalError('let bindings must be a list');
          const letEnv = createEnv(currentEnv);
          for (const b of bindings.val) {
            if (!isList(b) || b.val.length !== 2 || !isSym(b.val[0])) {
              throw new LispEvalError('let binding must be (name value)');
            }
            envSet(letEnv, b.val[0].val, await lispEval(b.val[1], letEnv));
          }
          currentEnv = letEnv;
          // Eval all but last for side effects, TCO on last
          for (let i = 2; i < items.length - 1; i++) {
            await lispEval(items[i], currentEnv);
          }
          currentAst = items[items.length - 1];
          continue; // TCO
        }

        // (begin expr...)
        case 'begin': {
          if (items.length === 1) return Nil;
          for (let i = 1; i < items.length - 1; i++) {
            await lispEval(items[i], currentEnv);
          }
          currentAst = items[items.length - 1];
          continue; // TCO
        }

        // (set! name expr)
        case 'set!': {
          if (items.length !== 3 || !isSym(items[1])) {
            throw new LispEvalError('set! requires (set! symbol value)');
          }
          const val = await lispEval(items[2], currentEnv);
          if (!envUpdate(currentEnv, items[1].val, val)) {
            throw new LispEvalError(`set!: undefined symbol ${items[1].val}`);
          }
          return val;
        }

        // (and expr...) — short-circuit
        case 'and': {
          if (items.length === 1) return Bool(true);
          for (let i = 1; i < items.length - 1; i++) {
            const val = await lispEval(items[i], currentEnv);
            if (!isTruthy(val)) return val;
          }
          currentAst = items[items.length - 1];
          continue; // TCO
        }

        // (or expr...) — short-circuit
        case 'or': {
          if (items.length === 1) return Bool(false);
          for (let i = 1; i < items.length - 1; i++) {
            const val = await lispEval(items[i], currentEnv);
            if (isTruthy(val)) return val;
          }
          currentAst = items[items.length - 1];
          continue; // TCO
        }

        // (do expr...) — alias for begin
        case 'do': {
          for (let i = 1; i < items.length - 1; i++) {
            await lispEval(items[i], currentEnv);
          }
          if (items.length < 2) return Nil;
          currentAst = items[items.length - 1];
          continue; // TCO
        }

        // (try expr (catch binding handler...))
        case 'try': {
          if (items.length < 3) throw new LispEvalError('try requires expression and catch clause');
          const tryExpr = items[1];
          const catchClause = items[2];
          if (!isList(catchClause) || catchClause.val.length < 3 ||
              !isSym(catchClause.val[0]) || catchClause.val[0].val !== 'catch') {
            throw new LispEvalError('try requires (catch binding handler)');
          }
          const errorBinding = catchClause.val[1];
          if (!isSym(errorBinding)) throw new LispEvalError('catch binding must be a symbol');
          const handler = catchClause.val.length === 3
            ? catchClause.val[2]
            : List([{ tag: 'sym' as const, val: 'begin' }, ...catchClause.val.slice(2)]);

          try {
            return await lispEval(tryExpr, currentEnv);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const catchEnv = createEnv(currentEnv);
            envSet(catchEnv, errorBinding.val, Str(msg));
            currentAst = handler;
            currentEnv = catchEnv;
            continue; // TCO on handler
          }
        }
      }
    }

    // --- Function Application ---

    const fn = await lispEval(head, currentEnv);

    // Macro expansion: args are NOT evaluated, expansion is eval'd
    if (fn.tag === 'fn' && fn.isMacro) {
      const rawArgs = items.slice(1); // unevaluated AST nodes
      const macroEnv = childEnv(fn.env, fn.params, rawArgs);
      const expanded = await lispEval(fn.body, macroEnv);
      currentAst = expanded;
      continue; // TCO: eval the expanded form
    }

    const args: LispVal[] = [];
    for (let i = 1; i < items.length; i++) {
      args.push(await lispEval(items[i], currentEnv));
    }

    if (fn.tag === 'native') {
      return await fn.fn(...args);
    }

    if (fn.tag === 'fn') {
      currentEnv = childEnv(fn.env, fn.params, args);
      currentAst = fn.body;
      continue; // TCO
    }

    throw new LispEvalError(`Cannot apply non-function: ${fn.tag}`);
  }
}

// --- Apply (used by builtins for higher-order functions) ---

/** Apply a function value to arguments. Shares the active step counter. */
export async function applyFn(fn: LispVal, args: LispVal[]): Promise<LispVal> {
  if (fn.tag === 'native') return await fn.fn(...args);
  if (fn.tag === 'fn') {
    const fnEnv = childEnv(fn.env, fn.params, args);
    return lispEval(fn.body, fnEnv);
  }
  throw new LispEvalError(`Cannot apply non-function: ${fn.tag}`);
}

// --- Quasiquote ---

async function evalQuasiquote(ast: LispVal, env: Env): Promise<LispVal> {
  if (!isList(ast)) return ast;

  const items = ast.val;
  if (items.length === 0) return ast;

  // (unquote expr)
  if (isSym(items[0]) && items[0].val === 'unquote') {
    return lispEval(items[1] ?? Nil, env);
  }

  // Process list elements, handling splice-unquote
  const result: LispVal[] = [];
  for (const item of items) {
    if (isList(item) && item.val.length >= 2 && isSym(item.val[0]) && item.val[0].val === 'splice-unquote') {
      const spliced = await lispEval(item.val[1], env);
      if (isList(spliced)) {
        result.push(...spliced.val);
      } else {
        throw new LispEvalError('splice-unquote requires a list');
      }
    } else {
      result.push(await evalQuasiquote(item, env));
    }
  }

  return List(result);
}
