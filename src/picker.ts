/**
 * Interactive Picker — Arrow-key selection in the terminal
 *
 * Renders a list of items, highlights the current selection,
 * navigates with up/down arrows, selects with Enter, cancels with Escape/q.
 */

import { rawSelect } from './ui/rawSelect.js';

export interface PickerItem {
  label: string;
  value: string;
  detail?: string;    // shown dimmed after label
  marker?: string;    // e.g. "current" — shown after detail
}

/**
 * Show an interactive picker and return the selected value, or null if cancelled.
 */
export function pick(items: PickerItem[], title?: string): Promise<string | null> {
  if (items.length === 0) return Promise.resolve(null);

  let selected = 0;

  function drawRow(i: number): string {
    const item = items[i];
    const cursor = i === selected ? '\x1b[36m> \x1b[0m' : '  ';
    const label = i === selected ? `\x1b[1m${item.label}\x1b[0m` : item.label;
    const detail = item.detail ? ` \x1b[2m${item.detail}\x1b[0m` : '';
    const marker = item.marker ? ` \x1b[33m${item.marker}\x1b[0m` : '';
    return `${cursor}${label}${detail}${marker}`;
  }

  function drawAll(): void {
    if (title) {
      process.stdout.write(`\x1b[2K${title}\n`);
    }
    for (let i = 0; i < items.length; i++) {
      process.stdout.write(`\x1b[2K${drawRow(i)}\n`);
    }
  }

  function render(): void {
    const lines = items.length + (title ? 1 : 0);
    process.stdout.write(`\x1b[${lines}A`);
    drawAll();
  }

  // Initial draw — reserve lines then draw
  if (title) process.stdout.write(`${title}\n`);
  for (let i = 0; i < items.length; i++) process.stdout.write('\n');
  process.stdout.write(`\x1b[${items.length}A`);
  for (let i = 0; i < items.length; i++) {
    process.stdout.write(`\x1b[2K${drawRow(i)}\n`);
  }

  return rawSelect({
    onUp: () => {
      selected = (selected - 1 + items.length) % items.length;
      render();
    },
    onDown: () => {
      selected = (selected + 1) % items.length;
      render();
    },
    onSelect: () => items[selected].value,
    onCancel: () => {
      process.stdout.write('\x1b[2KCancelled.\n');
      return null;
    },
    onNumber: (n) => n <= items.length ? items[n - 1].value : undefined,
  });
}
