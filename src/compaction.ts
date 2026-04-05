/**
 * Compaction — Summarize older messages to reclaim context window
 *
 * Sends older messages to the model for summarization, stores the summary,
 * marks originals as dormant (via dormantBefore index). Dormant messages
 * stay in persistent history but are excluded from API calls.
 *
 * Summaries are injected into the system prompt so the model retains
 * long-term context while freeing token budget.
 */

import type { ApiMessage, MessageContent, TextContent, ToolUseContent, ToolResultContent, Provider, ChatConfig } from './types.js';
import type { ChannelData } from './channel.js';

export interface CompactionCluster {
  topic: string;
  summary: string;
  timestamp: number;
}

// Token estimation: ~4 chars per token (rough heuristic for mixed content)
export const CHARS_PER_TOKEN = 4;

const COMPACTION_SYSTEM_PROMPT = `You are a conversation compactor. Produce a dense, accurate summary of the conversation history provided.

Preserve:
- Key decisions and their rationale
- Technical findings (file paths, code patterns, architecture decisions)
- Current state of work (what's done, what's pending, what's blocked)
- Tool call outcomes that established important context
- Unresolved questions or open threads

Omit:
- Conversational filler and pleasantries
- Failed attempts superseded by later work
- Redundant re-statements
- Raw tool output (summarize findings instead)

Format: Dense prose organized by topic. Bullet points for lists of files or decisions. No headers. Maximum information density.`;

export interface CompactionResult {
  summary: string;
  compactedCount: number;
  preservedCount: number;
  estimatedTokensSaved: number;
}

/**
 * Merge new clusters into existing clusters by topic.
 * Same topic -> append summary text. New topic -> add as new entry.
 */
export function mergeClusters(
  existing: CompactionCluster[],
  incoming: CompactionCluster[],
): CompactionCluster[] {
  const byTopic = new Map<string, CompactionCluster>();
  for (const c of existing) {
    byTopic.set(c.topic, { ...c });
  }
  for (const c of incoming) {
    const prev = byTopic.get(c.topic);
    if (prev) {
      prev.summary = prev.summary + '\n\n' + c.summary;
      prev.timestamp = Math.max(prev.timestamp, c.timestamp);
    } else {
      byTopic.set(c.topic, { ...c });
    }
  }
  return Array.from(byTopic.values());
}

/**
 * Estimate total character count for a set of messages.
 */
export function estimateMessageChars(messages: ApiMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if ('text' in block && typeof (block as any).text === 'string') {
        total += (block as any).text.length;
      } else if ('content' in block && typeof (block as any).content === 'string') {
        total += (block as any).content.length;
      }
    }
  }
  return total;
}

/**
 * Count backward from end of messages to find the index that preserves
 * at least `keepTurns` complete user turns. A turn = user text message
 * + all subsequent assistant/tool messages until the next user text.
 *
 * Returns the number of messages to keep (from the end).
 */
export function countMessagesToKeep(messages: ApiMessage[], keepTurns: number): number {
  let turnsFound = 0;
  let keepCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // A turn starts at a user message with text content (not just tool_result)
    if (msg.role === 'user' && msg.content.some(b => b.type === 'text')) {
      turnsFound++;
      if (turnsFound > keepTurns) break;
    }
    keepCount++;
  }

  return keepCount;
}

/**
 * Consolidate compaction clusters when they exceed count or size limits.
 *
 * Triggers on EITHER:
 * - Cluster count > threshold (too many topics)
 * - Any individual cluster summary > MAX_CLUSTER_SUMMARY_CHARS (bloated topic)
 */
const DEFAULT_CONSOLIDATE_THRESHOLD = 10;
/** Per-cluster summary size cap. Bloated clusters trigger consolidation even below count threshold. */
const MAX_CLUSTER_SUMMARY_CHARS = 8000;

