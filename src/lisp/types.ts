/**
 * Lisp Value Types
 *
 * Tagged union representing all values in the Lisp runtime.
 * Designed for agent state representation and behavior composition.
 */

// --- Tagged Value Types ---

export interface LispNum {
  tag: 'num';
  val: number;
}

export interface LispStr {
  tag: 'str';
  val: string;
}

export interface LispSym {
  tag: 'sym';
  val: string;
}

export interface LispBool {
  tag: 'bool';
  val: boolean;
}

export interface LispNil {
  tag: 'nil';
}

export interface LispList {
  tag: 'list';
  val: LispVal[];
}

export interface LispFn {
  tag: 'fn';
  params: string[];
  body: LispVal;
  env: Env;
  name?: string;
  /** If true, this is a macro — args are not evaluated before expansion. */
  isMacro?: boolean;
}

export interface LispNative {
  tag: 'native';
  name: string;
  fn: (...args: LispVal[]) => LispVal | Promise<LispVal>;
}

export interface LispKeyword {
  tag: 'keyword';
  val: string;
}

export type LispVal =
  | LispNum
  | LispStr
  | LispSym
  | LispBool
  | LispNil
  | LispList
  | LispFn
  | LispNative
  | LispKeyword;

// --- Environment ---

export interface Env {
  bindings: Map<string, LispVal>;
  parent: Env | null;
}

// --- Constructors (convenience) ---

export const Num = (n: number): LispNum => ({ tag: 'num', val: n });
export const Str = (s: string): LispStr => ({ tag: 'str', val: s });
export const Sym = (s: string): LispSym => ({ tag: 'sym', val: s });
export const Bool = (b: boolean): LispBool => ({ tag: 'bool', val: b });
export const Nil: LispNil = { tag: 'nil' };
export const List = (items: LispVal[]): LispList => ({ tag: 'list', val: items });
export const Keyword = (k: string): LispKeyword => ({ tag: 'keyword', val: k });
export const Native = (name: string, fn: (...args: LispVal[]) => LispVal | Promise<LispVal>): LispNative => ({
  tag: 'native',
  name,
  fn,
});

// --- Predicates ---

export const isNum = (v: LispVal): v is LispNum => v.tag === 'num';
export const isStr = (v: LispVal): v is LispStr => v.tag === 'str';
export const isSym = (v: LispVal): v is LispSym => v.tag === 'sym';
export const isBool = (v: LispVal): v is LispBool => v.tag === 'bool';
export const isNil = (v: LispVal): v is LispNil => v.tag === 'nil';
export const isList = (v: LispVal): v is LispList => v.tag === 'list';
export const isFn = (v: LispVal): v is LispFn => v.tag === 'fn';
export const isNative = (v: LispVal): v is LispNative => v.tag === 'native';
export const isKeyword = (v: LispVal): v is LispKeyword => v.tag === 'keyword';

/** Truthy: everything except #f and nil (Lisp convention) */
export const isTruthy = (v: LispVal): boolean => {
  if (v.tag === 'bool') return v.val;
  if (v.tag === 'nil') return false;
  return true;
};
