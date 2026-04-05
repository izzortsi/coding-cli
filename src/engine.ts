import type {
  ApiMessage,
  MessageContent,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ToolDefinition,
  Provider,
  ChatConfig,
  StreamEvent,
  TurnResult,
  Usage,
} from './types.js';
import type { ToolRegistry } from './tools/registry.js';

const DEFAULT_MAX_STEPS = 25;

/** Cap tool result content to prevent single results from bloating context. ~3K tokens. */
const MAX_TOOL_RESULT_CHARS = 12_000;

export interface EngineHooks {
  onBeforeApiCall?: (messages: ApiMessage[]) => ApiMessage[] | Promise<ApiMessage[]>;
  onAfterToolResult?: (toolName: string, result: string, input?: Record<string, unknown>) => void;
  onTurnComplete?: (result: TurnResult) => void;
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onStreamStart?: () => void;
  onStreamEnd?: () => void;
}

export interface EngineConfig {
  maxToolSteps?: number;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingBudget?: number;
  hooks?: EngineHooks;
}

export class Engine {
  messages: ApiMessage[] = [];
  provider: Provider;
  private registry: ToolRegistry;
  config: EngineConfig;

  constructor(provider: Provider, registry: ToolRegistry, config: EngineConfig = {}) {
    this.provider = provider;
    this.registry = registry;
    this.config = config;
  }

  private buildChatConfig(): ChatConfig {
    return {
      systemPrompt: this.config.systemPrompt,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      thinkingBudget: this.config.thinkingBudget,
    };
  }

  private async prepareApiCall(): Promise<{ apiMessages: ApiMessage[]; tools: any[] }> {
    let apiMessages = [...this.messages];
    if (this.config.hooks?.onBeforeApiCall) {
      apiMessages = await this.config.hooks.onBeforeApiCall(apiMessages);
    }
    // Validate AFTER hooks (compaction slices dormant messages, which can orphan tool pairs)
    apiMessages = validateToolPairs(apiMessages);
    const tools = this.registry.getDefinitions();
    return { apiMessages, tools };
  }

  async turn(userText: string, model: string, signal?: AbortSignal): Promise<TurnResult> {
    const maxSteps = this.config.maxToolSteps ?? DEFAULT_MAX_STEPS;
    const result: TurnResult = {
      messages: [],
      finalText: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      lastCallInputTokens: 0,
    };
    const useStreaming = !!this.provider.chatStream;

    // Save message count for O(1) error rollback
    const rollbackLength = this.messages.length;

    // Append user message
    const userMsg: ApiMessage = { role: 'user', content: [{ type: 'text', text: userText }] };
    this.messages.push(userMsg);
    result.messages.push(userMsg);

    let steps = 0;
    try {
      while (steps < maxSteps) {
        // Check abort signal before each step
        if (signal?.aborted) {
          result.finalText = '[Aborted]';
          break;
        }

        steps++;

        const { apiMessages, tools } = await this.prepareApiCall();
        const chatConfig = this.buildChatConfig();
        chatConfig.signal = signal;

        let response;

        if (useStreaming && this.provider.chatStream) {
          // Streaming path — fire text deltas as they arrive.
          // onStreamStart is deferred until the first text/thinking delta so the
          // spinner keeps running during the full network round-trip.
          let streamStarted = false;

          const stream = this.provider.chatStream(apiMessages, model, tools, chatConfig);
          for await (const event of stream) {
            if (event.type === 'text_delta') {
              if (!streamStarted) {
                streamStarted = true;
                this.config.hooks?.onStreamStart?.();
              }
              this.config.hooks?.onTextDelta?.(event.text);
            } else if (event.type === 'thinking_delta') {
              if (!streamStarted) {
                streamStarted = true;
                this.config.hooks?.onStreamStart?.();
              }
              this.config.hooks?.onThinkingDelta?.(event.thinking);
            } else if (event.type === 'message_complete') {
              response = event.response;
            }
          }

          // If the response had no text/thinking deltas (tool-only response),
          // we still need to fire onStreamStart/onStreamEnd so state is consistent.
          if (!streamStarted) {
            this.config.hooks?.onStreamStart?.();
          }
          this.config.hooks?.onStreamEnd?.();
        } else {
          // Non-streaming fallback
          response = await this.provider.chat(apiMessages, model, tools, chatConfig);
        }

        if (!response) {
          result.finalText = '[No response from provider]';
          break;
        }

        // Accumulate usage — track last call separately for context size estimation
        if (response.usage) {
          result.usage.inputTokens += response.usage.inputTokens;
          result.usage.outputTokens += response.usage.outputTokens;
          result.usage.cacheCreationInputTokens = (result.usage.cacheCreationInputTokens || 0) + (response.usage.cacheCreationInputTokens || 0);
          result.usage.cacheReadInputTokens = (result.usage.cacheReadInputTokens || 0) + (response.usage.cacheReadInputTokens || 0);
          result.lastCallInputTokens = response.usage.inputTokens;
        }

        // Record assistant message
        const assistantMsg: ApiMessage = { role: 'assistant', content: response.content };
        this.messages.push(assistantMsg);
        result.messages.push(assistantMsg);

        // Check for tool calls
        const toolCalls = this.registry.extractToolCalls(response.content);
        if (toolCalls.length === 0) {
          result.finalText = extractText(response.content);
          break;
        }

        // Execute tool calls in parallel — order is preserved via Promise.all.
        // This significantly speeds up steps with multiple independent calls.
        const toolPromises = toolCalls.map(async (tc) => {
          const start = Date.now();
          const tr = await this.registry.execute(tc);
          const durationMs = Date.now() - start;
          return { tc, tr, durationMs };
        });
        const toolExecutions = await Promise.all(toolPromises);

        const toolResults: ToolResultContent[] = [];
        for (const { tc, tr, durationMs } of toolExecutions) {
          // Truncate oversized results to prevent context bloat
          if (tr.content.length > MAX_TOOL_RESULT_CHARS) {
            const truncated = tr.content.length - MAX_TOOL_RESULT_CHARS;
            tr.content = tr.content.slice(0, MAX_TOOL_RESULT_CHARS)
              + `\n\n[Truncated: ${truncated} chars removed. Re-run with narrower scope if needed.]`;
          }
          toolResults.push(tr);
          result.toolCalls.push({
            name: tc.name,
            result: tr.content.substring(0, 200),
            isError: tr.is_error || false,
            durationMs,
          });
          this.config.hooks?.onAfterToolResult?.(tc.name, tr.content, tc.input as Record<string, unknown>);
        }

        // Record tool results as user message
        const toolMsg: ApiMessage = { role: 'user', content: toolResults as MessageContent[] };
        this.messages.push(toolMsg);
        result.messages.push(toolMsg);
      }

      if (steps >= maxSteps) {
        result.finalText = '[Max tool steps reached]';
      }
    } catch (error) {
      // Roll back all messages from this turn to prevent corrupted history
      this.messages.length = rollbackLength;
      throw error;
    }

    this.config.hooks?.onTurnComplete?.(result);
    return result;
  }
}

