/**
 * Self-Compact Tool — Model-driven context compaction with semantic clusters
 *
 * The model calls self_compact with topic-organized summaries and controls
 * all compaction parameters (no hardcoded defaults). The model IS the best
 * summarizer — it knows what matters in the current conversation.
 */

import type { ToolDef, ApiMessage } from '../types.js';
import type { ChannelData } from '../channel.js';
import type { Provider } from '../types.js';
import { mergeClusters, consolidateClusters, countMessagesToKeep, estimateMessageChars, CHARS_PER_TOKEN } from '../compaction.js';
import type { CompactionCluster } from '../compaction.js';

export interface SelfCompactDeps {
  getChannel: () => ChannelData;
  getMessages: () => ApiMessage[];
  setMessages: (msgs: ApiMessage[]) => void;
  syncChannel: () => void;
  saveChannel: (ch: ChannelData) => Promise<void>;
  getProvider: () => Provider;
  getModel: () => string;
}

export function buildSelfCompactTool(deps: SelfCompactDeps): ToolDef {
  return {
    name: 'self_compact',
    description: `Compact your conversation history into semantic topic clusters to free context space. YOU provide the clusters — each with a topic name and summary. The system marks older messages as dormant and stores your clusters in the system prompt.

You control all parameters:
- clusters: Array of {topic, summary} — organize by semantic theme, not chronologically
- keep_recent_turns: How many recent user turns to preserve (consider: context pressure, active work complexity, whether recent turns have critical tool results)
- consolidate_threshold: Max distinct topics before auto-consolidation merges related ones (default: 10)
- trim_config: Override autoTrim safety-net thresholds (persists until changed)

Factors to consider when choosing parameters:
- Context utilization % (visible in state injection)
- How many distinct topics are actively being discussed
- Whether recent turns contain irreplaceable tool results
- Whether older topics are still relevant or fully resolved

Topic names should be short kebab-case (e.g., "auth-refactoring", "db-migration").
Each summary should be dense prose preserving key decisions, findings, file paths, and state.`,
    input_schema: {
      type: 'object',
      properties: {
        clusters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Short kebab-case topic identifier (e.g., "auth-refactoring", "file-search-tooling")',
              },
              summary: {
                type: 'string',
                description: 'Dense summary for this topic. Preserve key decisions, file paths, patterns, state.',
              },
            },
            required: ['topic', 'summary'],
          },
          description: 'Semantic topic clusters summarizing the conversation history being compacted.',
        },
        keep_recent_turns: {
          type: 'number',
          description: 'Number of recent user turns to preserve (not compacted). Choose based on context pressure and active work.',
        },
        consolidate_threshold: {
          type: 'number',
          description: 'Max distinct topic clusters before auto-consolidation. Default: 10.',
        },
        trim_config: {
          type: 'object',
          description: 'Override autoTrim thresholds. Partial — only specified fields are updated. Persists across turns.',
          properties: {
            safety_threshold: {
              type: 'number',
              description: 'Context utilization (0-1) at which autoTrim fires. Default: 0.95.',
            },
            protect_recent: {
              type: 'number',
              description: 'Number of most-recent tool results to never auto-trim. Default: 5.',
            },
            min_trim_size: {
              type: 'number',
              description: 'Minimum tool result size (chars) to consider for trimming. Default: 2000.',
            },
          },
        },
      },
      required: ['clusters', 'keep_recent_turns'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const rawClusters = args.clusters as Array<{ topic: string; summary: string }>;
      const keepTurns = args.keep_recent_turns as number;
      const consolidateThreshold = (args.consolidate_threshold as number) || 10;
      const rawTrimConfig = args.trim_config as { safety_threshold?: number; protect_recent?: number; min_trim_size?: number } | undefined;

      // Validate clusters
      if (!Array.isArray(rawClusters) || rawClusters.length === 0) {
        return 'Error: clusters must be a non-empty array of {topic, summary} objects.';
      }
      for (const c of rawClusters) {
        if (!c.topic || !c.summary) {
          return 'Error: Each cluster must have a non-empty "topic" and "summary".';
        }
        if (c.summary.trim().length < 50) {
          return `Error: Cluster "${c.topic}" summary is too short (${c.summary.trim().length} chars). Minimum 50 characters.`;
        }
      }

      if (!keepTurns || keepTurns < 1) {
        return 'Error: keep_recent_turns must be a positive number.';
      }

      const channel = deps.getChannel();
      deps.syncChannel();

      const dormantBefore = channel.dormantBefore || 0;
      const activeMessages = channel.messages.slice(dormantBefore);
      const keepCount = countMessagesToKeep(activeMessages, keepTurns);

      if (activeMessages.length <= keepCount) {
        return `Only ${activeMessages.length} active messages with ${keepCount} needed to preserve ${keepTurns} turns — nothing to compact.`;
      }

      const toCompact = activeMessages.slice(0, activeMessages.length - keepCount);
      const inputChars = estimateMessageChars(toCompact);

      // Move dormant boundary forward
      channel.dormantBefore = dormantBefore + toCompact.length;

      // Build CompactionCluster objects from agent-provided clusters
      const now = Date.now();
      const newClusters: CompactionCluster[] = rawClusters.map(c => ({
        topic: c.topic.toLowerCase().replace(/\s+/g, '-'),
        summary: c.summary.trim(),
        timestamp: now,
      }));

      // Merge into existing clusters
      if (!channel.compactionClusters) channel.compactionClusters = [];
      channel.compactionClusters = mergeClusters(channel.compactionClusters, newClusters);

      // Update engine messages to only hold active (non-dormant) messages
      const newActive = channel.messages.slice(channel.dormantBefore);
      deps.setMessages(newActive);

      // Save
      await deps.saveChannel(channel);

      // Merge trim_config into channel
      if (rawTrimConfig) {
        const existing = channel.trimConfig || { safetyThreshold: 0.95, protectRecent: 5, minTrimSize: 2000 };
        channel.trimConfig = {
          safetyThreshold: rawTrimConfig.safety_threshold ?? existing.safetyThreshold,
          protectRecent: rawTrimConfig.protect_recent ?? existing.protectRecent,
          minTrimSize: rawTrimConfig.min_trim_size ?? existing.minTrimSize,
        };
        await deps.saveChannel(channel);
      }

      // Consolidate if over threshold
      try {
        await consolidateClusters(channel, deps.getProvider(), deps.getModel(), consolidateThreshold);
        await deps.saveChannel(channel);
      } catch {
        // Non-fatal
      }

      const summaryChars = newClusters.reduce((s, c) => s + c.summary.length, 0);
      const estimatedTokensSaved = Math.max(0, Math.floor(inputChars / CHARS_PER_TOKEN) - Math.floor(summaryChars / CHARS_PER_TOKEN));

      const reportLines = [
        `Compacted ${toCompact.length} messages into ${newClusters.length} topic clusters, preserved ${keepCount} messages.`,
        `Topics: ${newClusters.map(c => c.topic).join(', ')}`,
        `Estimated tokens freed: ~${Math.round(estimatedTokensSaved / 1000)}K`,
        `Total topic clusters: ${(channel.compactionClusters || []).length}`,
      ];
      if (rawTrimConfig) {
        const tc = channel.trimConfig!;
        reportLines.push(`Trim config updated: threshold=${tc.safetyThreshold}, protect=${tc.protectRecent}, min=${tc.minTrimSize}`);
      }
      return reportLines.join('\n');
    },
  };
}
