/**
 * Lisp Reader (Parser)
 *
 * Converts source text into LispVal s-expressions.
 * Supports: numbers, strings, symbols, booleans, nil, keywords,
 *           lists, quote/quasiquote/unquote/splice-unquote, comments.
 */

import { type LispVal, Num, Str, Sym, Bool, Nil, List, Keyword } from './types.js';

// --- Tokenizer ---

type Token = string;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Comment — skip to end of line
    if (ch === ';') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    // String literal
    if (ch === '"') {
      let str = '"';
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          str += source[i++];
        }
        str += source[i++];
      }
      if (i >= source.length) throw new LispReadError('Unterminated string literal');
      str += source[i++]; // closing quote
      tokens.push(str);
      continue;
    }

    // Parens
    if (ch === '(' || ch === ')') {
      tokens.push(ch);
      i++;
      continue;
    }

    // Quote shorthands
    if (ch === "'") {
      tokens.push("'");
      i++;
      continue;
    }
    if (ch === '`') {
      tokens.push('`');
      i++;
      continue;
    }
    if (ch === '~') {
      if (source[i + 1] === '@') {
        tokens.push('~@');
        i += 2;
      } else {
        tokens.push('~');
        i++;
      }
      continue;
    }

    // Atom (symbol, number, keyword, boolean, nil)
    let atom = '';
    while (i < source.length && !/[\s();'`~]/.test(source[i]) && source[i] !== '"') {
      atom += source[i++];
    }
    if (atom.length > 0) tokens.push(atom);
  }

  return tokens;
}

// --- Parser ---

class Reader {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new LispReadError('Unexpected end of input');
    this.pos++;
    return tok;
  }

  done(): boolean {
    return this.pos >= this.tokens.length;
  }

  readForm(): LispVal {
    const tok = this.peek();
    if (tok === undefined) throw new LispReadError('Unexpected end of input');

    switch (tok) {
      case '(':
        return this.readList();
      case "'":
        this.next();
        return List([Sym('quote'), this.readForm()]);
      case '`':
        this.next();
        return List([Sym('quasiquote'), this.readForm()]);
      case '~':
        this.next();
        return List([Sym('unquote'), this.readForm()]);
      case '~@':
        this.next();
        return List([Sym('splice-unquote'), this.readForm()]);
      case ')':
        throw new LispReadError('Unexpected )');
      default:
        return this.readAtom();
    }
  }

  readList(): LispVal {
    this.next(); // consume '('
    const items: LispVal[] = [];
    while (this.peek() !== ')') {
      if (this.done()) throw new LispReadError('Unterminated list — missing )');
      items.push(this.readForm());
    }
    this.next(); // consume ')'
    return List(items);
  }

  readAtom(): LispVal {
    const tok = this.next();

    // Boolean
    if (tok === '#t' || tok === 'true') return Bool(true);
    if (tok === '#f' || tok === 'false') return Bool(false);

    // Nil
    if (tok === 'nil') return Nil;

    // Number
    if (/^-?\d+(\.\d+)?$/.test(tok)) return Num(parseFloat(tok));

    // String
    if (tok.startsWith('"') && tok.endsWith('"')) {
      const raw = tok.slice(1, -1);
      // Process escape sequences — backslash MUST be first to prevent \\n from becoming \ + newline
      const val = raw
        .replace(/\\\\/g, '\x00BACKSLASH\x00') // placeholder to protect escaped backslashes
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\x00BACKSLASH\x00/g, '\\');
      return Str(val);
    }

    // Keyword (:name)
    if (tok.startsWith(':')) return Keyword(tok.slice(1));

    // Symbol
    return Sym(tok);
  }
}

// --- Public API ---

export class LispReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LispReadError';
  }
}

/** Parse a single s-expression from source text. */
export function read(source: string): LispVal {
  const tokens = tokenize(source);
  if (tokens.length === 0) return Nil;
  const reader = new Reader(tokens);
  return reader.readForm();
}

/** Parse all top-level s-expressions from source text. */
export function readAll(source: string): LispVal[] {
  const tokens = tokenize(source);
  if (tokens.length === 0) return [];
  const reader = new Reader(tokens);
  const forms: LispVal[] = [];
  while (!reader.done()) {
    forms.push(reader.readForm());
  }
  return forms;
}
