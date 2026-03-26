/**
 * Channel Sidebar — Toggleable overlay panel showing all channels
 *
 * Activated by Ctrl+B or /sidebar. Arrow keys navigate, Enter selects,
 * Escape/Ctrl+B dismisses. Uses shared rawSelect for key handling.
 */

import { listChannels, relativeTime, type ChannelSummary } from '../channel.js';
import { RESET, BOLD, DIM, FG, UI, BOX, padEnd } from './colors.js';
import { rawSelect } from './rawSelect.js';

/**
 * Show channel sidebar overlay. Returns selected channel ID, or null if cancelled.
 */
export async function showChannelSidebar(currentChannelId: string): Promise<string | null> {
  const channels = await listChannels();
  if (channels.length === 0) {
    process.stdout.write(`${DIM}No channels.${RESET}\n`);
    return null;
  }

  let selected = channels.findIndex(ch => ch.id === currentChannelId);
  if (selected < 0) selected = 0;

  // Compute panel dimensions
  const termRows = process.stdout.rows || 24;
  const maxVisible = Math.min(channels.length, termRows - 4);
  let scrollOffset = Math.max(0, selected - maxVisible + 1);

  function formatRow(ch: ChannelSummary, idx: number): string {
    const isCurrent = ch.id === currentChannelId;
    const isSelected = idx === selected;
    const pointer = isSelected ? `${FG.cyan}${BOX.arrow}${RESET}` : ' ';
    const name = isSelected ? `${BOLD}${ch.name}${RESET}` : ch.name;
    const msgs = `${ch.messageCount} msgs`;
    const time = relativeTime(ch.lastActivity);
    const marker = isCurrent ? ` ${FG.yellow}*${RESET}` : '';
    return `${pointer} ${name}${marker}  ${DIM}${msgs}  ${time}${RESET}`;
  }

  function panelWidth(): number {
    let maxW = 16;
    for (const ch of channels) {
      const plain = `  ${ch.name}    ${ch.messageCount} msgs  ${relativeTime(ch.lastActivity)}  `;
      if (plain.length > maxW) maxW = plain.length;
    }
    return Math.min(maxW + 4, (process.stdout.columns || 80) - 4);
  }

  function totalLines(): number {
    return Math.min(maxVisible, channels.length) + 2; // rows + top/bottom borders
  }

  function drawPanel(): void {
    const width = panelWidth();
    const title = ' channels ';
    const topPad = Math.max(0, width - 2 - title.length);
    const topLeft = Math.floor(topPad / 2);
    const topRight = topPad - topLeft;

    process.stdout.write(
      `${UI.border}${BOX.tl}${BOX.h.repeat(topLeft)}${RESET}${BOLD}${title}${RESET}${UI.border}${BOX.h.repeat(topRight)}${BOX.tr}${RESET}\n`
    );

    const visEnd = Math.min(scrollOffset + maxVisible, channels.length);
    for (let i = scrollOffset; i < visEnd; i++) {
      const row = formatRow(channels[i], i);
      const rowPadded = padEnd(row, width - 2);
      process.stdout.write(`${UI.border}${BOX.v}${RESET}${rowPadded}${UI.border}${BOX.v}${RESET}\n`);
    }

    process.stdout.write(
      `${UI.border}${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}${RESET}\n`
    );
  }

  function clearPanel(): void {
    const lines = totalLines();
    process.stdout.write(`\x1b[${lines}A`);
    for (let i = 0; i < lines; i++) process.stdout.write(`\x1b[2K\n`);
    process.stdout.write(`\x1b[${lines}A`);
  }

  function redraw(): void {
    clearPanel();
    drawPanel();
  }

  function ensureVisible(): void {
    if (selected < scrollOffset) scrollOffset = selected;
    if (selected >= scrollOffset + maxVisible) scrollOffset = selected - maxVisible + 1;
  }

  // Initial draw
  const lines = totalLines();
  for (let i = 0; i < lines; i++) process.stdout.write('\n');
  process.stdout.write(`\x1b[${lines}A`);
  drawPanel();

  return rawSelect({
    onUp: () => {
      selected = (selected - 1 + channels.length) % channels.length;
      ensureVisible();
      redraw();
    },
    onDown: () => {
      selected = (selected + 1) % channels.length;
      ensureVisible();
      redraw();
    },
    onSelect: () => {
      clearPanel();
      return channels[selected].id;
    },
    onCancel: () => {
      clearPanel();
      return null;
    },
    onNumber: (n) => {
      if (n <= channels.length) {
        clearPanel();
        return channels[n - 1].id;
      }
      return undefined;
    },
    extraCancelKeys: ['\x02'], // Ctrl+B
  });
}
