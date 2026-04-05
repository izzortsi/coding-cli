/**
 * Subagent Tool — Model-invokable tool for spawning subagents
 *
 * The model calls `run_subagent` to delegate bounded investigation or
 * implementation tasks. Subagents run non-blocking in the background —
 * the tool returns immediately with an acknowledgment and the results
 * are injected into the conversation when the subagent completes
 * (before the next API call).
 *
 * Multiple run_subagent calls in the same response execute truly
 * concurrently since they all fire-and-forget.
 *
 * Agent types:
 *   explore — Deep read-only investigation. 25 steps, 5 min.
 *   triage  — Fast identification of ownership/entry points. 12 steps, 2 min.
 *   impl    — Investigation + staged change proposals. 30 steps, 8 min.
 */

import type { ToolDef, Provider, TurnResult } from '../types.js';
import type { ModelPreset } from '../presets.js';
import { Engine } from '../engine.js';
import { ToolRegistry } from './registry.js';
import { buildBuiltinTools } from './builtins.js';
import { StagedWriteManager } from './staged.js';

// --- Agent Type Configs ---

interface AgentConfig {
  maxSteps: number;
  timeoutMs: number;
  systemPrompt: string;
  allowStaging: boolean;
}

const AGENT_CONFIGS: Record<string, AgentConfig> = {
  explore: {
    maxSteps: 25,
    timeoutMs: 5 * 60 * 1000,
    allowStaging: false,
    systemPrompt: `You are an exploration agent. Investigate the codebase area described in the task thoroughly.

Use read_file, code_search, list_directory, directory_tree, and find_files to understand the target area.

Report your findings clearly:
- What you found (files, patterns, dependencies)
- How components interact
- Any issues or notable patterns
- Concrete evidence (file paths, line numbers)

Be thorough. Read actual files — don't guess from names alone.
When done, provide a comprehensive summary of your findings.`,
  },

  triage: {
    maxSteps: 12,
    timeoutMs: 2 * 60 * 1000,
    allowStaging: false,
    systemPrompt: `You are a triage agent. Quickly identify ownership, entry points, and key files for the given topic.

Work fast — find the relevant files and report:
- Which files own this functionality
- Entry points and call chains
- Key types and interfaces involved

Don't deep-dive. Identify, map, and stop.`,
  },

  impl: {
    maxSteps: 30,
    timeoutMs: 8 * 60 * 1000,
    allowStaging: true,
    systemPrompt: `You are an implementation agent. Investigate and then propose file changes.

1. First, read and understand the relevant code.
2. Then propose changes using propose_write or propose_edit.

Keep changes minimal and focused. Read files before modifying them.
Your proposed changes will be collected and presented to the operator for approval.`,
  },
};

// --- Progress callback type ---

export interface SubagentToolEvent {
  kind: 'start' | 'tool_call' | 'done';
  id: string;
  agentType: string;
  /** Tool name (for 'tool_call'), task prompt (for 'start'), or summary (for 'done') */
  detail: string;
}

export type SubagentToolProgress = (event: SubagentToolEvent) => void;

// --- Background tracking ---

interface BackgroundSubagent {
  id: string;
  channelId: string;
  agentType: string;
  prompt: string;
  startedAt: number;
  promise: Promise<string>;
}

export interface CompletedSubagent {
  id: string;
  channelId: string;
  agentType: string;
  result: string;
  elapsedMs: number;
}

export interface SubagentToolKit {
  tool: ToolDef;
  /** Drain completed background subagents for a specific channel. Only returns results matching the channel ID. */
  drainCompleted(channelId: string): CompletedSubagent[];
  /** Number of currently running background subagents */
  runningCount(): number;
}

// --- Tool Builder ---

let subagentCounter = 0;

/**
 * Build the run_subagent tool kit (tool + background tracking).
 *
 * @param projectRoot — CWD for subagent tool operations
 * @param getProvider — Returns the current provider (called at execution time)
 * @param getPreset — Returns the current preset (called at execution time)
 * @param parentStaged — Parent StagedWriteManager; impl subagent writes are merged into it
 * @param onProgress — Called on subagent lifecycle events (start, tool_call, done)
 */
