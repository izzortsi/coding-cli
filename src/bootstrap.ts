/**
 * Bootstrap — Programmatic context initialization
 *
 * Executes a fixed sequence of tool calls and file reads to build the
 * model's foundational context. The model doesn't choose what to read —
 * bootstrap injects all critical knowledge automatically.
 *
 * Inspired by CardRunner's workflow bootstrap system. Each step is a
 * tool call that gets executed and its result injected as a tool_result
 * message. The model sees the full context as if it had explored itself.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApiMessage, TextContent, ToolUseContent, ToolResultContent } from './types.js';
import type { ToolRegistry } from './tools/registry.js';
import { randomUUID } from 'node:crypto';

export interface BootstrapStep {
  /** Tool to call */
  tool: string;
  /** Arguments for the tool */
  args: Record<string, unknown>;
  /** Human-readable description (shown during execution) */
  description: string;
}

export type BootstrapProgressCallback = (step: number, total: number, description: string) => void;

/**
 * Build the bootstrap step sequence for a project.
 * Auto-detects project type and key files.
 */
export async function buildBootstrapSteps(projectRoot: string): Promise<BootstrapStep[]> {
  const steps: BootstrapStep[] = [];

  // 1. Project root directory listing
  steps.push({
    tool: 'list_directory',
    args: { path: '.' },
    description: 'Project root structure',
  });

  // 2. Key config files (auto-detect which exist)
  const configFiles = [
    'package.json',
    'tsconfig.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'Makefile',
    '.env.example',
  ];

  for (const file of configFiles) {
    const filePath = path.join(projectRoot, file);
    try {
      await fs.access(filePath);
      steps.push({
        tool: 'read_file',
        args: { file_path: file },
        description: `Read ${file}`,
      });
    } catch {
      // File doesn't exist — skip
    }
  }

  // 3. Source directory tree
  const srcDirs = ['src', 'lib', 'app', 'backend', 'frontend'];
  for (const dir of srcDirs) {
    try {
      await fs.access(path.join(projectRoot, dir));
      steps.push({
        tool: 'find_files',
        args: { path: dir },
        description: `Scan ${dir}/ structure`,
      });
    } catch {
      // Dir doesn't exist — skip
    }
  }

  // 4. README
  const readmeFiles = ['README.md', 'README.txt', 'README'];
  for (const file of readmeFiles) {
    try {
      await fs.access(path.join(projectRoot, file));
      steps.push({
        tool: 'read_file',
        args: { file_path: file },
        description: `Read ${file}`,
      });
      break;
    } catch {
      // Not found — try next
    }
  }

  // 5. Onboarding docs (if they exist in this project)
  const onboardingDocs = [
    'docs/coding-cli/onboarding/00_MINDSET.md',
    'docs/coding-cli/onboarding/01_MECHANICS.md',
    'docs/coding-cli/onboarding/02_WORKFLOW.md',
    'docs/coding-cli/CORE_PRINCIPLES.md',
    'docs/coding-cli/onboarding/PROJECT_ESSENTIALS.md',
  ];

  for (const doc of onboardingDocs) {
    try {
      await fs.access(path.join(projectRoot, doc));
      steps.push({
        tool: 'read_file',
        args: { file_path: doc },
        description: `Read ${path.basename(doc)}`,
      });
    } catch {
      // Doc doesn't exist — skip
    }
  }

  return steps;
}

/**
 * Execute the bootstrap sequence, injecting results into engine messages.
 *
 * Creates a synthetic assistant message with tool_use blocks for each step,
 * then a user message with all tool_result blocks. This makes the model see
 * the results as if it had called the tools itself.
 *
 * Returns the messages to be appended to the engine.
 */
export async function executeBootstrap(
  steps: BootstrapStep[],
  registry: ToolRegistry,
  onProgress?: BootstrapProgressCallback,
): Promise<ApiMessage[]> {
  if (steps.length === 0) return [];

  const toolUseBlocks: ToolUseContent[] = [];
  const toolResultBlocks: ToolResultContent[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const toolUseId = `boot_${randomUUID().substring(0, 8)}`;

    onProgress?.(i + 1, steps.length, step.description);

    // Create tool_use block
    const toolUse: ToolUseContent = {
      type: 'tool_use',
      id: toolUseId,
      name: step.tool,
      input: step.args,
    };
    toolUseBlocks.push(toolUse);

    // Execute the tool
    const result = await registry.execute(toolUse);
    toolResultBlocks.push(result);
  }

  // Build the message pair:
  // Assistant message: "I'll explore the project" + all tool_use blocks
  // User message: all tool_result blocks
  const assistantMsg: ApiMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me explore this project to understand its structure and context.' } as TextContent,
      ...toolUseBlocks,
    ],
  };

  const userMsg: ApiMessage = {
    role: 'user',
    content: toolResultBlocks,
  };

  return [assistantMsg, userMsg];
}
