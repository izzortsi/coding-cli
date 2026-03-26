/**
 * Markdown Core — shared block and inline rendering primitives
 *
 * Used by both markdown.ts (static, returns string) and
 * streamRenderer.ts (streaming, writes to stdout).
 *
 * Handles:
 *   Block  — headers, code blocks, blockquotes, lists (ul/ol/task),
 *            tables, horizontal rules, LaTeX display blocks ($$…$$)
 *   Inline — bold, italic, bold-italic, inline code, strikethrough,
 *            links, inline LaTeX ($…$)
 */

import { BOLD, DIM, ITALIC, UNDERLINE, STRIKETHROUGH, RESET, FG, fg256 } from './colors.js';

// ── Language label colors ────────────────────────────────────────────────────

export const LANG_COLORS: Record<string, string> = {
  typescript: FG.blue,   ts: FG.blue,
  javascript: FG.yellow, js: FG.yellow,
  python: FG.green,      py: FG.green,
  rust: FG.red,
  go: FG.cyan,
  bash: FG.green, sh: FG.green, shell: FG.green,
  json: FG.yellow,
  yaml: FG.magenta, yml: FG.magenta,
  css: FG.magenta,
  html: FG.red,
  sql: FG.blue,
  lisp: FG.magenta,
  c: FG.blue, cpp: FG.blue,
};

// ── Constants ────────────────────────────────────────────────────────────────

// Total visible width of the code block border line (╭ + fill = BOX_WIDTH)
const BOX_WIDTH = 40;

// ── Inline rendering ─────────────────────────────────────────────────────────

/**
 * Apply all inline markdown + LaTeX formatting to a single line of text.
 * Safe to call on code block contents? No — callers must skip it there.
 */
export function renderInline(text: string): string {
  // Inline LaTeX  $…$  (before bold/italic so $ doesn't get mangled)
  text = text.replace(/\$([^$\n]+?)\$/g, (_m, expr) => renderLatexInline(expr));

  // Inline code  `…`  (before bold/italic to avoid conflicts)
  text = text.replace(/`([^`]+)`/g, `${fg256(223)}$1${RESET}`);

  // Bold italic  ***…***
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`);

  // Bold  **…**  or  __…__
  text = text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
  text = text.replace(/__(.+?)__/g, `${BOLD}$1${RESET}`);

  // Italic  *…*  or  _…_
  text = text.replace(/\*([^*\n]+?)\*/g, `${ITALIC}$1${RESET}`);
  text = text.replace(/_([^_\n]+?)_/g, `${ITALIC}$1${RESET}`);

  // Strikethrough  ~~…~~
  text = text.replace(/~~(.+?)~~/g, `${STRIKETHROUGH}${DIM}$1${RESET}`);

  // Links  [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}${FG.brightBlue}$1${RESET} ${DIM}($2)${RESET}`);

  return text;
}

// ── LaTeX helpers ─────────────────────────────────────────────────────────────

/**
 * Render inline LaTeX $expr$ as a dim magenta expression.
 * We can't actually typeset math in a terminal, so we:
 *   - strip the most common LaTeX commands to readable text
 *   - wrap in a distinct color so it's clearly math
 */
function renderLatexInline(expr: string): string {
  const simplified = simplifyLatex(expr);
  return `${FG.brightMagenta}${simplified}${RESET}`;
}

/**
 * Render a display LaTeX block ($$…$$) as an indented magenta block.
 */
export function renderLatexBlock(expr: string): string {
  const lines = expr.trim().split('\n');
  const rendered = lines.map(l => `  ${FG.magenta}│${RESET} ${FG.brightMagenta}${simplifyLatex(l)}${RESET}`);
  return [
    `  ${FG.magenta}╭${'─'.repeat(BOX_WIDTH - 1)}${RESET}`,
    ...rendered,
    `  ${FG.magenta}╰${'─'.repeat(BOX_WIDTH - 1)}${RESET}`,
  ].join('\n');
}

/**
 * Best-effort LaTeX → readable text simplification.
 * Not a full parser — handles the common cases Claude emits.
 */
