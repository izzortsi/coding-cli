/**
 * Lisp Printer
 *
 * Serializes LispVal back to source text.
 * Round-trippable: print(read(s)) ≈ s for data values.
 */

import type { LispVal } from './types.js';

/** Print a LispVal as a readable string. */
export function print(val: LispVal, readable = true): string {
  switch (val.tag) {
    case 'num':
      return Number.isInteger(val.val) ? val.val.toString() : val.val.toString();
    case 'str':
      if (readable) {
        return '"' + val.val
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\t/g, '\\t')
          .replace(/\r/g, '\\r') + '"';
      }
      return val.val;
    case 'sym':
      return val.val;
    case 'bool':
      return val.val ? '#t' : '#f';
    case 'nil':
      return 'nil';
    case 'keyword':
      return ':' + val.val;
    case 'list':
      return '(' + val.val.map(v => print(v, readable)).join(' ') + ')';
    case 'fn':
      return val.name
        ? `#<fn:${val.name}>`
        : `#<fn:(${val.params.join(' ')})>`;
    case 'native':
      return `#<native:${val.name}>`;
  }
}

/** Print a value for display (strings unquoted). */
export function display(val: LispVal): string {
  return print(val, false);
}

/** Special forms that use 2-space body indentation (head + args on first line). */
const SPECIAL_INDENT = new Set([
  'define', 'lambda', 'fn', 'if', 'cond', 'let', 'begin', 'do',
  'try', 'catch', 'when', 'unless', 'set!',
]);

/** Pretty-print with Lisp-aware indentation. */
export function prettyPrint(val: LispVal, indent = 0): string {
  if (val.tag !== 'list' || val.val.length === 0) {
    return print(val);
  }

  // Short lists print on one line
  const oneLine = print(val);
  if (oneLine.length + indent <= 80) return oneLine;

  const head = val.val[0];
  const rest = val.val.slice(1);
  const headStr = print(head);
  const isSpecial = head.tag === 'sym' && SPECIAL_INDENT.has(head.val);

  if (rest.length === 0) return `(${headStr})`;

  if (isSpecial) {
    return ppSpecial(head.val, headStr, rest, indent);
  }

  // Default: function call — head + first arg on same line if they fit,
  // rest aligned under first arg
  const firstArg = prettyPrint(rest[0], indent + headStr.length + 2);
  const firstLine = `(${headStr} ${firstArg}`;
  if (rest.length === 1) return firstLine + ')';

  const alignIndent = indent + headStr.length + 2;
  const restLines = rest.slice(1).map(v =>
    ' '.repeat(alignIndent) + prettyPrint(v, alignIndent)
  );
  return firstLine + '\n' + restLines.join('\n') + ')';
}

/** Pretty-print special forms with Lisp-conventional formatting. */
function ppSpecial(form: string, headStr: string, rest: LispVal[], indent: number): string {
  const bodyIndent = indent + 2;
  const bi = ' '.repeat(bodyIndent);

  if (form === 'define' && rest.length >= 2) {
    // (define (name args...) body...)
    const sig = prettyPrint(rest[0], bodyIndent);
    const body = rest.slice(1).map(v => bi + prettyPrint(v, bodyIndent));
    return `(${headStr} ${sig}\n${body.join('\n')})`;
  }

  if (form === 'if') {
    // (if test then else) — each on its own line at body indent
    const parts = rest.map(v => bi + prettyPrint(v, bodyIndent));
    return `(${headStr}\n${parts.join('\n')})`;
  }

  if (form === 'let' && rest.length >= 2) {
    // (let ((a 1) (b 2)) body...)
    const bindings = prettyPrint(rest[0], bodyIndent + 1);
    const body = rest.slice(1).map(v => bi + prettyPrint(v, bodyIndent));
    return `(${headStr} (${bindings.startsWith('(') ? bindings.slice(1) : bindings}\n${body.join('\n')})`;
  }

  if (form === 'lambda' || form === 'fn') {
    // (fn (args) body...)
    const params = print(rest[0]);
    const body = rest.slice(1).map(v => bi + prettyPrint(v, bodyIndent));
    return `(${headStr} ${params}\n${body.join('\n')})`;
  }

  if (form === 'try' && rest.length >= 2) {
    // (try expr (catch e handler))
    const parts = rest.map(v => bi + prettyPrint(v, bodyIndent));
    return `(${headStr}\n${parts.join('\n')})`;
  }

  // Generic special form: head on first line, rest at body indent
  const parts = rest.map(v => bi + prettyPrint(v, bodyIndent));
  return `(${headStr}\n${parts.join('\n')})`;
}
