/**
 * ANSI Color System — Semantic color tokens for terminal output
 */

// Reset
export const RESET = '\x1b[0m';

// Text styles
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDERLINE = '\x1b[4m';
export const STRIKETHROUGH = '\x1b[9m';

// Foreground colors (bright variants for visibility)
export const FG = {
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
};

// Background colors
export const BG = {
  black: '\x1b[40m',
  red: '\x1b[41m',
  green: '\x1b[42m',
  yellow: '\x1b[43m',
  blue: '\x1b[44m',
  magenta: '\x1b[45m',
  cyan: '\x1b[46m',
  white: '\x1b[47m',
  gray: '\x1b[100m',
  brightBlack: '\x1b[100m',
};

// 256-color foreground
export function fg256(n: number): string { return `\x1b[38;5;${n}m`; }
export function bg256(n: number): string { return `\x1b[48;5;${n}m`; }

// RGB foreground/background
export function fgRgb(r: number, g: number, b: number): string { return `\x1b[38;2;${r};${g};${b}m`; }
export function bgRgb(r: number, g: number, b: number): string { return `\x1b[48;2;${r};${g};${b}m`; }

// --- Semantic Tokens ---

export const ROLE = {
  user: `${BOLD}${FG.brightGreen}`,
  assistant: `${BOLD}${FG.brightCyan}`,
  system: `${BOLD}${FG.brightYellow}`,
  tool: `${FG.gray}`,
  error: `${BOLD}${FG.brightRed}`,
  thinking: `${DIM}${FG.magenta}`,
};

export const UI = {
  border: FG.gray,
  borderActive: FG.cyan,
  dim: `${DIM}`,
  header: `${BOLD}${FG.brightWhite}`,
  label: `${FG.gray}`,
  value: `${FG.white}`,
  success: `${FG.brightGreen}`,
  warning: `${FG.brightYellow}`,
  danger: `${FG.brightRed}`,
  info: `${FG.brightBlue}`,
  accent: `${FG.brightCyan}`,
  muted: `${FG.gray}`,
};

// Box-drawing characters
export const BOX = {
  h: '─',
  v: '│',
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  t: '┬',
  b: '┴',
  l: '├',
  r: '┤',
  x: '┼',
  dot: '·',
  bullet: '●',
  circle: '○',
  arrow: '▸',
  check: '✓',
  cross: '✗',
  ellipsis: '…',
};

// Helper: strip ANSI codes for length calculation
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Helper: visible length (excluding ANSI codes)
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

// Helper: pad to visible width
export function padEnd(str: string, width: number): string {
  const visible = visibleLength(str);
  return visible >= width ? str : str + ' '.repeat(width - visible);
}
