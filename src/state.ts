/**
 * Ephemeral State Injection
 *
 * Collects runtime state and prepends it to the last user message
 * before API submission. The model sees datetime, channel info,
 * tracked files, pending writes, context usage, and staging syntax reference.
 */

import type { ChannelData } from './channel.js';
import type { FileTracker } from './fileTracking.js';
import type { StagedWriteManager } from './tools/staged.js';
import type { ContextUsage } from './context.js';
import type { ToolDefinition } from './types.js';
import { getContextStats, formatContextState } from './context.js';
import { formatIdentityState } from './identity.js';

export interface StateContext {
  channel: ChannelData;
  fileTracker: FileTracker;
  staged: StagedWriteManager;
  contextUsage: ContextUsage;
  contextLimit: number;
  model: string;
  /** Current agent mode id */
  agentMode: string;
  /** Full tool definitions available to the model */
  tools: ToolDefinition[];
  /** coding-cli's own installation root (for self-introspection) */
  cliRoot: string;
  /** Whether fast-approve mode is active */
  fastApprove: boolean;
}

/**
 * Collect all ephemeral state as a single text block.
 * Used both for injection (onBeforeApiCall) and /state display.
 */
export function collectStateText(ctx: StateContext): string {
  const parts: string[] = [];

  // Datetime
  const now = new Date();
  parts.push([
    '---[ STATE: datetime ]---',
    `Local: ${now.toLocaleString()}`,
    `UTC: ${now.toISOString()}`,
  ].join('\n'));

  // Channel info
  const dormantBefore = ctx.channel.dormantBefore || 0;
  const activeCount = ctx.channel.messages.length - dormantBefore;
  parts.push([
    '---[ STATE: channel ]---',
    `Channel: ${ctx.channel.name} (${ctx.channel.id})`,
    `Model: ${ctx.model}`,
    `Mode: ${ctx.agentMode}`,
    `Messages: ${activeCount} active${dormantBefore > 0 ? `, ${dormantBefore} dormant` : ''} (${ctx.channel.messages.length} total)`,
  ].join('\n'));

  // Self-identity
  const identityState = formatIdentityState(ctx.channel.identity || {});
  if (identityState) parts.push(identityState);

  // Self-awareness — coding-cli's own source location
  parts.push([
    '---[ STATE: self (coding-cli) ]---',
    `Source root: ${ctx.cliRoot}`,
    'You can introspect and modify your own source using absolute paths to the source root.',
    'Use read_file, code_search, etc. with absolute paths to explore your own code.',
    'Use propose_edit / propose_write with absolute paths to modify yourself.',
    'Use validate_self to check your own TypeScript after changes.',
    'Operator runs /rebuild to recompile after approved changes.',
  ].join('\n'));

  // Tracked files
  const filesState = ctx.fileTracker.formatForState();
  if (filesState) parts.push(filesState);

  // Pending writes
  const pending = ctx.staged.list();
  if (pending.length > 0) {
    const lines = pending.map(w =>
      `  ${w.filepath} [${w.mode}] token: ${w.token}`
    );
    parts.push([
      `---[ STATE: pending_writes (${pending.length}) ]---`,
      ...lines,
      '',
      'Operator uses /approve <token> to apply, /reject <token> to discard.',
    ].join('\n'));
  }

  // Fast-approve mode
  if (ctx.fastApprove) {
    parts.push([
      '---[ STATE: fast_approve ]---',
      'Fast-approve mode is ACTIVE. Operator approves all staged items by pressing Enter (no /approve needed).',
      'Proceed as usual — stage writes and execs, they will be quickly approved.',
    ].join('\n'));
  }

  // Compaction info
  const summaryCount = (ctx.channel.compactionSummaries || []).length;
  if (summaryCount > 0) {
    parts.push([
      '---[ STATE: compaction ]---',
      `Summaries: ${summaryCount}`,
      `Active messages: ${activeCount}, Dormant: ${dormantBefore}`,
      'Compaction summaries are included in the system prompt automatically.',
    ].join('\n'));
  }

  // Context window
  const stats = getContextStats(ctx.contextUsage, ctx.contextLimit);
  if (stats.turnCount > 0) {
    parts.push(formatContextState(stats));
  }

  // Available tools — generated from registry definitions
  const toolLines = ctx.tools.map(t => {
    // First line of description only, for compactness
    const desc = t.description.split('\n')[0];
    return `  ${t.name.padEnd(30)} — ${desc}`;
  });
  parts.push([
    '---[ STATE: available_tools ]---',
    `Tools: ${ctx.tools.map(t => t.name).join(', ')}`,
    '',
    ...toolLines,
    '',
    'IMPORTANT: You must read_file before propose_edit — SEARCH content must match exactly.',
  ].join('\n'));

  return parts.join('\n\n');
}
