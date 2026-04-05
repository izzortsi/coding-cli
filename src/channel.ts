/**
 * Channel — Conversation persistence
 *
 * Each channel is a named conversation saved as JSON in ~/.coding-cli/channels/.
 * Stores messages, model preset, system prompt, and metadata.
 *
 * A lightweight index file (channels/index.json) maps channel IDs to summaries
 * for fast listing without reading every channel file.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ApiMessage } from './types.js';
import type { TrackedFile } from './fileTracking.js';
import type { ContextUsage } from './context.js';
import type { IdentityData } from './identity.js';
import type { CompactionCluster } from './compaction.js';

export interface TrimConfig {
  safetyThreshold: number;
  protectRecent: number;
  minTrimSize: number;
}

const DATA_DIR = process.env.CODING_CLI_DATA_DIR || path.join(os.homedir(), '.coding-cli');
const CHANNELS_DIR = path.join(DATA_DIR, 'channels');
const INDEX_PATH = path.join(CHANNELS_DIR, 'index.json');

export interface ChannelData {
  id: string;
  name: string;
  presetId: string;
  systemPrompt: string;
  messages: ApiMessage[];
  created: number;
  lastActivity: number;
  /** Summaries from prior compactions, injected into system prompt */
  compactionSummaries: string[];
  /** Topic-clustered compaction summaries (replaces flat compactionSummaries) */
  compactionClusters: CompactionCluster[];
  /** Index: messages before this index are dormant (excluded from API calls) */
  dormantBefore: number;
  /** Tracked files with content hashes */
  trackedFiles: Record<string, TrackedFile>;
  /** Context window usage tracking */
  contextUsage: ContextUsage;
  /** Agent self-identity data */
  identity: IdentityData;
  /** Custom test command override (e.g. "pytest -x", "npm run test:unit") */
  testCommand?: string;
  /** Serialized Lisp agent state (user-defined strategies and data) */
  lispState?: string;
  /** Agent-controllable autoTrim thresholds (absent = defaults) */
  trimConfig?: TrimConfig;
}

export interface ChannelSummary {
  id: string;
  name: string;
  presetId: string;
  messageCount: number;
  lastActivity: number;
}

// --- Index Management ---

type ChannelIndex = Record<string, ChannelSummary>;

async function readIndex(): Promise<ChannelIndex> {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf-8');
    return JSON.parse(raw) as ChannelIndex;
  } catch {
    return {};
  }
}

async function writeIndex(index: ChannelIndex): Promise<void> {
  await fs.mkdir(CHANNELS_DIR, { recursive: true });
  await fs.writeFile(INDEX_PATH, JSON.stringify(index), 'utf-8');
}

function channelToSummary(channel: ChannelData): ChannelSummary {
  return {
    id: channel.id,
    name: channel.name,
    presetId: channel.presetId,
    messageCount: channel.messages.length,
    lastActivity: channel.lastActivity,
  };
}

/**
 * Rebuild the index from channel files on disk.
 * Called automatically when the index is missing or corrupt.
 */
async function rebuildIndex(): Promise<ChannelIndex> {
  const index: ChannelIndex = {};
  try {
    await fs.mkdir(CHANNELS_DIR, { recursive: true });
    const files = await fs.readdir(CHANNELS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'index.json') continue;
      try {
        const raw = await fs.readFile(path.join(CHANNELS_DIR, file), 'utf-8');
        const data = JSON.parse(raw) as ChannelData;
        index[data.id] = channelToSummary(data);
      } catch {
        // skip corrupt files
      }
    }
  } catch {
    // channels dir doesn't exist yet
  }
  await writeIndex(index).catch(() => {});
  return index;
}

// --- CRUD ---

/**
 * Create a new empty channel.
 */
export function createChannel(name: string, presetId: string, systemPrompt: string): ChannelData {
  return {
    id: randomUUID().substring(0, 8),
    name,
    presetId,
    systemPrompt,
    messages: [],
    created: Date.now(),
    lastActivity: Date.now(),
    compactionSummaries: [],
    compactionClusters: [],
    dormantBefore: 0,
    trackedFiles: {},
    contextUsage: { turnHistory: [], lifetimeInputTokens: 0, lifetimeOutputTokens: 0, lifetimeApiCalls: 0 },
    identity: {},
  };
}

