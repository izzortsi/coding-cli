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

/**
 * Get the active (non-dormant) messages from a channel.
 */
export function getActiveMessages(channel: ChannelData): ApiMessage[] {
  return channel.messages.slice(channel.dormantBefore || 0);
}

const MAX_SUMMARIES = 5;

/**
 * Build an effective system prompt with compaction summaries injected.
 * If summaries exceed MAX_SUMMARIES, they are consolidated inline to prevent
 * unbounded system prompt growth.
 */
export function buildEffectiveSystemPrompt(basePrompt: string, channel: ChannelData): string {
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
    estimatedActiveTokens: Math.floor(totalChars / 4),
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
        const inputPreview = JSON.stringify(tu.input).substring(0, 200);
        parts.push(`[Tool: ${tu.name}(${inputPreview})]`);
        break;
      }
      case 'tool_result': {
        const tr = block as ToolResultContent;
        const preview = typeof tr.content === 'string'
          ? tr.content.substring(0, 300)
          : JSON.stringify(tr.content).substring(0, 300);
        parts.push(`[Result: ${preview}]`);
        break;
      }
      default:
        break; // Skip thinking blocks
    }
  }

  return `[${role}]: ${parts.join('\n')}`;
}
