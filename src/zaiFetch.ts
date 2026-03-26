/**
 * z.ai Fetch Wrapper — Anthropic SDK <-> OpenAI-compatible API translation
 *
 * Intercepts Anthropic SDK requests, transforms to OpenAI format,
 * sends to z.ai, and translates response back to Anthropic format.
 *
 * Translation:
 *   System prompt: separate param -> system message
 *   Messages: content blocks -> string content
 *   Tool definitions: input_schema -> parameters
 *   Tool use/results: content blocks <-> tool_calls/role:tool
 *   Response: choices[0].message -> content blocks
 *   Usage: prompt_tokens/completion_tokens -> input_tokens/output_tokens
 */

import { randomUUID } from 'node:crypto';

export function createZaiFetch(apiKey: string, baseURL: string): typeof globalThis.fetch {
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
    };

    if (anthropicBody.temperature !== undefined) {
      openaiBody.temperature = anthropicBody.temperature;
    }

    openaiBody.messages = transformMessages(anthropicBody.messages || [], anthropicBody.system);

    if (anthropicBody.tools && anthropicBody.tools.length > 0) {
      openaiBody.tools = transformTools(anthropicBody.tools);
    }

    // Send to z.ai
    const endpoint = `${baseURL}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openaiBody),
      signal: init?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(errorText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // Transform response back to Anthropic format
    const openaiResponse = await response.json();
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
    if (choice.message?.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message?.tool_calls) {
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
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '[Empty response from z.ai]' });
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
