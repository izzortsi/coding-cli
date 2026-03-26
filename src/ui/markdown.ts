/**
 * Markdown → ANSI Renderer (static)
 *
 * Converts a complete markdown string to an ANSI-styled string.
 * Delegates all primitives to markdownCore.
 */

import {
  renderInline,
  renderBlockLine,
  renderLatexBlock,
  renderTable,
  codeBlockOpen,
  codeBlockClose,
  codeBlockLine,
  classifyLine,
  isTableSeparator,
} from './markdownCore.js';

export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];

  let inCodeBlock = false;
  let inLatexBlock = false;
  let latexLines: string[] = [];
  let tableLines: string[] = [];

  function flushTable(): void {
    if (tableLines.length === 0) return;
    const rendered = renderTable(tableLines);
    if (rendered) {
      out.push(rendered);
    } else {
      // Not a valid table — emit raw
      for (const l of tableLines) out.push(`  ${renderInline(l)}`);
    }
    tableLines = [];
  }

  for (const line of lines) {
    const bl = classifyLine(line, inCodeBlock, inLatexBlock);

    // ── LaTeX block ──────────────────────────────────────────────────────────
    if (inLatexBlock) {
      if (bl.type === 'latex_block_delim') {
        out.push(renderLatexBlock(latexLines.join('\n')));
        latexLines = [];
        inLatexBlock = false;
      } else {
        latexLines.push(line);
      }
      continue;
    }

    if (bl.type === 'latex_block_delim') {
      flushTable();
      inLatexBlock = true;
      latexLines = [];
      continue;
    }

    // ── Code block ───────────────────────────────────────────────────────────
    if (inCodeBlock) {
      if (bl.type === 'fence_end') {
        out.push(codeBlockClose());
        inCodeBlock = false;
      } else {
        out.push(codeBlockLine(line));
      }
      continue;
    }

    if (bl.type === 'fence') {
      flushTable();
      out.push(codeBlockOpen(bl.lang));
      inCodeBlock = true;
      continue;
    }

    // ── Table accumulation ───────────────────────────────────────────────────
    if (bl.type === 'table_row') {
      tableLines.push(line);
      continue;
    }

    // A non-table line flushes any buffered table rows
    if (tableLines.length > 0) {
      // Keep accumulating if this is a separator (part of the table header)
      if (isTableSeparator(line)) {
        tableLines.push(line);
        continue;
      }
      flushTable();
    }

    // ── Everything else ──────────────────────────────────────────────────────
    out.push(renderBlockLine(bl));
  }

  // Flush any trailing table or open blocks
  flushTable();
  if (inCodeBlock) out.push(codeBlockClose());
  if (inLatexBlock && latexLines.length > 0) out.push(renderLatexBlock(latexLines.join('\n')));

  return out.join('\n');
}
