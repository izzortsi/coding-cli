/**
 * Safety Net Trim — Last-resort tool result trimming
 *
 * Only fires when context utilization exceeds a critical threshold (95%).
 * Under normal conditions, the model manages its own tool results via
 * dismiss_result/dismiss_results and self_compact.
 *
 * This exists solely to prevent API failures from context overflow.
 * It trims the largest non-recent results first, maximizing value preservation.
 */

import type { ApiMessage, ToolUseContent, ToolResultContent } from './types.js';
import { isDismissed, findToolUse } from './tools/dismissTool.js';
import { RE_READABLE_TOOLS } from './tools/builtins.js';
import { CHARS_PER_TOKEN } from './compaction.js';

/** Context utilization threshold to trigger safety trim. */
const SAFETY_UTILIZATION = 0.95;

/** Number of most-recent tool results to never touch. */
const PROTECT_RECENT = 5;

/** For non-re-readable tools, keep this many chars as a preview. */
const TRUNCATE_PREVIEW_CHARS = 500;

/** Minimum content length worth trimming (chars). */
const MIN_TRIM_SIZE = 2000;

export interface SafetyTrimOptions {
  /** Current context utilization (0–1). */
  utilization: number;
  /** Override utilization threshold. Default: 0.95. */
  threshold?: number;
  /** Override number of recent results to protect. Default: 5. */
  protectRecent?: number;
  /** Override minimum content length worth trimming (chars). Default: 2000. */
  minTrimSize?: number;
  /** Cluster summaries for coverage detection. If provided, covered results are trimmed first. */
  clusterSummaries?: string[];
}

interface ToolResultRef {
  toolUseId: string;
  content: string;
  charSize: number;
  ref: ToolResultContent;
}

/**
 * Check if a tool result's key identifier appears in any cluster summary.
 * A "covered" result has its information already captured in compaction clusters.
 */
function isCoveredByCluster(
  toolUse: ToolUseContent | null,
  clusterSummaries: string[],
): boolean {
  if (!toolUse || clusterSummaries.length === 0) return false;

  let identifier: string | null = null;
  switch (toolUse.name) {
    case 'read_file':
      identifier = (toolUse.input.file_path as string) || null;
      break;
    case 'list_directory':
    case 'directory_tree':
    case 'find_files':
      identifier = (toolUse.input.path as string) || null;
      break;
    case 'code_search': {
      const patterns = toolUse.input.patterns;
      if (Array.isArray(patterns) && patterns.length > 0) {
        identifier = String(patterns[0]);
      } else if (typeof patterns === 'string') {
        identifier = patterns;
      }
      break;
    }
    case 'lisp_eval':
      identifier = ((toolUse.input.expression as string) || '').slice(0, 60) || null;
      break;
    default:
      return false;
  }

  if (!identifier) return false;

  for (const summary of clusterSummaries) {
    if (summary.includes(identifier)) return true;
  }
  return false;
}

/**
 * Safety-net trim: only fires when context utilization is critical.
 * Trims covered results first (info already in clusters), then largest uncovered.
 *
 * @returns Number of results trimmed and approximate tokens freed, or null if not triggered.
 */
export function safetyTrimResults(
  messages: ApiMessage[],
  getFileHash: (filePath: string) => string | null,
  options: SafetyTrimOptions,
): { trimmed: number; tokensFreed: number } | null {
  const threshold = options.threshold ?? SAFETY_UTILIZATION;
  const protectRecent = options.protectRecent ?? PROTECT_RECENT;
  const minTrimSize = options.minTrimSize ?? MIN_TRIM_SIZE;
  const clusterSummaries = options.clusterSummaries || [];

  // Don't fire unless context pressure is critical
  if (options.utilization < threshold) return null;

  // Collect all non-dismissed tool_result refs in order
  const allResults: ToolResultRef[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const tr = block as ToolResultContent;
      if (isDismissed(tr.content)) continue;
      if (tr.content.length < minTrimSize) continue;
      allResults.push({
        toolUseId: tr.tool_use_id,
        content: tr.content,
        charSize: tr.content.length,
        ref: tr,
      });
    }
  }

  // Protect the most recent N results
  const candidates = allResults.length > protectRecent
    ? allResults.slice(0, allResults.length - protectRecent)
    : [];

  if (candidates.length === 0) return null;

  // Two-tier sort: covered results first, then by size descending
  candidates.sort((a, b) => {
    const toolUseA = findToolUse(messages, a.toolUseId);
    const toolUseB = findToolUse(messages, b.toolUseId);
    const coveredA = isCoveredByCluster(toolUseA, clusterSummaries) ? 1 : 0;
    const coveredB = isCoveredByCluster(toolUseB, clusterSummaries) ? 1 : 0;
    // Covered first (higher value = trimmed first)
    if (coveredA !== coveredB) return coveredB - coveredA;
    // Then biggest first
    return b.charSize - a.charSize;
  });

  let trimmed = 0;
  let tokensFreed = 0;

  for (const candidate of candidates) {
    const toolUse = findToolUse(messages, candidate.toolUseId);
    const toolName = toolUse?.name ?? 'unknown';
    const originalLength = candidate.charSize;
    let stub: string;

    if (toolUse && RE_READABLE_TOOLS.has(toolName)) {
      if (toolName === 'lisp_eval') {
        const expr = ((toolUse.input.expression as string) || '').slice(0, 120);
        const exprPreview = expr.length < (toolUse.input.expression as string || '').length ? expr + '…' : expr;
        stub = `[Auto-trimmed: lisp_eval result. Re-evaluate if needed: ${exprPreview}]`;
      } else {
        let pathStr = 'unknown';
        if (toolName === 'read_file') {
          pathStr = (toolUse.input.file_path as string) || 'unknown';
        } else {
          pathStr = (toolUse.input.path as string) || 'unknown';
        }
        const lineCount = candidate.content.split('\n').length;
        const hash = getFileHash(pathStr);
        const hashStr = hash ? `, hash: ${hash}` : '';
        stub = `[Auto-trimmed: ${pathStr}, ${lineCount} lines${hashStr} — re-read with ${toolName} if needed.]`;
      }
    } else {
      const preview = candidate.content.slice(0, TRUNCATE_PREVIEW_CHARS);
      const trimmedChars = originalLength - TRUNCATE_PREVIEW_CHARS;
      stub = `${preview}\n\n[Auto-trimmed: ${trimmedChars} chars removed from ${toolName} result. Re-run tool if full data needed.]`;
    }

    (candidate.ref as any).content = stub;
    const freed = Math.max(0, Math.floor((originalLength - stub.length) / CHARS_PER_TOKEN));
    tokensFreed += freed;
    trimmed++;
  }

  return { trimmed, tokensFreed };
}