// --- Utilities ---

function extractText(content: MessageContent[]): string {
  return content
    .filter((b): b is TextContent => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

/**
 * Strip orphaned tool_use and tool_result blocks using ID matching.
 *
 * Pass 1: For each assistant message with tool_use blocks, collect the IDs
 *   that have matching tool_result in the immediately following user message.
 *   Strip tool_use blocks whose IDs have no result.
 * Pass 2: Strip tool_result blocks whose tool_use_id has no matching tool_use
 *   in the immediately preceding assistant message.
 */
function validateToolPairs(messages: ApiMessage[]): ApiMessage[] {
  // Pass 1: strip tool_use blocks with no matching result by ID
  const pass1: ApiMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const toolUses = msg.content.filter((b): b is ToolUseContent => b.type === 'tool_use');
      if (toolUses.length > 0) {
        const next = messages[i + 1];
        const resultIds = new Set(
          next?.role === 'user'
            ? next.content
                .filter((b): b is ToolResultContent => b.type === 'tool_result')
                .map(b => b.tool_use_id)
            : []
        );
        // Keep only tool_use blocks that have a matching result
        const pairedContent = msg.content.filter(b => {
          if (b.type !== 'tool_use') return true;
          return resultIds.has((b as ToolUseContent).id);
        });
        // Keep the message if any content remains; drop if all tool_uses were orphaned
        // and no text/thinking blocks existed
        if (pairedContent.length > 0) {
          pass1.push({ ...msg, content: pairedContent });
        }
        continue;
      }
    }
    pass1.push(msg);
  }

  // Pass 2: strip tool_result blocks with no matching tool_use by ID
  const pass2: ApiMessage[] = [];
  for (let i = 0; i < pass1.length; i++) {
    const msg = pass1[i];
    if (msg.role === 'user' && msg.content.some(b => b.type === 'tool_result')) {
      const prev = pass2[pass2.length - 1];
      const pairedIds = new Set(
        prev?.role === 'assistant'
          ? prev.content
              .filter((b): b is ToolUseContent => b.type === 'tool_use')
              .map(b => b.id)
          : []
      );
      const pairedContent = msg.content.filter(b => {
        if (b.type !== 'tool_result') return true;
        return pairedIds.has((b as ToolResultContent).tool_use_id);
      });
      if (pairedContent.length > 0) {
        pass2.push({ ...msg, content: pairedContent });
      }
      continue;
    }
    pass2.push(msg);
  }

  return pass2;
}
