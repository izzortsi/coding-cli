import Anthropic from '@anthropic-ai/sdk';
import type {
  ApiMessage,
  MessageContent,
  TextContent,
  ToolUseContent,
  ThinkingContent,
  ToolDefinition,
  ProviderResponse,
  Provider,
  ChatConfig,
  StreamEvent,
  Usage,
} from './types.js';

export interface ProviderOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  baseURL?: string;
}

// --- Retry Logic ---

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 2000;

function isRetryable(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  const errorType = err?.error?.type || '';
  return status === 429 || status === 529 || status === 503
    || errorType === 'overloaded_error' || errorType === 'rate_limit_error'
    || msg.includes('overloaded') || msg.includes('rate_limit')
    || msg.includes('too many requests') || msg.includes('service unavailable');
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES) throw err;
      const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
      const jitter = Math.random() * 1000;
      process.stderr.write(`\r\x1b[2K  \x1b[93m⟳\x1b[0m ${label} overloaded, retrying in ${((delay + jitter) / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})...\n`);
      await new Promise(r => setTimeout(r, delay + jitter));
    }
  }
  throw lastErr;
}

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  /** Whether this provider supports native SSE streaming (custom fetch providers don't) */
  private supportsStreaming: boolean;

  constructor(opts: ProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey || 'placeholder',
      ...(opts.fetch ? { fetch: opts.fetch as any } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      timeout: 300_000,
    });
    // Custom fetch providers (z.ai) intercept the fetch call and return
    // a transformed Response — they don't support SSE streaming.
    this.supportsStreaming = !opts.fetch;
  }

  private buildParams(
    messages: ApiMessage[],
    model: string,
    tools: ToolDefinition[],
    config?: ChatConfig,
  ): Record<string, unknown> {
    const maxTokens = config?.maxTokens ?? 16384;
    const temperature = config?.temperature ?? 0.7;
    const thinkingBudget = config?.thinkingBudget ?? 0;

    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: messages.map(m => ({
        role: m.role,
        content: this.transformContentOut(m.content),
      })),
    };

    if (config?.systemPrompt) params.system = config.systemPrompt;
    if (tools.length > 0) params.tools = tools;

    if (thinkingBudget > 0) {
      params.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
      params.temperature = 1;
    } else {
      // claude-opus-4-6 (1M context variant) rejects temperature != 1 unless
      // thinking is enabled. Force temperature=1 for this model when thinking
      // is off to avoid 400 "Invalid request data" from callers that use low
      // temperatures (e.g. compaction, commit-message generation).
      if (model.startsWith('claude-opus-4-6')) {
        params.temperature = 1;
      } else {
        params.temperature = temperature;
      }
    }

    return params;
  }

  async chat(
    messages: ApiMessage[],
    model: string,
    tools: ToolDefinition[],
    config?: ChatConfig,
  ): Promise<ProviderResponse> {
    const params = this.buildParams(messages, model, tools, config);
    const reqOpts = config?.signal ? { signal: config.signal } : undefined;
    const completion = await withRetry(
      () => this.client.messages.create(params as any, reqOpts as any),
      model,
    );
    return this.processResponse(completion);
  }

  async *chatStream(
    messages: ApiMessage[],
    model: string,
    tools: ToolDefinition[],
    config?: ChatConfig,
  ): AsyncGenerator<StreamEvent> {
    const params = this.buildParams(messages, model, tools, config);

    // z.ai and other custom-fetch providers don't support streaming —
    // fall back to non-streaming chat and yield the complete response.
    const reqOpts = config?.signal ? { signal: config.signal } : undefined;
    if (!this.supportsStreaming) {
      const response = await withRetry(
        () => this.client.messages.create(params as any, reqOpts as any),
        model,
      );
      const processed = this.processResponse(response);

      // Simulate streaming by yielding text deltas from the complete response
      for (const block of processed.content) {
        if (block.type === 'text') {
          yield { type: 'text_delta', text: (block as TextContent).text };
        }
      }

      yield { type: 'message_complete', response: processed };
      return;
    }

    // Anthropic streaming path
    (params as any).stream = true;

    const stream = await withRetry(
      () => this.client.messages.create(params as any, reqOpts as any),
      model,
    );

    const blocks: any[] = [];
    let currentBlock: any = null;
    let usage: any = null;

    for await (const event of stream as any) {
      switch (event.type) {
        case 'content_block_start':
          currentBlock = { ...event.content_block };
          if (currentBlock.type === 'text') currentBlock.text = '';
          if (currentBlock.type === 'thinking') currentBlock.thinking = '';
          if (currentBlock.type === 'tool_use') currentBlock.input = '';

          yield {
            type: 'content_block_start',
            blockType: currentBlock.type,
            block: currentBlock,
          };
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta' && currentBlock) {
            currentBlock.text = (currentBlock.text || '') + event.delta.text;
            yield { type: 'text_delta', text: event.delta.text };
          }
          if (event.delta.type === 'thinking_delta' && currentBlock) {
            currentBlock.thinking = (currentBlock.thinking || '') + event.delta.thinking;
            yield { type: 'thinking_delta', thinking: event.delta.thinking };
          }
          if (event.delta.type === 'input_json_delta' && currentBlock) {
            currentBlock.input = (currentBlock.input || '') + event.delta.partial_json;
          }
          break;

        case 'content_block_stop':
          if (currentBlock) {
            if (currentBlock.type === 'tool_use' && typeof currentBlock.input === 'string') {
              try { currentBlock.input = JSON.parse(currentBlock.input || '{}'); } catch { currentBlock.input = {}; }
            }
            blocks.push(currentBlock);
            currentBlock = null;
          }
          yield { type: 'content_block_stop' };
          break;

        case 'message_delta':
          if (event.usage) usage = event.usage;
          break;

        case 'message_start':
          if (event.message?.usage) usage = event.message.usage;
          break;
      }
    }

    const response = this.processResponse({ content: blocks, usage });
    yield { type: 'message_complete', response };
  }

  private transformContentOut(content: MessageContent[]): any[] {
    const out: any[] = [];
    for (const block of content) {
      switch (block.type) {
        case 'text': {
          const text = (block as TextContent).text;
          if (text?.trim()) out.push({ type: 'text', text });
          break;
        }
        case 'tool_use': {
          const tu = block as ToolUseContent;
          out.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input || {} });
          break;
        }
        case 'tool_result': {
          const tr = block as any;
          const obj: any = {
            type: 'tool_result',
            tool_use_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            is_error: tr.is_error,
          };
          if (tr.cache_control) obj.cache_control = tr.cache_control;
          out.push(obj);
          break;
        }
        case 'thinking': {
          const th = block as ThinkingContent;
          if (th.signature) {
            out.push({ type: 'thinking', thinking: th.thinking || '', signature: th.signature });
          }
          break;
        }
      }
    }
    if (out.length === 0) out.push({ type: 'text', text: '[Empty message]' });
    return out;
  }

  private processResponse(completion: any): ProviderResponse {
    const content: MessageContent[] = [];

    if (Array.isArray(completion.content)) {
      for (const block of completion.content) {
        switch (block.type) {
          case 'thinking':
            content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature } as ThinkingContent);
            break;
          case 'text':
            content.push({ type: 'text', text: block.text } as TextContent);
            break;
          case 'tool_use':
            content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input || {} } as ToolUseContent);
            break;
        }
      }
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '[Empty response from model]' } as TextContent);
    }

    const usage: Usage | undefined = completion.usage
      ? { inputTokens: completion.usage.input_tokens || 0, outputTokens: completion.usage.output_tokens || 0 }
      : undefined;

    return { content, usage };
  }
}