export function buildSubagentTool(
  projectRoot: string,
  getProvider: () => Provider,
  getPreset: () => ModelPreset,
  parentStaged: StagedWriteManager,
  getChannelId: () => string,
  onProgress?: SubagentToolProgress,
): SubagentToolKit {
  const running: Map<string, BackgroundSubagent> = new Map();
  const completed: CompletedSubagent[] = [];

  const tool: ToolDef = {
    name: 'run_subagent',
    description: `Spawn a specialized subagent for bounded investigation or implementation. The subagent runs autonomously with its own conversation and tools, then returns its findings.

Agent types:
- explore: Deep read-only investigation. Maps structure, traces dependencies, finds patterns. Up to 25 steps, 5 min.
- triage: Fast read-only lookup. Identifies ownership and entry points quickly. Up to 12 steps, 2 min.
- impl: Investigation + staged change proposals. Reads files then proposes edits. Up to 30 steps, 8 min.

Multiple run_subagent calls in the same response execute concurrently — use this for parallel investigation.`,
    input_schema: {
      type: 'object',
      properties: {
        agent_type: {
          type: 'string',
          description: 'Type of subagent: "explore", "triage", or "impl".',
        },
        prompt: {
          type: 'string',
          description: `Complete task description. Structure as:
GOAL: What you want learned or done (one sentence)
SCOPE: Specific directories/files to focus on
STOP CONDITION: How the agent knows it is done`,
        },
      },
      required: ['agent_type', 'prompt'],
    },

    async execute(args) {
      const agentType = args.agent_type as string;
      const prompt = args.prompt as string;

      const config = AGENT_CONFIGS[agentType];
      if (!config) {
        throw new Error(`Unknown agent type: "${agentType}". Available: explore, triage, impl`);
      }

      const id = `${agentType}-${++subagentCounter}`;
      const channelId = getChannelId();
      const startedAt = Date.now();

      // Notify start
      onProgress?.({ kind: 'start', id, agentType, detail: prompt });

      // Build the background task
      const bgPromise = (async (): Promise<string> => {
        const provider = getProvider();
        const preset = getPreset();

        // Build isolated tool registry
        const registry = new ToolRegistry();
        for (const t of buildBuiltinTools(projectRoot)) registry.register(t);

        // impl agents get staging tools
        const subStaged = config.allowStaging ? new StagedWriteManager(projectRoot) : null;
        if (subStaged) {
          for (const t of subStaged.getTools()) registry.register(t);
        }

        // Build engine
        const engine = new Engine(provider, registry, {
          systemPrompt: config.systemPrompt,
          maxTokens: preset.maxTokens,
          temperature: preset.temperature,
          thinkingBudget: preset.thinkingBudget,
          maxToolSteps: config.maxSteps,
          hooks: {
            onAfterToolResult: (toolName: string): void => {
              onProgress?.({ kind: 'tool_call', id, agentType, detail: toolName });
            },
          },
        });

        // Run with timeout
        const turnPromise = engine.turn(prompt, preset.modelId);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), config.timeoutMs),
        );

        try {
          const result = await Promise.race([turnPromise, timeoutPromise]);

          // Merge impl subagent staged writes into parent
          let stagedNote = '';
          if (subStaged) {
            const writes = subStaged.list();
            if (writes.length > 0) {
              for (const w of writes) {
                parentStaged.pendingWrites.set(w.token, w);
              }
              stagedNote = `\n[${writes.length} staged write(s) merged — use /files to review]`;
            }
          }

          const steps = `${result.toolCalls.length} steps`;
          const inTok = result.usage.inputTokens;
          const outTok = result.usage.outputTokens;
          const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
          const header = `[subagent:${agentType} | completed | ${steps} | ${elapsedSec}s | ${inTok} in / ${outTok} out]`;

          return `${header}${stagedNote}\n\n${result.finalText}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === 'timeout') {
            return `[subagent:${agentType} | timed out after ${config.timeoutMs / 1000}s]`;
          }
          return `[subagent:${agentType} | failed: ${msg}]`;
        }
      })();

      // Store background task
      running.set(id, { id, channelId, agentType, prompt, startedAt, promise: bgPromise });

      // When done, move to completed queue and notify UI
      bgPromise.then((resultText) => {
        running.delete(id);
        const elapsedMs = Date.now() - startedAt;
        completed.push({ id, channelId, agentType, result: resultText, elapsedMs });
        onProgress?.({ kind: 'done', id, agentType, detail: `${(elapsedMs / 1000).toFixed(1)}s` });
      });

      const taskPreview = prompt.split('\n')[0].substring(0, 80);
      return `[subagent:${agentType} dispatched (${id}) — running in background]\nTask: ${taskPreview}\nResults will be injected when complete.`;
    },
  };

  return {
    tool,

    drainCompleted(channelId: string): CompletedSubagent[] {
      if (completed.length === 0) return [];
      const matching: CompletedSubagent[] = [];
      const remaining: CompletedSubagent[] = [];
      for (const sub of completed) {
        if (sub.channelId === channelId) {
          matching.push(sub);
        } else {
          remaining.push(sub);
        }
      }
      completed.length = 0;
      completed.push(...remaining);
      return matching;
    },

    runningCount(): number {
      return running.size;
    },
  };
}
