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
  lifetimeCacheReadTokens: number;
  lifetimeCacheCreationTokens: number;
}

export interface ContextStats {
  contextLimit: number;
  estimatedUsed: number;
  utilization: number;
  estimatedRemaining: number;
  turnCount: number;
  avgContextSize: number;
  avgOutputPerTurn: number;
  growthPerTurn: number;
  estimatedTurnsRemaining: number;
  lifetimeInput: number;
  lifetimeOutput: number;
  lifetimeApiCalls: number;
  lifetimeCacheRead: number;
  lifetimeCacheCreation: number;
}

export function createContextUsage(): ContextUsage {
  return {
    turnHistory: [],
    lifetimeInputTokens: 0,
    lifetimeOutputTokens: 0,
    lifetimeApiCalls: 0,
    lifetimeCacheReadTokens: 0,
    lifetimeCacheCreationTokens: 0,
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
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
): void {
  ctx.lifetimeInputTokens += inputTokens;
  ctx.lifetimeOutputTokens += outputTokens;
  ctx.lifetimeApiCalls += 1;
  ctx.lifetimeCacheReadTokens = (ctx.lifetimeCacheReadTokens || 0) + (cacheReadTokens || 0);
  ctx.lifetimeCacheCreationTokens = (ctx.lifetimeCacheCreationTokens || 0) + (cacheCreationTokens || 0);

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

  const avgContextSize = recent.length > 0
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
    avgContextSize,
    avgOutputPerTurn,
    growthPerTurn,
    estimatedTurnsRemaining,
    lifetimeInput: ctx.lifetimeInputTokens,
    lifetimeOutput: ctx.lifetimeOutputTokens,
    lifetimeApiCalls: ctx.lifetimeApiCalls,
    lifetimeCacheRead: ctx.lifetimeCacheReadTokens || 0,
    lifetimeCacheCreation: ctx.lifetimeCacheCreationTokens || 0,
  };
}

// --- Formatting ---

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
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
    `Context: ${fmtTokens(stats.estimatedUsed)}/${fmtTokens(stats.contextLimit)} (${(stats.utilization * 100).toFixed(1)}%), ~${fmtTokens(stats.estimatedRemaining)} free`,
  ];

  // Combine turns + growth + turns-remaining into one line; drop noise when remaining > 100
  const turnsParts: string[] = [`Turns: ${stats.turnCount}`];
  if (stats.growthPerTurn > 0) {
    turnsParts.push(`growth ~${fmtTokens(stats.growthPerTurn)}/turn`);
    if (stats.estimatedTurnsRemaining !== Infinity && stats.estimatedTurnsRemaining <= 100) {
      turnsParts.push(`~${stats.estimatedTurnsRemaining} left`);
    }
  }
  lines.push(turnsParts.join(' | '));
  lines.push(`Lifetime: ${fmtTokens(stats.lifetimeInput)} in / ${fmtTokens(stats.lifetimeOutput)} out`);
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
    lines.push(`Turns: ${stats.turnCount} | Avg context: ${fmtTokens(stats.avgContextSize)}, out/turn: ${fmtTokens(stats.avgOutputPerTurn)}`);
    if (stats.growthPerTurn > 0) {
      const turnsStr = stats.estimatedTurnsRemaining === Infinity ? '∞' : `~${stats.estimatedTurnsRemaining}`;
      lines.push(`Growth: ~${fmtTokens(stats.growthPerTurn)}/turn | Est. turns remaining: ${turnsStr}`);
    }
    const lifetimeLine = `Lifetime: ${fmtTokens(stats.lifetimeInput)} in, ${fmtTokens(stats.lifetimeOutput)} out | ${stats.lifetimeApiCalls} API calls`;
    lines.push(lifetimeLine);
    if (stats.lifetimeCacheRead > 0 || stats.lifetimeCacheCreation > 0) {
      const hitRate = stats.lifetimeInput > 0
        ? ((stats.lifetimeCacheRead / stats.lifetimeInput) * 100).toFixed(0)
        : '0';
      lines.push(`Cache: ${fmtTokens(stats.lifetimeCacheRead)} read, ${fmtTokens(stats.lifetimeCacheCreation)} created (${hitRate}% hit rate)`);
    }
  }
  return lines;
}
