/**
 * Dismiss Tool — Model-driven tool result dismissal
 *
 * Allows the model to replace stale tool results in message history
 * with compact stubs, freeing context window tokens.
 */

import type { ApiMessage, ToolDef, ToolUseContent, ToolResultContent } from '../types.js';
import { RE_READABLE_TOOLS } from './builtins.js';

const DISMISSED_PREFIX = '[Dismissed:';

/**
 * Build dismiss_result and dismiss_results tools.
 * Closes over getMessages so tools can walk and mutate engine.messages.
 */
export function buildDismissTools(
  getMessages: () => ApiMessage[],
  getFileHash: (filePath: string) => string | null,
): ToolDef[] {
  return [
    dismissResultTool(getMessages, getFileHash),
    dismissResultsTool(getMessages, getFileHash),
  ];
}

/** Check if a tool_result has already been dismissed. */
function isDismissed(content: string): boolean {
  return content.startsWith(DISMISSED_PREFIX);
}

/** Find the tool_use block matching a tool_use_id across all messages. */
function findToolUse(messages: ApiMessage[], toolUseId: string): ToolUseContent | null {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && (block as ToolUseContent).id === toolUseId) {
        return block as ToolUseContent;
      }
    }
  }
  return null;
}

/** Find the tool_result block matching a tool_use_id across all messages. */
function findToolResult(messages: ApiMessage[], toolUseId: string): ToolResultContent | null {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result' && (block as ToolResultContent).tool_use_id === toolUseId) {
        return block as ToolResultContent;
      }
    }
  }
  return null;
}

/** Extract metadata and build stub for a re-readable tool result. */
function buildReReadableStub(
  toolUse: ToolUseContent,
  originalContent: string,
  getFileHash: (filePath: string) => string | null,
  reason?: string,
): string {
  const toolName = toolUse.name;
  let pathStr = '';
  if (toolName === 'read_file') {
    pathStr = (toolUse.input.file_path as string) || 'unknown';
  } else {
    pathStr = (toolUse.input.path as string) || 'unknown';
  }

  const lineCount = originalContent.split('\n').length;
  const hash = getFileHash(pathStr);
  const hashStr = hash ? `, hash: ${hash}` : '';
  const reasonSuffix = reason ? ` Reason: ${reason}` : '';
  return `[Dismissed: ${pathStr}, ${lineCount} lines${hashStr} — re-read with ${toolName} if needed.${reasonSuffix}]`;
}

/** Build stub for a non-re-readable tool result. */
function buildNonReReadableStub(toolName: string, summary: string, reason?: string): string {
  const reasonSuffix = reason ? ` Reason: ${reason}` : '';
  return `[Dismissed: ${toolName} — Summary: ${summary}.${reasonSuffix}]`;
}

/** Estimate tokens freed by replacement (approximate, ~4 chars per token). */
function estimateTokensFreed(originalLength: number, stubLength: number): number {
  return Math.max(0, Math.floor((originalLength - stubLength) / 4));
}

interface DismissOneResult {
  status: 'dismissed' | 'not_found' | 'already_dismissed' | 'summary_required';
  tokensFreed: number;
  message: string;
}

/** Dismiss a single tool result by ID. */
function dismissOne(
  messages: ApiMessage[],
  toolUseId: string,
  getFileHash: (filePath: string) => string | null,
  reason?: string,
  summary?: string,
): DismissOneResult {
  const toolResult = findToolResult(messages, toolUseId);
  if (!toolResult) {
    return { status: 'not_found', tokensFreed: 0, message: `Not found: ${toolUseId}` };
  }

  if (isDismissed(toolResult.content)) {
    return { status: 'already_dismissed', tokensFreed: 0, message: `Already dismissed: ${toolUseId}` };
  }

  const toolUse = findToolUse(messages, toolUseId);
  if (!toolUse) {
    return { status: 'not_found', tokensFreed: 0, message: `Tool use not found for: ${toolUseId}` };
  }

  const isReReadable = RE_READABLE_TOOLS.has(toolUse.name);

  if (!isReReadable && !summary) {
    return {
      status: 'summary_required',
      tokensFreed: 0,
      message: `Summary required for ${toolUse.name} results — provide a summary param capturing key findings.`,
    };
  }

  const originalLength = toolResult.content.length;
  let stub: string;

  if (isReReadable) {
    stub = buildReReadableStub(toolUse, toolResult.content, getFileHash, reason);
  } else {
    stub = buildNonReReadableStub(toolUse.name, summary!, reason);
  }

  // Mutate in place
  (toolResult as any).content = stub;

  const tokensFreed = estimateTokensFreed(originalLength, stub.length);
  return { status: 'dismissed', tokensFreed, message: '' };
}

// --- Tool Definitions ---

function dismissResultTool(getMessages: () => ApiMessage[], getFileHash: (filePath: string) => string | null): ToolDef {
  return {
    name: 'dismiss_result',
    description: 'Dismiss a tool result from conversation history to free context tokens. For re-readable tools (read_file, list_directory, etc.), a reason is enough. For non-re-readable tools (code_search, etc.), provide a summary of key findings.',
    input_schema: {
      type: 'object',
      properties: {
        tool_use_id: { type: 'string', description: 'ID of the tool_use block to dismiss' },
        reason: { type: 'string', description: 'Optional: why this result is no longer needed' },
        summary: { type: 'string', description: 'Required for non-re-readable results: summary of key findings' },
      },
      required: ['tool_use_id'],
    },
    async execute(args) {
      const messages = getMessages();
      const result = dismissOne(
        messages,
        args.tool_use_id as string,
        getFileHash,
        args.reason as string | undefined,
        args.summary as string | undefined,
      );

      if (result.status === 'dismissed') {
        return `Dismissed 1 result, estimated ~${(result.tokensFreed / 1000).toFixed(1)}K tokens freed.`;
      }
      return result.message;
    },
  };
}

function dismissResultsTool(getMessages: () => ApiMessage[], getFileHash: (filePath: string) => string | null): ToolDef {
  return {
    name: 'dismiss_results',
    description: 'Batch dismiss multiple tool results. Each item can optionally include a summary for non-re-readable results.',
    input_schema: {
      type: 'object',
      properties: {
        dismissals: {
          type: 'array',
          description: 'Array of items to dismiss',
          items: {
            type: 'object',
            properties: {
              tool_use_id: { type: 'string', description: 'ID of the tool_use block to dismiss' },
              summary: { type: 'string', description: 'Summary for non-re-readable results' },
            },
            required: ['tool_use_id'],
          },
        },
        reason: { type: 'string', description: 'Shared reason for the entire batch' },
      },
      required: ['dismissals'],
    },
    async execute(args) {
      const messages = getMessages();
      const dismissals = args.dismissals as { tool_use_id: string; summary?: string }[];
      const reason = args.reason as string | undefined;

      let totalFreed = 0;
      let dismissedCount = 0;
      const issues: string[] = [];

      for (const item of dismissals) {
        const result = dismissOne(messages, item.tool_use_id, getFileHash, reason, item.summary);
        if (result.status === 'dismissed') {
          dismissedCount++;
          totalFreed += result.tokensFreed;
        } else {
          issues.push(result.message);
        }
      }

      const parts: string[] = [];
      if (dismissedCount > 0) {
        parts.push(`Dismissed ${dismissedCount} result(s), estimated ~${(totalFreed / 1000).toFixed(1)}K tokens freed.`);
      }
      if (issues.length > 0) {
        parts.push(issues.join('\n'));
      }
      return parts.join('\n') || 'No results dismissed.';
    },
  };
}