/**
 * Create a channel branched from an existing one (copies messages, summaries, system prompt).
 */
export function branchChannel(name: string, from: ChannelData, presetId: string): ChannelData {
  return {
    id: randomUUID().substring(0, 8),
    name,
    presetId,
    systemPrompt: from.systemPrompt,
    messages: [...from.messages],
    created: Date.now(),
    lastActivity: Date.now(),
    compactionSummaries: [...(from.compactionSummaries || [])],
    compactionClusters: [...(from.compactionClusters || [])],
    dormantBefore: from.dormantBefore || 0,
    trackedFiles: { ...(from.trackedFiles || {}) },
    contextUsage: from.contextUsage
      ? JSON.parse(JSON.stringify(from.contextUsage))
      : { turnHistory: [], lifetimeInputTokens: 0, lifetimeOutputTokens: 0, lifetimeApiCalls: 0 },
    identity: from.identity ? JSON.parse(JSON.stringify(from.identity)) : {},
    // Carry forward Lisp state so branched channels inherit evolved strategies
    lispState: from.lispState,
    testCommand: from.testCommand,
    trimConfig: from.trimConfig ? { ...from.trimConfig } : undefined,
  };
}

/**
 * Save a channel to disk and update the index.
 */
export async function saveChannel(channel: ChannelData): Promise<void> {
  await fs.mkdir(CHANNELS_DIR, { recursive: true });
  const filepath = path.join(CHANNELS_DIR, `${channel.id}.json`);
  await fs.writeFile(filepath, JSON.stringify(channel, null, 2), 'utf-8');

  // Update index
  const index = await readIndex();
  index[channel.id] = channelToSummary(channel);
  await writeIndex(index);
}

/**
 * Load a channel by ID.
 */
export async function loadChannel(id: string): Promise<ChannelData | null> {
  const filepath = path.join(CHANNELS_DIR, `${id}.json`);
  try {
    const raw = await fs.readFile(filepath, 'utf-8');
    const channel = JSON.parse(raw) as ChannelData;

    // Guard: repair corrupted dormantBefore (can happen if compaction ran
    // but syncChannelFromEngine overwrote channel.messages with active-only slice)
    if (channel.dormantBefore && channel.dormantBefore > channel.messages.length) {
      channel.dormantBefore = 0;
    }

    // Migrate legacy compactionSummaries -> compactionClusters
    if (!channel.compactionClusters) {
      channel.compactionClusters = [];
      if (channel.compactionSummaries && channel.compactionSummaries.length > 0) {
        for (let i = 0; i < channel.compactionSummaries.length; i++) {
          channel.compactionClusters.push({
            topic: `legacy-context-${i + 1}`,
            summary: channel.compactionSummaries[i],
            timestamp: channel.lastActivity || Date.now(),
          });
        }
        channel.compactionSummaries = [];
      }
    }

    return channel;
  } catch {
    return null;
  }
}

/**
 * Load a channel by name (first match).
 */
export async function loadChannelByName(name: string): Promise<ChannelData | null> {
  const summaries = await listChannels();
  const match = summaries.find(s => s.name === name);
  if (!match) return null;
  return loadChannel(match.id);
}

/**
 * List all channels, sorted by lastActivity descending (most recent first).
 * Uses the index file for fast listing. Rebuilds if index is empty or missing.
 */
export async function listChannels(): Promise<ChannelSummary[]> {
  let index = await readIndex();

  // If index is empty, try rebuilding from channel files
  if (Object.keys(index).length === 0) {
    index = await rebuildIndex();
  }

  const summaries = Object.values(index);
  summaries.sort((a, b) => b.lastActivity - a.lastActivity);
  return summaries;
}

/**
 * Format a relative time string (e.g. "2m ago", "3h ago", "1d ago").
 */
export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
