/**
 * Spinner — Animated terminal spinner with phase text
 *
 * Braille dot animation with configurable label.
 * Renders on a single line, clears itself when stopped.
 */

import { FG, DIM, RESET, UI } from './colors.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private label = '';
  private startTime = 0;

  start(label: string = 'thinking'): void {
    this.label = label;
    this.frame = 0;
    this.startTime = Date.now();
    this.render();
    this.timer = setInterval(() => this.render(), INTERVAL_MS);
  }

  update(label: string): void {
    this.label = label;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Clear the spinner line
    process.stdout.write('\r\x1b[2K');
  }

  /** Temporarily stop the spinner without losing label/startTime, then call resume(). */
  pause(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdout.write('\r\x1b[2K');
  }

  resume(): void {
    if (this.timer) return; // already running
    this.render();
    this.timer = setInterval(() => this.render(), INTERVAL_MS);
  }

  private render(): void {
    const spinner = `${FG.cyan}${FRAMES[this.frame % FRAMES.length]}${RESET}`;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
    const time = `${DIM}${elapsed}s${RESET}`;
    process.stdout.write(`\r\x1b[2K  ${spinner} ${UI.muted}${this.label}${RESET} ${time}`);
    this.frame++;
  }
}
