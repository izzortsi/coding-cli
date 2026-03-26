/**
 * Subagent — Background autonomous conversations
 *
 * A subagent is a branched channel with its own engine that runs
 * a task autonomously in the background. It reuses the same provider,
 * tools, and project root as the parent. Its full conversation is
 * saved as a real channel you can /load and inspect.
 *
 * Progress events (tool calls) stream to the parent terminal in real-time.
 * When complete, the result is injected into the parent conversation.
 */

import { Engine, type EngineConfig } from './engine.js';
import { ToolRegistry } from './tools/registry.js';
import { buildBuiltinTools } from './tools/builtins.js';
import { StagedWriteManager } from './tools/staged.js';
import { branchChannel, saveChannel, type ChannelData } from './channel.js';
import { buildEffectiveSystemPrompt } from './compaction.js';
import type { Provider, ApiMessage, TurnResult, TextContent } from './types.js';
import type { ModelPreset } from './presets.js';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timed_out';

export interface SubagentProgress {
  agentName: string;
  event: 'tool_call' | 'done' | 'error' | 'killed' | 'timed_out';
  detail: string;
}

export type ProgressCallback = (progress: SubagentProgress) => void;

export interface SubagentHandle {
  name: string;
  channel: ChannelData;
  status: SubagentStatus;
  result: string | null;
  error: string | null;
  startedAt: number;
  timeoutMs: number;
  /** Promise that resolves when the agent finishes (never rejects) */
  promise: Promise<void>;
  /** Tool calls executed */
  toolCalls: Array<{ name: string; durationMs: number }>;
  /** Staged writes proposed by this agent — merge into parent on /join */
  staged: StagedWriteManager;
  /** Abort the agent */
  abort: () => void;
}

export class SubagentManager {
  private agents: Map<string, SubagentHandle> = new Map();
  private projectRoot: string;
  private onProgress: ProgressCallback;

  constructor(projectRoot: string, onProgress: ProgressCallback) {
    this.projectRoot = projectRoot;
    this.onProgress = onProgress;
  }

  /**
   * Spawn a subagent that runs a task autonomously in the background.
   * Returns immediately — use join() to wait for completion.
   *
   * @param timeoutMs  Max runtime in ms. Default 5 minutes. Pass 0 to disable.
   */
  spawn(
    name: string,
    task: string,
    parentChannel: ChannelData,
    provider: Provider,
    preset: ModelPreset,
    systemPrompt: string,
    timeoutMs = 5 * 60 * 1000,
  ): SubagentHandle {
    if (this.agents.has(name)) {
      throw new Error(`Subagent "${name}" already exists. Use /agents to see running agents.`);
    }

    // Branch channel from parent (carries context)
    const channel = branchChannel(`agent:${name}`, parentChannel, preset.id);

    // Isolated tool registry + staged write manager
    const registry = new ToolRegistry();
    for (const tool of buildBuiltinTools(this.projectRoot)) registry.register(tool);
    const staged = new StagedWriteManager(this.projectRoot);
    for (const tool of staged.getTools()) registry.register(tool);

    // Abort controller — used by both /kill and timeout
    const ac = new AbortController();

    const handle: SubagentHandle = {
      name,
      channel,
      status: 'running',
      result: null,
      error: null,
      startedAt: Date.now(),
      timeoutMs,
      promise: Promise.resolve(),
      toolCalls: [],
      staged,
      abort: () => ac.abort('killed'),
    };

    const engine = new Engine(provider, registry, {
      systemPrompt: buildEffectiveSystemPrompt(systemPrompt, channel),
      maxTokens: preset.maxTokens,
      temperature: preset.temperature,
      thinkingBudget: preset.thinkingBudget,
      maxToolSteps: 50,
      hooks: {
        onAfterToolResult: (toolName: string, _result: string): void => {
          this.onProgress({ agentName: name, event: 'tool_call', detail: toolName });
        },
      },
    });

    engine.messages = [...channel.messages];

    // Wire timeout into the abort controller so a single signal handles both kill and timeout
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => ac.abort('__timeout__'), timeoutMs);
    }

    handle.promise = (async () => {
      try {
        const result = await engine.turn(task, preset.modelId, ac.signal);

        if (timeoutTimer) clearTimeout(timeoutTimer);

        handle.toolCalls = result.toolCalls.map(tc => ({
          name: tc.name,
          durationMs: tc.durationMs,
        }));
        handle.result = result.finalText;
        handle.status = 'completed';

        channel.messages = [...engine.messages];
        channel.lastActivity = Date.now();
        await saveChannel(channel);

        this.onProgress({ agentName: name, event: 'done', detail: result.finalText.substring(0, 100) });
      } catch (err) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const reason = ac.signal.reason;

        if (reason === '__timeout__') {
          handle.status = 'timed_out';
          handle.error = `Timed out after ${timeoutMs / 1000}s`;
          this.onProgress({ agentName: name, event: 'timed_out', detail: handle.error });
        } else if (reason === 'killed') {
          handle.status = 'killed';
          handle.error = 'Killed by /kill';
          this.onProgress({ agentName: name, event: 'killed', detail: '' });
        } else {
          handle.status = 'failed';
          handle.error = err instanceof Error ? err.message : String(err);
          this.onProgress({ agentName: name, event: 'error', detail: handle.error });
        }

        // Save partial channel state
        channel.messages = [...engine.messages];
        channel.lastActivity = Date.now();
        await saveChannel(channel).catch(() => {});
      }
    })();

    this.agents.set(name, handle);
    return handle;
  }

  /**
   * Abort a running subagent immediately.
   */
  kill(name: string): boolean {
    const handle = this.agents.get(name);
    if (!handle || handle.status !== 'running') return false;
    handle.abort();
    return true;
  }

  /**
   * Wait for a subagent to complete and return its handle.
   */
  async join(name: string): Promise<SubagentHandle | null> {
    const handle = this.agents.get(name);
    if (!handle) return null;
    await handle.promise;
    return handle;
  }

  list(): SubagentHandle[] {
    return Array.from(this.agents.values());
  }

  get(name: string): SubagentHandle | undefined {
    return this.agents.get(name);
  }

  remove(name: string): boolean {
    const handle = this.agents.get(name);
    if (!handle || handle.status === 'running') return false;
    this.agents.delete(name);
    return true;
  }

  formatResult(handle: SubagentHandle): string {
    const toolSummary = handle.toolCalls.length > 0
      ? `\nTools used: ${handle.toolCalls.map(tc => tc.name).join(', ')}`
      : '';

    if (handle.status === 'completed') {
      return [
        `[Subagent "${handle.name}" completed]`,
        toolSummary,
        '',
        handle.result || '(no output)',
      ].join('\n');
    }

    return `[Subagent "${handle.name}" ${handle.status}: ${handle.error}]`;
  }
}