export async function consolidateClusters(
  channel: ChannelData,
  provider: Provider,
  model: string,
  threshold: number = DEFAULT_CONSOLIDATE_THRESHOLD,
): Promise<void> {
  const clusters = channel.compactionClusters || [];
  const overCount = clusters.length > threshold;
  const needsPhase1 = clusters.filter(c =>
    c.summary.length > MAX_CLUSTER_SUMMARY_CHARS || c.summary.includes('\n\n'),
  );
  if (!overCount && needsPhase1.length === 0) return;

  // Phase 1: Re-summarize bloated clusters and clusters with merge markers
  if (needsPhase1.length > 0) {
    const config: ChatConfig = {
      systemPrompt: 'You are a text consolidator. For each topic, merge the accumulated summary text into a single dense summary. Return ONLY a JSON array of {topic, summary} objects — no markdown fences.',
      maxTokens: 4096,
      temperature: 0.3,
    };

    const toConsolidate = needsPhase1.map(c => ({ topic: c.topic, summary: c.summary }));
    const response = await provider.chat(
      [{
        role: 'user',
        content: [{ type: 'text', text: `Consolidate these topic summaries:\n${JSON.stringify(toConsolidate, null, 2)}` } as TextContent],
      }],
      model,
      [],
      config,
    );

    const responseText = response.content
      .filter((b): b is TextContent => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const now = Date.now();
    let consolidated: CompactionCluster[];
    try {
      const stripped = responseText.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
      const parsed = JSON.parse(stripped);
      consolidated = (Array.isArray(parsed) ? parsed : [])
        .filter((c: any) => c.topic && c.summary)
        .map((c: any) => ({
          topic: String(c.topic).toLowerCase().replace(/\s+/g, '-'),
          summary: String(c.summary),
          timestamp: now,
        }));
    } catch {
      consolidated = [{ topic: 'general', summary: responseText.trim(), timestamp: now }];
    }
    const kept = clusters.filter(c => !needsPhase1.some(t => t.topic === c.topic));
    channel.compactionClusters = [...kept, ...consolidated];
  }

  // Phase 2: Cross-topic merge if still over threshold
  if ((channel.compactionClusters || []).length <= threshold) return;

  const config: ChatConfig = {
    systemPrompt: `You are a conversation compactor. You have too many topic clusters (${channel.compactionClusters!.length}, limit: ${threshold}). Merge related topics into fewer clusters. Return ONLY a JSON array of {topic, summary} objects — no markdown fences. Combine related topics under a broader name (e.g., "auth-login" + "auth-middleware" → "auth-system"). Target: ${threshold} clusters or fewer.`,
    maxTokens: 4096,
    temperature: 0.3,
  };

  const allClusters = (channel.compactionClusters || []).map(c => ({ topic: c.topic, summary: c.summary }));
  const response = await provider.chat(
    [{
      role: 'user',
      content: [{ type: 'text', text: `Merge these ${allClusters.length} clusters down to ${threshold} or fewer:\n${JSON.stringify(allClusters, null, 2)}` } as TextContent],
    }],
    model,
    [],
    config,
  );

  const responseText = response.content
    .filter((b): b is TextContent => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  const now2 = Date.now();
  let merged: CompactionCluster[];
  try {
    const stripped = responseText.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(stripped);
    merged = (Array.isArray(parsed) ? parsed : [])
      .filter((c: any) => c.topic && c.summary)
      .map((c: any) => ({
        topic: String(c.topic).toLowerCase().replace(/\s+/g, '-'),
        summary: String(c.summary),
        timestamp: now2,
      }));
  } catch {
    merged = [];
  }
  if (merged.length > 0 && merged.length < (channel.compactionClusters || []).length) {
    channel.compactionClusters = merged;
  }
}

/**
 * Compact a channel by summarizing older messages.
 *
 * @param keepRecent — Number of recent active messages to preserve (default: 20)
 */
export async function compactChannel(
  channel: ChannelData,
  provider: Provider,
  model: string,
  keepRecent: number = 20,
): Promise<CompactionResult> {
  // Active messages = everything from dormantBefore onward
  const dormantBefore = channel.dormantBefore || 0;
  const activeMessages = channel.messages.slice(dormantBefore);

  if (activeMessages.length <= keepRecent) {
    throw new Error(`Only ${activeMessages.length} active messages — nothing to compact (need > ${keepRecent}).`);
  }

  const toCompact = activeMessages.slice(0, activeMessages.length - keepRecent);

  // Build text representation for summarization
  const historyText = toCompact.map(formatMessageForSummary).join('\n\n');
  const inputChars = historyText.length;

  // Ask the model to summarize
  const config: ChatConfig = {
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    maxTokens: 4096,
    temperature: 0.3,
  };

  const response = await provider.chat(
    [{
      role: 'user',
      content: [{
        type: 'text',
        text: `Summarize the following conversation history (${toCompact.length} messages):\n\n${historyText}`,
      } as TextContent],
    }],
    model,
    [], // no tools for summarization
    config,
  );

  const summary = response.content
    .filter((b): b is TextContent => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  if (!summary.trim()) {
    throw new Error('Compaction produced empty summary.');
  }

  // Move dormant boundary forward
  channel.dormantBefore = dormantBefore + toCompact.length;

  // Store summary
  if (!channel.compactionSummaries) channel.compactionSummaries = [];
  channel.compactionSummaries.push(summary);

  const estimatedTokensSaved = Math.max(0, Math.floor(inputChars / 4) - Math.floor(summary.length / 4));

  return {
    summary,
    compactedCount: toCompact.length,
    preservedCount: keepRecent,
    estimatedTokensSaved,
  };
}

export interface ExternalCompactionResult {
  summary: string;
  sourceChannelId: string;
  sourceChannelName: string;
  messageCount: number;
}

/**
 * Compact an external channel's messages into a summary for injection
 * into a different channel. Does NOT modify the source channel.
 */
export async function compactExternalChannel(
  sourceChannel: ChannelData,
  provider: Provider,
  model: string,
): Promise<ExternalCompactionResult> {
  const allMessages = sourceChannel.messages;
  if (allMessages.length === 0) {
    throw new Error(`Channel "${sourceChannel.name}" has no messages.`);
  }

  const historyText = allMessages.map(formatMessageForSummary).join('\n\n');

  const config: ChatConfig = {
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    maxTokens: 4096,
    temperature: 0.3,
  };

  const response = await provider.chat(
    [{
      role: 'user',
      content: [{
        type: 'text',
        text: `Summarize the following conversation history from channel "${sourceChannel.name}" (${allMessages.length} messages):\n\n${historyText}`,
      } as TextContent],
    }],
    model,
    [],
    config,
  );

  const summary = response.content
    .filter((b): b is TextContent => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  if (!summary.trim()) {
    throw new Error('Compaction of external channel produced empty summary.');
  }

  return {
    summary,
    sourceChannelId: sourceChannel.id,
    sourceChannelName: sourceChannel.name,
    messageCount: allMessages.length,
  };
}

/**
 * Get the active (non-dormant) messages from a channel.
 */
export function getActiveMessages(channel: ChannelData): ApiMessage[] {
  return channel.messages.slice(channel.dormantBefore || 0);
}

const MAX_SUMMARIES = 5;

/**
 * Build an effective system prompt with compaction summaries or clusters injected.
 * Prefers clusters (new format) when present. Falls back to legacy summaries array.
 * If summaries exceed MAX_SUMMARIES, they are consolidated inline to prevent
 * unbounded system prompt growth.
 */
export function buildEffectiveSystemPrompt(basePrompt: string, channel: ChannelData): string {
  // Prefer cluster-based format if available
  const clusters = channel.compactionClusters || [];
  if (clusters.length > 0) {
    const sorted = [...clusters].sort((a, b) => a.topic.localeCompare(b.topic));
    const clusterBlock = sorted
      .map(c => `--- ${c.topic} ---\n${c.summary}`)
      .join('\n\n');
    return `${basePrompt}\n\n## Previous Conversation Context (by topic)\n\n${clusterBlock}`;
  }

  // Legacy: flat summaries array
  const summaries = channel.compactionSummaries || [];
  if (summaries.length === 0) return basePrompt;

  // Consolidate older summaries if there are too many
  let effectiveSummaries = summaries;
  if (summaries.length > MAX_SUMMARIES) {
    // Merge all but the last MAX_SUMMARIES-1 into one block
    const cutoff = summaries.length - (MAX_SUMMARIES - 1);
    const older = summaries.slice(0, cutoff).join('\n\n');
    const consolidated = `[Consolidated from ${cutoff} earlier compactions]\n${older}`;
    effectiveSummaries = [consolidated, ...summaries.slice(cutoff)];
  }

  const summaryBlock = effectiveSummaries
    .map((s, i) => `--- Compaction ${i + 1} ---\n${s}`)
    .join('\n\n');

  return `${basePrompt}\n\n## Previous Conversation Context (Compacted)\n\n${summaryBlock}`;
}

/**
 * Get compaction statistics for display.
 */
export function getCompactionStats(channel: ChannelData): {
  activeMessages: number;
  dormantMessages: number;
  compactionCount: number;
  topicCount: number;
  estimatedActiveTokens: number;
} {
  const dormantBefore = channel.dormantBefore || 0;
  const active = channel.messages.slice(dormantBefore);
  const dormant = channel.messages.slice(0, dormantBefore);

  let totalChars = 0;
  for (const msg of active) {
    for (const block of msg.content) {
      if ('text' in block && typeof (block as any).text === 'string') {
        totalChars += (block as any).text.length;
      } else if ('content' in block && typeof (block as any).content === 'string') {
        totalChars += (block as any).content.length;
      }
    }
  }

  return {
    activeMessages: active.length,
    dormantMessages: dormant.length,
    compactionCount: (channel.compactionSummaries || []).length,
    topicCount: (channel.compactionClusters || []).length,
    estimatedActiveTokens: Math.floor(totalChars / CHARS_PER_TOKEN),
  };
}

// --- Message Formatting ---

function formatMessageForSummary(msg: ApiMessage): string {
  const role = msg.role.toUpperCase();
  const parts: string[] = [];

  for (const block of msg.content) {
    switch (block.type) {
      case 'text': {
        const text = (block as TextContent).text;
        if (text.trim()) parts.push(text.trim());
        break;
      }
      case 'tool_use': {
        const tu = block as ToolUseContent;
        const inp = tu.input as Record<string, unknown>;
        let inputPreview: string;
        // Tool-aware formatting — surface the most meaningful fields for summarization
        switch (tu.name) {
          case 'read_file':
            inputPreview = `file_path: "${inp.file_path}"`;
            break;
          case 'code_search':
            inputPreview = `"${inp.patterns}" in ${inp.paths || '.'}`;
            break;
          case 'propose_edit':
            inputPreview = `file: "${inp.file_path}" | ${String(inp.rationale || '').substring(0, 120)}`;
            break;
          case 'propose_write':
            inputPreview = `file: "${inp.file_path}" | ${String(inp.rationale || '').substring(0, 120)}`;
            break;
          case 'propose_patch':
            inputPreview = `${String(inp.rationale || '').substring(0, 150)}`;
            break;
          case 'propose_exec':
            inputPreview = `$ ${String(inp.command || '').substring(0, 120)}`;
            break;
          case 'lisp_eval':
            inputPreview = String(inp.expression || '').substring(0, 120);
            break;
          case 'run_subagent':
            inputPreview = `type: ${inp.agent_type} | ${String(inp.prompt || '').split('\n')[0].substring(0, 100)}`;
            break;
          default:
            inputPreview = JSON.stringify(tu.input).substring(0, 200);
        }
        parts.push(`[Tool: ${tu.name}(${inputPreview})]`);
        break;
      }
      case 'tool_result': {
        const tr = block as ToolResultContent;
        const preview = typeof tr.content === 'string'
          ? tr.content.substring(0, 400)
          : JSON.stringify(tr.content).substring(0, 400);
        parts.push(`[Result: ${preview}]`);
        break;
      }
      default:
        break; // Skip thinking blocks
    }
  }

  return `[${role}]: ${parts.join('\n')}`;
}
