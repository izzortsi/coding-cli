/**
 * Lisp Builtins
 *
 * Core primitives registered into the base environment.
 * Categories: arithmetic, comparison, list ops, string ops,
 *             type predicates, higher-order, association lists,
 *             file I/O.
 */

import type { LispVal, Env } from './types.js';
import { Num, Str, Bool, Nil, List, Keyword, Native, isNum, isStr, isList, isNil, isKeyword, isTruthy } from './types.js';
import { envSet } from './env.js';
import { print, display } from './printer.js';
import { applyFn, LispEvalError } from './eval.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

export function installBuiltins(env: Env): void {
  const def = (name: string, fn: (...args: LispVal[]) => LispVal | Promise<LispVal>) => {
    envSet(env, name, Native(name, fn));
  };

  // --- Arithmetic ---

  def('+', (...args) => Num(args.reduce((a, b) => a + numVal(b), 0)));
  def('-', (...args) => {
    if (args.length === 0) return Num(0);
    if (args.length === 1) return Num(-numVal(args[0]));
    return Num(args.slice(1).reduce((a, b) => a - numVal(b), numVal(args[0])));
  });
  def('*', (...args) => Num(args.reduce((a, b) => a * numVal(b), 1)));
  def('/', (...args) => {
    if (args.length < 2) throw new LispEvalError('/ requires at least 2 arguments');
    return Num(args.slice(1).reduce((a, b) => {
      const d = numVal(b);
      if (d === 0) throw new LispEvalError('Division by zero');
      return a / d;
    }, numVal(args[0])));
  });
  def('mod', (a, b) => {
    const d = numVal(b);
    if (d === 0) throw new LispEvalError('mod: division by zero');
    return Num(numVal(a) % d);
  });
  def('abs', (a) => Num(Math.abs(numVal(a))));
  def('min', (...args) => {
    if (args.length === 0) throw new LispEvalError('min: requires at least 1 argument');
    return Num(Math.min(...args.map(numVal)));
  });
  def('max', (...args) => {
    if (args.length === 0) throw new LispEvalError('max: requires at least 1 argument');
    return Num(Math.max(...args.map(numVal)));
  });

  // --- Comparison ---

  def('=', (a, b) => Bool(lispEqual(a, b)));
  def('!=', (a, b) => Bool(!lispEqual(a, b)));
  def('<', (a, b) => Bool(numVal(a) < numVal(b)));
  def('>', (a, b) => Bool(numVal(a) > numVal(b)));
  def('<=', (a, b) => Bool(numVal(a) <= numVal(b)));
  def('>=', (a, b) => Bool(numVal(a) >= numVal(b)));

  // --- Type Predicates ---

  def('number?', (a) => Bool(a.tag === 'num'));
  def('string?', (a) => Bool(a.tag === 'str'));
  def('symbol?', (a) => Bool(a.tag === 'sym'));
  def('bool?', (a) => Bool(a.tag === 'bool'));
  def('nil?', (a) => Bool(a.tag === 'nil'));
  def('list?', (a) => Bool(a.tag === 'list'));
  def('fn?', (a) => Bool(a.tag === 'fn' || a.tag === 'native'));
  def('keyword?', (a) => Bool(a.tag === 'keyword'));
  def('empty?', (a) => Bool(isList(a) && a.val.length === 0));

  // --- List Operations ---

  def('list', (...args) => List(args));
  def('cons', (head, tail) => {
    if (isList(tail)) return List([head, ...tail.val]);
    return List([head, tail]);
  });
  def('car', (lst) => {
    if (!isList(lst) || lst.val.length === 0) throw new LispEvalError('car: empty list');
    return lst.val[0];
  });
  def('cdr', (lst) => {
    if (!isList(lst) || lst.val.length === 0) throw new LispEvalError('cdr: empty list');
    return List(lst.val.slice(1));
  });
  def('first', (lst) => isList(lst) && lst.val.length > 0 ? lst.val[0] : Nil);
  def('second', (lst) => isList(lst) && lst.val.length > 1 ? lst.val[1] : Nil);
  def('third', (lst) => isList(lst) && lst.val.length > 2 ? lst.val[2] : Nil);
  def('rest', (lst) => isList(lst) ? List(lst.val.slice(1)) : List([]));
  def('nth', (lst, n) => {
    if (!isList(lst)) throw new LispEvalError('nth: not a list');
    const idx = numVal(n);
    return lst.val[idx] ?? Nil;
  });
  def('length', (lst) => {
    if (isList(lst)) return Num(lst.val.length);
    if (isStr(lst)) return Num(lst.val.length);
    throw new LispEvalError('length: not a list or string');
  });
  def('append', (...args) => {
    const items: LispVal[] = [];
    for (const a of args) {
      if (isList(a)) items.push(...a.val);
      else items.push(a);
    }
    return List(items);
  });
  def('reverse', (lst) => {
    if (!isList(lst)) throw new LispEvalError('reverse: not a list');
    return List([...lst.val].reverse());
  });
  def('last', (lst) => {
    if (!isList(lst)) throw new LispEvalError('last: not a list');
    const { val } = lst;
    return val.length > 0 ? val[val.length - 1] : Nil;
  });
  def('range', (start, end) => {
    const s = numVal(start);
    const e = numVal(end);
    const items: LispVal[] = [];
    for (let i = s; i < e; i++) items.push(Num(i));
    return List(items);
  });
  def('flatten', (lst) => {
    if (!isList(lst)) return List([lst]);
    const flat: LispVal[] = [];
    for (const item of lst.val) {
      if (isList(item)) flat.push(...item.val);
      else flat.push(item);
    }
    return List(flat);
  });

  // --- Higher-order ---

  def('map', async (fn, lst) => {
    if (!isList(lst)) throw new LispEvalError('map: second arg must be a list');
    const results: LispVal[] = [];
    for (const item of lst.val) {
      results.push(await applyFn(fn, [item]));
    }
    return List(results);
  });
  def('filter', async (fn, lst) => {
    if (!isList(lst)) throw new LispEvalError('filter: second arg must be a list');
    const results: LispVal[] = [];
    for (const item of lst.val) {
      if (isTruthy(await applyFn(fn, [item]))) {
        results.push(item);
      }
    }
    return List(results);
  });
  def('reduce', async (fn, init, lst) => {
    if (!isList(lst)) throw new LispEvalError('reduce: third arg must be a list');
    let acc = init;
    for (const item of lst.val) {
      acc = await applyFn(fn, [acc, item]);
    }
    return acc;
  });
  def('for-each', async (fn, lst) => {
    if (!isList(lst)) throw new LispEvalError('for-each: second arg must be a list');
    for (const item of lst.val) {
      await applyFn(fn, [item]);
    }
    return Nil;
  });
  def('apply', async (fn, lst) => {
    if (!isList(lst)) throw new LispEvalError('apply: second arg must be a list');
    return applyFn(fn, lst.val);
  });

  // --- Association Lists (key-value pairs as lists of (key val)) ---

  def('assoc', (key, ...pairs) => {
    // (assoc key alist) — lookup
    // (assoc key val alist) — set/update
    if (pairs.length === 1) {
      // Lookup
      const alist = pairs[0];
      if (!isList(alist)) return Nil;
      for (const pair of alist.val) {
        if (isList(pair) && pair.val.length >= 2 && lispEqual(pair.val[0], key)) {
          return pair.val[1];
        }
      }
      return Nil;
    }
    if (pairs.length === 2) {
      // Set/update: returns new alist
      const val = pairs[0];
      const alist = pairs[1];
      if (!isList(alist)) return List([List([key, val])]);
      const result: LispVal[] = [];
      let found = false;
      for (const pair of alist.val) {
        if (isList(pair) && pair.val.length >= 2 && lispEqual(pair.val[0], key)) {
          result.push(List([key, val]));
          found = true;
        } else {
          result.push(pair);
        }
      }
      if (!found) result.push(List([key, val]));
      return List(result);
    }
    throw new LispEvalError('assoc: 2 or 3 args required');
  });

  def('dissoc', (key, alist) => {
    if (!isList(alist)) return List([]);
    return List(alist.val.filter(pair =>
      !(isList(pair) && pair.val.length >= 2 && lispEqual(pair.val[0], key))
    ));
  });

  def('keys', (alist) => {
    if (!isList(alist)) return List([]);
    return List(alist.val
      .filter(pair => isList(pair) && pair.val.length >= 2)
      .map(pair => (pair as any).val[0]));
  });

  def('vals', (alist) => {
    if (!isList(alist)) return List([]);
    return List(alist.val
      .filter(pair => isList(pair) && pair.val.length >= 2)
      .map(pair => (pair as any).val[1]));
  });

  // --- String Operations ---

  def('str', (...args) => Str(args.map(a => display(a)).join('')));
  def('str-join', (sep, lst) => {
    if (!isStr(sep) || !isList(lst)) throw new LispEvalError('str-join: (str-join sep list)');
    return Str(lst.val.map(v => display(v)).join(sep.val));
  });
  def('str-split', (sep, s) => {
    if (!isStr(sep) || !isStr(s)) throw new LispEvalError('str-split: (str-split sep str)');
    return List(s.val.split(sep.val).map(Str));
  });
  def('str-contains?', (substr, s) => {
    if (!isStr(substr) || !isStr(s)) throw new LispEvalError('str-contains?: strings required');
    return Bool(s.val.includes(substr.val));
  });
  def('str-starts?', (prefix, s) => {
    if (!isStr(prefix) || !isStr(s)) throw new LispEvalError('str-starts?: strings required');
    return Bool(s.val.startsWith(prefix.val));
  });
  def('str-ends?', (suffix, s) => {
    if (!isStr(suffix) || !isStr(s)) throw new LispEvalError('str-ends?: strings required');
    return Bool(s.val.endsWith(suffix.val));
  });
  def('str-upper', (s) => Str(strVal(s).toUpperCase()));
  def('str-lower', (s) => Str(strVal(s).toLowerCase()));
  def('str-trim', (s) => Str(strVal(s).trim()));
  def('str-len', (s) => Num(strVal(s).length));
  def('substring', (s, start, end) => {
    return Str(strVal(s).substring(numVal(start), numVal(end)));
  });
  def('str-replace', (s, target, replacement) => {
    return Str(strVal(s).split(strVal(target)).join(strVal(replacement)));
  });
  def('str-index-of', (substr, s) => {
    return Num(strVal(s).indexOf(strVal(substr)));
  });

  // --- Conversion ---

  def('number->string', (n) => Str(numVal(n).toString()));
  def('string->number', (s) => {
    const n = parseFloat(strVal(s));
    return isNaN(n) ? Nil : Num(n);
  });
  def('symbol->string', (s) => {
    if (s.tag !== 'sym') throw new LispEvalError('symbol->string: not a symbol');
    return Str(s.val);
  });
  def('string->symbol', (s) => {
    if (!isStr(s)) throw new LispEvalError('string->symbol: not a string');
    return { tag: 'sym', val: s.val };
  });

  // --- Display / Debug ---

  def('print', (...args) => Str(args.map(a => print(a)).join(' ')));
  def('display', (...args) => Str(args.map(a => display(a)).join(' ')));
  def('typeof', (a) => Str(a.tag));

  // --- Logic ---

  def('not', (a) => Bool(!isTruthy(a)));

  // --- Error ---

  def('error', (...args) => {
    const msg = args.map(a => display(a)).join(' ');
    throw new LispEvalError(msg);
  });

  // --- Composition ---

  def('compose', (...fns) => {
    return Native('composed', async (...args) => {
      let result: LispVal = await applyFn(fns[fns.length - 1], args);
      for (let i = fns.length - 2; i >= 0; i--) {
        result = await applyFn(fns[i], [result]);
      }
      return result;
    });
  });

  def('pipe', async (val, ...fns) => {
    let result = val;
    for (const fn of fns) {
      result = await applyFn(fn, [result]);
    }
    return result;
  });

  def('identity', (x) => x);
  def('constantly', (x) => Native('const', () => x));

  // --- Meta ---

  let gensymCounter = 0;
  def('gensym', (...args) => {
    const prefix = args.length > 0 && isStr(args[0]) ? args[0].val : 'g';
    return { tag: 'sym', val: `${prefix}__${gensymCounter++}` };
  });

  // --- JSON Interop ---

  def('json->sexp', (s) => {
    if (!isStr(s)) throw new LispEvalError('json->sexp: expected string');
    try {
      return jsonToLisp(JSON.parse(s.val));
    } catch (e) {
      throw new LispEvalError(`json->sexp: invalid JSON — ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  def('sexp->json', (...args) => {
    const val = args[0];
    const indent = args.length > 1 && isNum(args[1]) ? args[1].val : undefined;
    return Str(JSON.stringify(lispToJson(val), null, indent));
  });

  // --- File I/O ---
  // Paths starting with ~ expand to homedir. Otherwise resolved relative to CWD.

  def('file-read', (path) => {
    try {
      const p = resolvePath(strVal(path));
      return Str(readFileSync(p, 'utf-8'));
    } catch (e: any) {
      return Str('Error: ' + e.message);
    }
  });

  def('file-write', (path, content) => {
    try {
      const p = resolvePath(strVal(path));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, strVal(content), 'utf-8');
      return Str('ok');
    } catch (e: any) {
      return Str('Error: ' + e.message);
    }
  });

  def('file-delete', (path) => {
    try {
      const p = resolvePath(strVal(path));
      unlinkSync(p);
      return Str('ok');
    } catch (e: any) {
      return Str('Error: ' + e.message);
    }
  });

  def('file-exists?', (path) => {
    try {
      return Bool(existsSync(resolvePath(strVal(path))));
    } catch (e: any) {
      return Bool(false);
    }
  });

  def('file-list', (dir) => {
    try {
      const p = resolvePath(strVal(dir));
      const entries = readdirSync(p);
      return List(entries.map(e => Str(e)));
    } catch (e: any) {
      return List([]);
    }
  });

  def('file-stat', (path) => {
    try {
      const s = statSync(resolvePath(strVal(path)));
      return List([
        List([Keyword('size'), Num(s.size)]),
        List([Keyword('modified'), Num(s.mtimeMs)]),
        List([Keyword('is-directory'), Bool(s.isDirectory())]),
      ]);
    } catch (e: any) {
      return List([]);
    }
  });

  def('grove-data-dir', () => {
    // ~/.grove-cli/datasets/
    const base = join(homedir(), '.grove-cli', 'datasets');
    mkdirSync(base, { recursive: true });
    return Str(base);
  });
}

function resolvePath(raw: string): string {
  if (raw.startsWith('~/') || raw === '~') {
    return join(homedir(), raw.slice(1));
  }
  return resolve(raw);
}

// --- Helpers ---

function numVal(v: LispVal): number {
  if (v.tag !== 'num') throw new LispEvalError(`Expected number, got ${v.tag}`);
  return v.val;
}

function strVal(v: LispVal): string {
  if (v.tag !== 'str') throw new LispEvalError(`Expected string, got ${v.tag}`);
  return v.val;
}

/** Deep equality for Lisp values. */
function lispEqual(a: LispVal, b: LispVal): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case 'num': return a.val === (b as typeof a).val;
    case 'str': return a.val === (b as typeof a).val;
    case 'sym': return a.val === (b as typeof a).val;
    case 'bool': return a.val === (b as typeof a).val;
    case 'keyword': return a.val === (b as typeof a).val;
    case 'nil': return true;
    case 'list': {
      const bList = b as typeof a;
      if (a.val.length !== bList.val.length) return false;
      return a.val.every((item, i) => lispEqual(item, bList.val[i]));
    }
    default: return a === b; // functions compare by identity
  }
}

// --- JSON Conversion ---

function jsonToLisp(val: unknown): LispVal {
  if (val === null || val === undefined) return Nil;
  if (typeof val === 'number') return Num(val);
  if (typeof val === 'string') return Str(val);
  if (typeof val === 'boolean') return Bool(val);
  if (Array.isArray(val)) return List(val.map(jsonToLisp));
  if (typeof val === 'object') {
    // Object → alist: ((:key val) ...)
    const entries = Object.entries(val as Record<string, unknown>);
    return List(entries.map(([k, v]) => List([Keyword(k), jsonToLisp(v)])));
  }
  return Nil;
}

function lispToJson(val: LispVal): unknown {
  switch (val.tag) {
    case 'num': return val.val;
    case 'str': return val.val;
    case 'bool': return val.val;
    case 'nil': return null;
    case 'keyword': return val.val;
    case 'sym': return val.val;
    case 'list': {
      // Alist detection: all elements are 2-element lists with keyword keys → object
      if (val.val.length > 0 && val.val.every(item =>
        isList(item) && item.val.length === 2 && isKeyword(item.val[0]))) {
        const obj: Record<string, unknown> = {};
        for (const pair of val.val) {
          if (isList(pair) && isKeyword(pair.val[0])) {
            obj[pair.val[0].val] = lispToJson(pair.val[1]);
          }
        }
        return obj;
      }
      return val.val.map(lispToJson);
    }
    default: return null;
  }
}
