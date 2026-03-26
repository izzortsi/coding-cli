/**
 * Context Window Tracker
 *
 * Tracks per-turn token usage, estimates context utilization,
 * burn rate, turns remaining, and cache efficiency.
 */

export interface TurnRecord {
  inputTokens: number;
  outputTokens: number;
  lastCallInputTokens: number;
  timestamp: number;
}

export interface ContextUsage {
  turnHistory: TurnRecord[];
  lifetimeInputTokens: number;
  lifetimeOutputTokens: number;
  lifetimeApiCalls: number;
}

export interface ContextStats {
  contextLimit: number;
  estimatedUsed: number;
  utilization: number;
  estimatedRemaining: number;
  turnCount: number;
  avgInputPerTurn: number;
  avgOutputPerTurn: number;
  growthPerTurn: number;
  estimatedTurnsRemaining: number;
  lifetimeInput: number;
  lifetimeOutput: number;
  lifetimeApiCalls: number;
}

export function createContextUsage(): ContextUsage {
  return {
    turnHistory: [],
    lifetimeInputTokens: 0,
    lifetimeOutputTokens: 0,
    lifetimeApiCalls: 0,
  };
}

/**
 * Record a completed turn's usage.
 */
export function recordTurn(
  ctx: ContextUsage,
  inputTokens: number,
  outputTokens: number,
  lastCallInputTokens: number,
): void {
  ctx.lifetimeInputTokens += inputTokens;
  ctx.lifetimeOutputTokens += outputTokens;
  ctx.lifetimeApiCalls += 1;

  ctx.turnHistory.push({
    inputTokens,
    outputTokens,
    lastCallInputTokens,
    timestamp: Date.now(),
  });

  // Keep last 50 turns
  if (ctx.turnHistory.length > 50) {
    ctx.turnHistory = ctx.turnHistory.slice(-50);
  }
}

/**
 * Compute context window statistics.
 */
export function getContextStats(ctx: ContextUsage, contextLimit: number): ContextStats {
  const turnCount = ctx.turnHistory.length;

  // Last API call's input tokens = best estimate of current context size
  const lastTurn = turnCount > 0 ? ctx.turnHistory[turnCount - 1] : null;
  const estimatedUsed = lastTurn ? (lastTurn.lastCallInputTokens || lastTurn.inputTokens || 0) : 0;
  const utilization = contextLimit > 0 ? estimatedUsed / contextLimit : 0;
  const estimatedRemaining = Math.max(0, contextLimit - estimatedUsed);

  // Recent turns for burn rate (last 10)
  const recent = ctx.turnHistory.slice(-10);
  const getSize = (t: TurnRecord) => t.lastCallInputTokens || t.inputTokens || 0;

  const avgInputPerTurn = recent.length > 0
    ? recent.reduce((s, t) => s + getSize(t), 0) / recent.length : 0;
  const avgOutputPerTurn = recent.length > 0
    ? recent.reduce((s, t) => s + t.outputTokens, 0) / recent.length : 0;

  // Growth per turn: difference between consecutive context sizes
  let growthPerTurn = 0;
  if (recent.length >= 2) {
    const growths: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      growths.push(getSize(recent[i]) - getSize(recent[i - 1]));
    }
    growthPerTurn = growths.reduce((s, g) => s + g, 0) / growths.length;
  }

  const estimatedTurnsRemaining = growthPerTurn > 0
    ? Math.floor(estimatedRemaining / growthPerTurn)
    : turnCount > 0 ? Infinity : 0;

  return {
    contextLimit,
    estimatedUsed,
    utilization,
    estimatedRemaining,
    turnCount,
    avgInputPerTurn,
    avgOutputPerTurn,
    growthPerTurn,
    estimatedTurnsRemaining,
    lifetimeInput: ctx.lifetimeInputTokens,
    lifetimeOutput: ctx.lifetimeOutputTokens,
    lifetimeApiCalls: ctx.lifetimeApiCalls,
  };
}

// --- Formatting ---

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function utilBar(utilization: number, width: number = 20): string {
  const filled = Math.min(width, Math.max(0, Math.round(utilization * width)));
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const color = utilization > 0.9 ? '\x1b[91m' : utilization > 0.7 ? '\x1b[93m' : '\x1b[92m';
  return `${color}${bar}\x1b[0m`;
}

/**
 * Format context stats as a compact utilization line for the prompt area.
 */
export function formatContextBar(stats: ContextStats): string {
  const pct = (stats.utilization * 100).toFixed(0);
  const used = fmtTokens(stats.estimatedUsed);
  const limit = fmtTokens(stats.contextLimit);
  const bar = utilBar(stats.utilization);

  let turnsLeft = '';
  if (stats.growthPerTurn > 0 && stats.estimatedTurnsRemaining !== Infinity) {
    turnsLeft = ` · ~${stats.estimatedTurnsRemaining} turns left`;
  }

  return `${bar} ${pct}% · ${used}/${limit}${turnsLeft}`;
}

/**
 * Format context stats for state injection (what the model sees).
 */
export function formatContextState(stats: ContextStats): string {
  const lines = [
    '---[ STATE: context_window ]---',
    `Context: ${fmtTokens(stats.estimatedUsed)} / ${fmtTokens(stats.contextLimit)} (${(stats.utilization * 100).toFixed(1)}%)`,
    `Remaining: ~${fmtTokens(stats.estimatedRemaining)} tokens`,
    `Turns: ${stats.turnCount} | Avg input/turn: ${fmtTokens(stats.avgInputPerTurn)}`,
  ];

  if (stats.growthPerTurn > 0) {
    const turnsStr = stats.estimatedTurnsRemaining === Infinity ? '∞' : `~${stats.estimatedTurnsRemaining}`;
    lines.push(`Growth: ~${fmtTokens(stats.growthPerTurn)}/turn | Est. turns remaining: ${turnsStr}`);
  }

  lines.push(`Lifetime: ${fmtTokens(stats.lifetimeInput)} in, ${fmtTokens(stats.lifetimeOutput)} out`);
  return lines.join('\n');
}

/**
 * Format context stats for /info command.
 */
export function formatContextInfo(stats: ContextStats): string[] {
  const lines: string[] = [];
  const pct = (stats.utilization * 100).toFixed(1);
  const bar = utilBar(stats.utilization);
  lines.push(`Context: ${fmtTokens(stats.estimatedUsed)} / ${fmtTokens(stats.contextLimit)} (${pct}%) ${bar}`);

  if (stats.turnCount > 0) {
    lines.push(`Turns: ${stats.turnCount} | Avg: ${fmtTokens(stats.avgInputPerTurn)} in, ${fmtTokens(stats.avgOutputPerTurn)} out per turn`);
    if (stats.growthPerTurn > 0) {
      const turnsStr = stats.estimatedTurnsRemaining === Infinity ? '∞' : `~${stats.estimatedTurnsRemaining}`;
      lines.push(`Growth: ~${fmtTokens(stats.growthPerTurn)}/turn | Est. turns remaining: ${turnsStr}`);
    }
    lines.push(`Lifetime: ${fmtTokens(stats.lifetimeInput)} in, ${fmtTokens(stats.lifetimeOutput)} out | ${stats.lifetimeApiCalls} API calls`);
  }
  return lines;
}
