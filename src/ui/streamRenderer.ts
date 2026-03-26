/**
 * Stream Renderer — Incremental markdown rendering for streamed text
 *
 * Buffers incoming text chunks and renders complete lines with markdown
 * formatting as soon as a newline arrives. Delegates all rendering
 * primitives to markdownCore.
 *
 * Tables and LaTeX display blocks are buffered until closed (we need
 * all rows before we can compute column widths / render the block).
 */

import {
  renderBlockLine,
  renderLatexBlock,
  renderTable,
  codeBlockOpen,
  codeBlockClose,
  codeBlockLine,
  classifyLine,
  isTableSeparator,
} from './markdownCore.js';

export class StreamRenderer {
  private buffer = '';
  private inCodeBlock = false;
  private inLatexBlock = false;
  private latexLines: string[] = [];
  private tableLines: string[] = [];

  write(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const nlIdx = this.buffer.indexOf('\n');
      if (nlIdx === -1) break;
      const line = this.buffer.substring(0, nlIdx);
      this.buffer = this.buffer.substring(nlIdx + 1);
      this.renderLine(line);
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.renderLine(this.buffer);
      this.buffer = '';
    }
    this.flushTable();
    if (this.inCodeBlock) {
      process.stdout.write(codeBlockClose() + '\n');
      this.inCodeBlock = false;
    }
    if (this.inLatexBlock && this.latexLines.length > 0) {
      process.stdout.write(renderLatexBlock(this.latexLines.join('\n')) + '\n');
      this.latexLines = [];
      this.inLatexBlock = false;
    }
    process.stdout.write('\n');
  }

  private flushTable(): void {
    if (this.tableLines.length === 0) return;
    const rendered = renderTable(this.tableLines);
    if (rendered) {
      process.stdout.write(rendered + '\n');
    } else {
      for (const l of this.tableLines) {
        process.stdout.write(`  ${l}\n`);
      }
    }
    this.tableLines = [];
  }

  private renderLine(line: string): void {
    const bl = classifyLine(line, this.inCodeBlock, this.inLatexBlock);

    // ── LaTeX block ──────────────────────────────────────────────────────────
    if (this.inLatexBlock) {
      if (bl.type === 'latex_block_delim') {
        process.stdout.write(renderLatexBlock(this.latexLines.join('\n')) + '\n');
        this.latexLines = [];
        this.inLatexBlock = false;
      } else {
        this.latexLines.push(line);
      }
      return;
    }

    if (bl.type === 'latex_block_delim') {
      this.flushTable();
      this.inLatexBlock = true;
      this.latexLines = [];
      return;
    }

    // ── Code block ───────────────────────────────────────────────────────────
    if (this.inCodeBlock) {
      if (bl.type === 'fence_end') {
        process.stdout.write(codeBlockClose() + '\n');
        this.inCodeBlock = false;
      } else {
        process.stdout.write(codeBlockLine(line) + '\n');
      }
      return;
    }

    if (bl.type === 'fence') {
      this.flushTable();
      process.stdout.write('\n' + codeBlockOpen(bl.lang) + '\n');
      this.inCodeBlock = true;
      return;
    }

    // ── Table accumulation ───────────────────────────────────────────────────
    if (bl.type === 'table_row') {
      this.tableLines.push(line);
      return;
    }

    if (this.tableLines.length > 0) {
      if (isTableSeparator(line)) {
        this.tableLines.push(line);
        return;
      }
      this.flushTable();
    }

    // ── Everything else ──────────────────────────────────────────────────────
    process.stdout.write(renderBlockLine(bl) + '\n');
  }
}
