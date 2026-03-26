// --- Content Block Types ---

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  cache_control?: { type: string };
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export type MessageContent = TextContent | ToolUseContent | ToolResultContent | ThinkingContent;

// --- Messages ---

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: MessageContent[];
}

// --- Tools ---

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export interface ToolDef extends ToolDefinition {
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface ScriptToolDef {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  command: string[];
  timeoutMs?: number;
}

// --- Provider ---

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  content: MessageContent[];
  usage?: Usage;
}

export interface ChatConfig {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingBudget?: number;
  signal?: AbortSignal;
}

/** Stream event types emitted by chatStream */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'content_block_start'; blockType: string; block: any }
  | { type: 'content_block_stop' }
  | { type: 'message_complete'; response: ProviderResponse };

export interface Provider {
  chat(
    messages: ApiMessage[],
    model: string,
    tools: ToolDefinition[],
    config?: ChatConfig,
  ): Promise<ProviderResponse>;

  chatStream?(
    messages: ApiMessage[],
    model: string,
    tools: ToolDefinition[],
    config?: ChatConfig,
  ): AsyncGenerator<StreamEvent>;
}

// --- Staged Writes ---

export interface StagedWrite {
  filepath: string;
  mode: 'whole_file' | 'search_replace';
  content: string;
  searchContent?: string;
  token: string;
  validated: boolean;
}

// --- Turn Result ---

export interface ToolCallInfo {
  name: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface TurnResult {
  messages: ApiMessage[];
  finalText: string;
  toolCalls: ToolCallInfo[];
  usage: Usage;
  /** Input tokens from the final API call — best proxy for current context size. */
  lastCallInputTokens: number;
}
