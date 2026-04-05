/**
 * Redundant Result Dedup — Always-on housekeeping for duplicate tool calls.
 *
 * When the model calls a dedup-safe tool (read_file, list_directory, code_search,
 * etc.) with identical arguments multiple times, earlier results are superseded
 * by later ones. This pass replaces the earlier results with compact stubs that
 * reference the newer tool_use_id, reclaiming tokens with zero information loss.
 *
 * Runs every turn regardless of context utilization. Distinct from autoTrim.ts
 * (which is a safety-net that fires only at critical utilization).
 *
 * Safety invariants:
 * - Only tools in DEDUP_SAFE_TOOLS are processed (identical args → identical
 *   information within a session). lisp_eval is excluded because it has side
 *   effects (e.g., (mem ...) returns different IDs each call).
 * - Only EXACT argument matches are deduped (canonical JSON of args).
 * - Only the most-recent call's result is preserved; all earlier ones are stubbed.
 * - Already-dismissed results are left untouched.
 */

import type { ApiMessage, ToolUseContent } from './types.js';
import { isDismissed, findToolResult, findToolUse } from './tools/dismissTool.js';
import { CHARS_PER_TOKEN } from './compaction.js';

/**
 * Tools whose identical-args output is safe to dedupe.
 *
 * Criterion: two identical calls during a session produce informationally
 * equivalent results. This is STRICTER than re-readability — lisp_eval is
 * re-readable but has side effects (e.g., `(mem ...)` returns different IDs
 * each call), so the earlier output is NOT superseded.
 *
 * Safe: pure filesystem reads (read_file, list_directory, etc.) and
 * code_search (identical query returns same matches within a session).
 */
const DEDUP_SAFE_TOOLS: Set<string> = new Set([
  'read_file',
  'list_directory',
  'directory_tree',
  'find_files',
  'code_search',
]);

/**
 * Deterministic JSON stringify with sorted object keys.
 * Ensures {a:1,b:2} and {b:2,a:1} produce the same fingerprint.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Build a fingerprint for a tool_use block: tool name + canonical args. */
function fingerprint(tu: ToolUseContent): string {
  return `${tu.name}:${stableStringify(tu.input)}`;
}

/** Build a stub for a superseded tool result. */
function buildDedupStub(
  toolUse: ToolUseContent,
  supersedingId: string,
  getFileHash: (filePath: string) => string | null,
): string {
  const toolName = toolUse.name;

  if (toolName === 'code_search') {
    const patterns = toolUse.input.patterns;
    const pattern = Array.isArray(patterns) ? String(patterns[0] || '') : String(patterns || '');
    const paths = (toolUse.input.paths as string) || '.';
    const preview = pattern.slice(0, 60);
    const patPreview = pattern.length > 60 ? preview + '…' : preview;
    return `[Superseded by ${supersedingId}: code_search("${patPreview}" in ${paths}) — identical query re-run later in conversation.]`;
  }

  let pathStr = 'unknown';
  if (toolName === 'read_file') {
    pathStr = (toolUse.input.file_path as string) || 'unknown';
  } else {
    pathStr = (toolUse.input.path as string) || 'unknown';
  }
  const hash = getFileHash(pathStr);
  const hashStr = hash ? `, hash: ${hash}` : '';
  return `[Superseded by ${supersedingId}: ${toolName}(${pathStr})${hashStr} — identical call re-run later in conversation.]`;
}

export interface DedupResult {
  /** Number of redundant results replaced with stubs. */
  deduped: number;
  /** Approximate tokens freed (content chars / CHARS_PER_TOKEN). */
  tokensFreed: number;
}

/**
 * Scan messages and dedupe redundant re-readable tool results.
 * Mutates tool_result.content in place. Returns counts for logging.
 */
export function dedupeRedundantResults(
  messages: ApiMessage[],
  getFileHash: (filePath: string) => string | null,
): DedupResult {
  // Collect tool_use_ids grouped by fingerprint, in chronological order
  const byFingerprint = new Map<string, string[]>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;
      const tu = block as ToolUseContent;
      if (!DEDUP_SAFE_TOOLS.has(tu.name)) continue;
      const fp = fingerprint(tu);
      const ids = byFingerprint.get(fp);
      if (ids) {
        ids.push(tu.id);
      } else {
        byFingerprint.set(fp, [tu.id]);
      }
    }
  }

  let deduped = 0;
  let tokensFreed = 0;

  for (const ids of byFingerprint.values()) {
    if (ids.length < 2) continue;
    const supersedingId = ids[ids.length - 1];
    // Dismiss all but the most-recent occurrence
    for (let i = 0; i < ids.length - 1; i++) {
      const earlierId = ids[i];
      const toolResult = findToolResult(messages, earlierId);
      if (!toolResult) continue;
      if (isDismissed(toolResult.content)) continue;
      // Skip if already stubbed by a previous dedup pass
      if (toolResult.content.startsWith('[Superseded by ')) continue;

      const toolUse = findToolUse(messages, earlierId);
      if (!toolUse) continue;

      const originalLength = toolResult.content.length;
      const stub = buildDedupStub(toolUse, supersedingId, getFileHash);
      if (stub.length >= originalLength) continue; // No savings — skip

      (toolResult as any).content = stub;
      deduped++;
      tokensFreed += Math.max(0, Math.floor((originalLength - stub.length) / CHARS_PER_TOKEN));
    }
  }

  return { deduped, tokensFreed };
}