function simplifyLatex(expr: string): string {
  return expr
    // Fractions: \frac{a}{b} → a/b
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1/$2)')
    // Superscript: x^{n} → x^n,  x^2 → x²  (common cases)
    .replace(/\^\{([^}]+)\}/g, '^$1')
    .replace(/\^2/g, '²').replace(/\^3/g, '³').replace(/\^n/g, 'ⁿ')
    // Subscript: x_{i} → x_i
    .replace(/\_\{([^}]+)\}/g, '_$1')
    // Square root: \sqrt{x} → √x
    .replace(/\\sqrt\{([^}]+)\}/g, '√($1)')
    .replace(/\\sqrt\s+(\S+)/g, '√$1')
    // Common symbols
    .replace(/\\times/g, '×').replace(/\\cdot/g, '·')
    .replace(/\\div/g, '÷').replace(/\\pm/g, '±')
    .replace(/\\leq/g, '≤').replace(/\\geq/g, '≥')
    .replace(/\\neq/g, '≠').replace(/\\approx/g, '≈')
    .replace(/\\infty/g, '∞').replace(/\\sum/g, '∑')
    .replace(/\\prod/g, '∏').replace(/\\int/g, '∫')
    .replace(/\\partial/g, '∂').replace(/\\nabla/g, '∇')
    .replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β')
    .replace(/\\gamma/g, 'γ').replace(/\\delta/g, 'δ')
    .replace(/\\epsilon/g, 'ε').replace(/\\theta/g, 'θ')
    .replace(/\\lambda/g, 'λ').replace(/\\mu/g, 'μ')
    .replace(/\\pi/g, 'π').replace(/\\sigma/g, 'σ')
    .replace(/\\phi/g, 'φ').replace(/\\psi/g, 'ψ')
    .replace(/\\omega/g, 'ω').replace(/\\Omega/g, 'Ω')
    .replace(/\\Delta/g, 'Δ').replace(/\\Sigma/g, 'Σ')
    .replace(/\\in/g, '∈').replace(/\\notin/g, '∉')
    .replace(/\\subset/g, '⊂').replace(/\\cup/g, '∪').replace(/\\cap/g, '∩')
    .replace(/\\forall/g, '∀').replace(/\\exists/g, '∃')
    .replace(/\\to/g, '→').replace(/\\rightarrow/g, '→').replace(/\\leftarrow/g, '←')
    .replace(/\\Rightarrow/g, '⇒').replace(/\\Leftarrow/g, '⇐').replace(/\\Leftrightarrow/g, '⇔')
    // Strip remaining \commands
    .replace(/\\[a-zA-Z]+/g, '')
    // Strip remaining braces
    .replace(/[{}]/g, '')
    .trim();
}

// ── Code block helpers ────────────────────────────────────────────────────────

export function codeBlockOpen(lang: string): string {
  const langColor = LANG_COLORS[lang.toLowerCase()] ?? FG.gray;
  const langLabel = lang ? ` ${langColor}${lang}${RESET}` : '';
  // ╭── lang ──────────  total visible = BOX_WIDTH
  // "╭──" = 3 chars, " lang" = lang.length+1, fill the rest
  const fillLen = Math.max(0, BOX_WIDTH - 3 - (lang ? lang.length + 1 : 0));
  return `  ${FG.gray}╭──${langLabel}${FG.gray}${'─'.repeat(fillLen)}${RESET}`;
}

export function codeBlockClose(): string {
  // ╰── (1) + ─×(BOX_WIDTH-1) = BOX_WIDTH total
  return `  ${FG.gray}╰${'─'.repeat(BOX_WIDTH - 1)}${RESET}`;
}

export function codeBlockLine(line: string): string {
  return `  ${FG.gray}│${RESET} ${line}`;
}

// ── Table rendering ───────────────────────────────────────────────────────────

/**
 * Detect whether a line looks like a markdown table separator row.
 * e.g. | --- | :---: | ---: |
 */
export function isTableSeparator(line: string): boolean {
  return /^\|?(\s*:?-+:?\s*\|)+\s*$/.test(line.trim());
}

/**
 * Parse a markdown table from a block of lines.
 * Returns rendered ANSI string or null if not a valid table.
 */
export function renderTable(lines: string[]): string | null {
  if (lines.length < 2) return null;

  const parseRow = (line: string): string[] =>
    line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  const header = parseRow(lines[0]);
  if (!isTableSeparator(lines[1])) return null;

  const sepRow = lines[1].replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const aligns: Array<'left' | 'center' | 'right'> = sepRow.map(s => {
    if (s.startsWith(':') && s.endsWith(':')) return 'center';
    if (s.endsWith(':')) return 'right';
    return 'left';
  });

  const dataRows = lines.slice(2).map(parseRow);
  const allRows = [header, ...dataRows];
  const cols = header.length;

  // Column widths (visible chars)
  const widths = Array.from({ length: cols }, (_, ci) =>
    Math.max(...allRows.map(r => (r[ci] ?? '').length))
  );

  function padCell(text: string, width: number, align: 'left' | 'center' | 'right'): string {
    const pad = Math.max(0, width - text.length);
    if (align === 'right') return ' '.repeat(pad) + text;
    if (align === 'center') {
      const l = Math.floor(pad / 2), r = pad - l;
      return ' '.repeat(l) + text + ' '.repeat(r);
    }
    return text + ' '.repeat(pad);
  }

  const border = (l: string, m: string, r: string, f: string) =>
    `  ${FG.gray}${l}${widths.map(w => f.repeat(w + 2)).join(m)}${r}${RESET}`;

  const top    = border('╭', '┬', '╮', '─');
  const mid    = border('├', '┼', '┤', '─');
  const bottom = border('╰', '┴', '╯', '─');

  const renderRow = (row: string[], isHeader: boolean): string => {
    const cells = widths.map((w, ci) => {
      const text = row[ci] ?? '';
      const padded = padCell(text, w, aligns[ci] ?? 'left');
      return isHeader
        ? ` ${BOLD}${FG.brightWhite}${padded}${RESET} `
        : ` ${renderInline(padded)} `;
    });
    return `  ${FG.gray}│${RESET}${cells.join(`${FG.gray}│${RESET}`)}${FG.gray}│${RESET}`;
  };

  const out: string[] = [top, renderRow(header, true), mid];
  for (const row of dataRows) out.push(renderRow(row, false));
  out.push(bottom);
  return out.join('\n');
}

