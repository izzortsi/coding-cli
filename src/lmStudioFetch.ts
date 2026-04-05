/**
 * LM Studio Fetch Wrapper — Anthropic SDK <-> OpenAI-compatible API translation
 *
 * Intercepts Anthropic SDK requests, transforms to OpenAI format,
 * sends to LM Studio's /v1/chat/completions endpoint, and translates
 * the response back to Anthropic format.
 *
 * LM Studio exposes a standard OpenAI-compatible API at http://localhost:1234/v1
 * (configurable). No API key required for local inference; any string is accepted.
 */

import { randomUUID } from 'node:crypto';

export function createLmStudioFetch(baseURL: string): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let anthropicBody: any;
    try {
      anthropicBody = JSON.parse(init?.body as string);
    } catch {
      return fetch(input, init);
    }

    // Build OpenAI-compatible request
    const openaiBody: any = {
      model: anthropicBody.model,
      max_tokens: anthropicBody.max_tokens,
      stream: false,
    };

    if (anthropicBody.temperature !== undefined) {
      openaiBody.temperature = anthropicBody.temperature;
    }

    openaiBody.messages = transformMessages(anthropicBody.messages || [], anthropicBody.system);

    if (anthropicBody.tools && anthropicBody.tools.length > 0) {
      openaiBody.tools = transformTools(anthropicBody.tools);
    }

    const endpoint = `${baseURL}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // LM Studio accepts any bearer (or none); include a placeholder for
        // compatibility with strict OpenAI client libraries.
        'Authorization': 'Bearer lm-studio',
      },
      body: JSON.stringify(openaiBody),
      signal: init?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      process.stderr.write(`[lm-studio] HTTP ${response.status}: ${errorText.slice(0, 500)}\n`);

      // Try to extract a friendly message from LM Studio's JSON error body
      // (e.g. "Failed to load model") and return it as an assistant text block
      // so the turn doesn't crash — the user can recover by loading the model
      // in LM Studio or switching to a different preset.
      let friendly = `HTTP ${response.status}: ${response.statusText || 'request failed'}`;
      try {
        const parsed = JSON.parse(errorText);
        const msg = parsed?.error?.message || parsed?.error || parsed?.message;
        if (msg) friendly = typeof msg === 'string' ? msg : JSON.stringify(msg);
      } catch { /* errorText wasn't JSON — keep default */ }

      const wrapped = {
        id: `msg_${randomUUID().substring(0, 12)}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: `[LM Studio error: ${friendly}]` }],
        model: anthropicBody.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      return new Response(JSON.stringify(wrapped), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const rawText = await response.text();
    let openaiResponse: any;
    try {
      openaiResponse = JSON.parse(rawText);
    } catch {
      process.stderr.write(`[lm-studio] Failed to parse response: ${rawText.slice(0, 500)}\n`);
      openaiResponse = {};
    }

    if (process.env.LM_STUDIO_DEBUG) {
      process.stderr.write(`[lm-studio] Raw response: ${rawText.slice(0, 1000)}\n`);
    }

    // Handle LM Studio error responses
    if (openaiResponse.error) {
      const errMsg = typeof openaiResponse.error === 'string'
        ? openaiResponse.error
        : openaiResponse.error.message || JSON.stringify(openaiResponse.error);
      process.stderr.write(`[lm-studio] Model error: ${errMsg}\n`);
      const errorResponse = {
        id: `msg_${randomUUID().substring(0, 12)}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: `[LM Studio error: ${errMsg}]` }],
        model: anthropicBody.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const anthropicResponse = transformResponse(openaiResponse, anthropicBody.model);

    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// --- Message Transformation ---

function transformMessages(messages: any[], system: any): any[] {
  const out: any[] = [];

  // System prompt -> system message
  if (system) {
    const text = typeof system === 'string'
      ? system
      : system.map((s: any) => s.text || '').join('\n');
    if (text.trim()) {
      out.push({ role: 'system', content: text });
    }
  }

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      out.push({ role: msg.role, content: String(msg.content || '') });
      continue;
    }

    if (msg.role === 'user') {
      const toolResults = msg.content.filter((b: any) => b.type === 'tool_result');
      const textBlocks = msg.content.filter((b: any) => b.type === 'text');

      // tool_result -> role:tool messages
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        });
      }

      // text blocks -> user message
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b: any) => b.text).join('\n');
        if (text.trim()) {
          out.push({ role: 'user', content: text });
        }
      }
    } else if (msg.role === 'assistant') {
      const textBlocks = msg.content.filter((b: any) => b.type === 'text');
      const toolUseBlocks = msg.content.filter((b: any) => b.type === 'tool_use');

      const assistantMsg: any = {
        role: 'assistant',
        content: textBlocks.map((b: any) => b.text).join('\n') || null,
      };

      if (toolUseBlocks.length > 0) {
        assistantMsg.tool_calls = toolUseBlocks.map((tu: any) => ({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input || {}),
          },
        }));
      }

      out.push(assistantMsg);
    }
  }

  return out;
}

// --- Tool Definition Transformation ---

function transformTools(tools: any[]): any[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// --- Response Transformation ---

function transformResponse(openaiResponse: any, model: string): any {
  const choice = openaiResponse.choices?.[0];
  const content: any[] = [];
  let stopReason = 'end_turn';

  if (choice) {
    const textContent = choice.message?.content;
    if (typeof textContent === 'string' && textContent.length > 0) {
      content.push({ type: 'text', text: textContent });
    }

    if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
      for (const tc of choice.message.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* */ }
        content.push({
          type: 'tool_use',
          id: tc.id || `tool_${randomUUID().substring(0, 8)}`,
          name: tc.function?.name || 'unknown',
          input,
        });
      }
      stopReason = 'tool_use';
    }

    if (choice.finish_reason === 'length') stopReason = 'max_tokens';
    else if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
  } else {
    process.stderr.write(`[lm-studio] No choices in response (keys: ${Object.keys(openaiResponse).join(', ')})\n`);
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '[Empty response from LM Studio — try LM_STUDIO_DEBUG=1 for details]' });
  }

  return {
    id: openaiResponse.id || `msg_${randomUUID().substring(0, 12)}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    usage: openaiResponse.usage ? {
      input_tokens: openaiResponse.usage.prompt_tokens || 0,
      output_tokens: openaiResponse.usage.completion_tokens || 0,
    } : { input_tokens: 0, output_tokens: 0 },
  };
}
