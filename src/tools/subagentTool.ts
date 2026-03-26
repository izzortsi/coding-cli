/**
 * Subagent Tool — Model-invokable tool for spawning subagents
 *
 * The model calls `run_subagent` to delegate bounded investigation or
 * implementation tasks. The subagent runs autonomously with its own
 * conversation context and tool access, then returns its findings
 * as the tool result.
 *
 * Multiple run_subagent calls in the same response execute concurrently
 * (the engine dispatches all tool calls in a response via Promise.all
 * or sequentially — concurrent by default in the registry).
 *
 * Agent types:
 *   explore — Deep read-only investigation. 25 steps, 5 min.
 *   triage  — Fast identification of ownership/entry points. 12 steps, 2 min.
 *   impl    — Investigation + staged change proposals. 30 steps, 8 min.
 */

import type { ToolDef, Provider } from '../types.js';
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

export type SubagentToolProgress = (agentType: string, toolName: string) => void;

// --- Tool Builder ---

/**
 * Build the run_subagent tool.
 *
 * @param projectRoot — CWD for subagent tool operations
 * @param getProvider — Returns the current provider (called at execution time)
 * @param getPreset — Returns the current preset (called at execution time)
 * @param parentStaged — Parent StagedWriteManager; impl subagent writes are merged into it
 * @param onProgress — Called when the subagent executes a tool
 */
export function buildSubagentTool(
  projectRoot: string,
  getProvider: () => Provider,
  getPreset: () => ModelPreset,
  parentStaged: StagedWriteManager,
  onProgress?: SubagentToolProgress,
): ToolDef {
  return {
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

      const provider = getProvider();
      const preset = getPreset();

      // Build isolated tool registry
      const registry = new ToolRegistry();
      for (const tool of buildBuiltinTools(projectRoot)) registry.register(tool);

      // impl agents get staging tools; their writes are merged into parentStaged on completion
      const subStaged = config.allowStaging ? new StagedWriteManager(projectRoot) : null;
      if (subStaged) {
        for (const tool of subStaged.getTools()) registry.register(tool);
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
            onProgress?.(agentType, toolName);
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

        const elapsed = `${result.toolCalls.length} steps`;
        const inTok = result.usage.inputTokens;
        const outTok = result.usage.outputTokens;
        const header = `[subagent:${agentType} | completed | ${elapsed} | ${inTok} in / ${outTok} out]`;

        return `${header}${stagedNote}\n\n${result.finalText}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'timeout') {
          return `[subagent:${agentType} | timed out after ${config.timeoutMs / 1000}s]`;
        }
        return `[subagent:${agentType} | failed: ${msg}]`;
      }
    },
  };
}