// ── Block-level line classifier ───────────────────────────────────────────────

export type BlockLine =
  | { type: 'fence';      lang: string }
  | { type: 'fence_end' }
  | { type: 'latex_block_delim' }
  | { type: 'hr' }
  | { type: 'heading';    level: number; text: string }
  | { type: 'blockquote'; text: string }
  | { type: 'ul';         indent: string; text: string }
  | { type: 'ol';         indent: string; num: string; text: string }
  | { type: 'task';       indent: string; checked: boolean; text: string }
  | { type: 'table_row';  raw: string }
  | { type: 'empty' }
  | { type: 'text';       raw: string };

export function classifyLine(line: string, inCodeBlock: boolean, inLatexBlock: boolean): BlockLine {
  if (inLatexBlock) {
    if (line.trim() === '$$') return { type: 'latex_block_delim' };
    return { type: 'text', raw: line };
  }

  if (inCodeBlock) {
    if (line.trimStart().startsWith('```')) return { type: 'fence_end' };
    return { type: 'text', raw: line };
  }

  if (line.trim() === '$$' || line.startsWith('$$')) return { type: 'latex_block_delim' };
  if (line.trimStart().startsWith('```')) return { type: 'fence', lang: line.trimStart().slice(3).trim() };
  if (/^(\s*[-*_]\s*){3,}$/.test(line)) return { type: 'hr' };

  const hm = line.match(/^(#{1,6})\s+(.+)/);
  if (hm) return { type: 'heading', level: hm[1].length, text: hm[2] };

  if (line.trimStart().startsWith('> ')) return { type: 'blockquote', text: line.trimStart().slice(2) };

  // Task list  - [ ]  or  - [x]  (before ul)
  const taskMatch = line.match(/^(\s*)[-*+]\s+\[( |x|X)\]\s+(.+)/);
  if (taskMatch) return { type: 'task', indent: taskMatch[1], checked: taskMatch[2].toLowerCase() === 'x', text: taskMatch[3] };

  const ulMatch = line.match(/^(\s*)([-*+])\s+(.+)/);
  if (ulMatch) return { type: 'ul', indent: ulMatch[1], text: ulMatch[3] };

  const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
  if (olMatch) return { type: 'ol', indent: olMatch[1], num: olMatch[2], text: olMatch[3] };

  if (line.trimStart().startsWith('|')) return { type: 'table_row', raw: line };

  if (line.trim() === '') return { type: 'empty' };

  return { type: 'text', raw: line };
}

// ── Single-line block renderer ────────────────────────────────────────────────
// Returns the rendered string for a single classified non-table line.

export function renderBlockLine(bl: BlockLine): string {
  switch (bl.type) {
    case 'hr':
      return `  ${FG.gray}${'─'.repeat(BOX_WIDTH)}${RESET}`;

    case 'heading': {
      const content = renderInline(bl.text);
      if (bl.level === 1) return `\n  ${BOLD}${FG.brightWhite}${content}${RESET}\n  ${FG.gray}${'─'.repeat(30)}${RESET}`;
      if (bl.level === 2) return `\n  ${BOLD}${FG.brightCyan}${content}${RESET}`;
      return `  ${BOLD}${FG.cyan}${content}${RESET}`;
    }

    case 'blockquote':
      return `  ${FG.gray}┃${RESET} ${DIM}${renderInline(bl.text)}${RESET}`;

    case 'ul': {
      const depth = Math.floor(bl.indent.length / 2);
      const bullet = depth === 0 ? `${FG.cyan}●${RESET}` : `${FG.gray}○${RESET}`;
      return `  ${bl.indent}${bullet} ${renderInline(bl.text)}`;
    }

    case 'ol':
      return `  ${bl.indent}${FG.cyan}${bl.num}.${RESET} ${renderInline(bl.text)}`;

    case 'task': {
      const box = bl.checked
        ? `${FG.brightGreen}▣${RESET}`
        : `${FG.gray}▢${RESET}`;
      const content = bl.checked
        ? `${DIM}${renderInline(bl.text)}${RESET}`
        : renderInline(bl.text);
      return `  ${bl.indent}${box} ${content}`;
    }

    case 'empty':
      return '';

    case 'text':
      return `  ${renderInline(bl.raw)}`;

    default:
      return '';
  }
}
