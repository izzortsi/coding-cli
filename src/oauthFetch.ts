/**
 * OAuth Fetch Wrapper
 *
 * Custom fetch function that transforms requests/responses for Anthropic's
 * OAuth-authenticated endpoint. Mirrors the transformations in anthropic-oauth's
 * RequestTransformer (Python), ported to TypeScript.
 *
 * Transformations:
 *   Request headers:  Bearer auth, beta flags, user-agent, x-stainless-* spoofing
 *   Request URL:      ?beta=true on /v1/messages
 *   Request body:     Claude Code identity in system prompt, mcp_ tool name prefix
 *   Response body:    Strip mcp_ prefix from tool names
 */

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const TOOL_PREFIX = 'mcp_';
const REQUIRED_BETAS = ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14'];

// Built-in server-side tools that must NOT be prefixed
const BUILTIN_TOOL_TYPES = new Set(['web_search_20250305', 'code_execution_20250522', 'mcp']);

// Regex to strip mcp_ prefix from tool names in response JSON
const RESPONSE_TOOL_NAME_RE = /"name"\s*:\s*"mcp_([^"]+)"/g;

type TokenGetter = () => string | null;

/**
 * Create a fetch wrapper that applies OAuth transformations.
 * tokenGetter is called on each request to get the current access token.
 */
export function createOAuthFetch(tokenGetter: TokenGetter): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = tokenGetter();
    if (!token) {
      throw new Error('No OAuth token available');
    }

    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || 'POST';
    const headers = new Headers(init?.headers);

    // --- Transform headers ---
    headers.set('authorization', `Bearer ${token}`);
    headers.delete('x-api-key');

    // Merge beta flags
    const existing = headers.get('anthropic-beta') || '';
    const existingList = existing.split(',').map(b => b.trim()).filter(Boolean);
    const merged = [...new Set([...REQUIRED_BETAS, ...existingList])];
    headers.set('anthropic-beta', merged.join(','));

    // Impersonate Claude CLI
    headers.set('user-agent', 'claude-cli/2.1.2 (external, cli)');

    // Replace x-stainless-* SDK fingerprint headers
    const stainlessKeys: string[] = [];
    headers.forEach((_, key) => { if (key.startsWith('x-stainless-')) stainlessKeys.push(key); });
    for (const key of stainlessKeys) headers.delete(key);
    headers.set('x-stainless-lang', 'js');
    headers.set('x-stainless-package-version', '2.1.2');
    headers.set('x-stainless-os', 'Linux');
    headers.set('x-stainless-arch', 'x64');
    headers.set('x-stainless-runtime', 'node');
    headers.set('x-stainless-runtime-version', 'v22.13.1');

    // --- Transform URL ---
    let transformedUrl = url;
    try {
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/messages' && !parsed.searchParams.has('beta')) {
        parsed.searchParams.set('beta', 'true');
        transformedUrl = parsed.toString();
      }
    } catch {
      // Not a valid URL — pass through
    }

    // --- Transform body ---
    let body = init?.body;

    if (body && typeof body === 'string') {
      try {
        const bodyObj = JSON.parse(body);
        const transformed = transformRequestBody(bodyObj);
        body = JSON.stringify(transformed);
      } catch {
        // Not valid JSON — pass through
      }
    }

    // Delete content-length — let fetch recalculate after body transformation
    headers.delete('content-length');

    // --- Forward request ---
    const response = await globalThis.fetch(transformedUrl, {
      ...init,
      method,
      headers,
      body,
    });

    // --- Transform response ---
    const respContentType = response.headers.get('content-type') || '';
    if (respContentType.includes('application/json')) {
      const text = await response.text();
      const stripped = text.replace(RESPONSE_TOOL_NAME_RE, '"name": "$1"');

      return new Response(stripped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // For streaming responses (SSE), strip mcp_ prefix from tool names in the stream
    if (response.body && respContentType.includes('text/event-stream')) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          let text = decoder.decode(value, { stream: true });
          text = text.replace(RESPONSE_TOOL_NAME_RE, '"name": "$1"');
          controller.enqueue(encoder.encode(text));
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  };
}

// --- Body Transformation ---

function transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };

  // Inject Claude Code identity into system prompt
  const system = out.system;
  if (typeof system === 'string') {
    out.system = [
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: system },
    ];
  } else if (Array.isArray(system)) {
    out.system = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, ...system];
  } else if (out.messages) {
    out.system = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }];
  }

  // Prefix tool definitions (skip built-in tools)
  if (Array.isArray(out.tools)) {
    out.tools = (out.tools as any[]).map(tool => {
      if (typeof tool.type === 'string' && BUILTIN_TOOL_TYPES.has(tool.type)) return tool;
      if (typeof tool.name === 'string') return { ...tool, name: `${TOOL_PREFIX}${tool.name}` };
      return tool;
    });
  }

  // Prefix tool_use block names in message history
  if (Array.isArray(out.messages)) {
    out.messages = (out.messages as any[]).map(prefixMessageTools);
  }

  return out;
}

function prefixMessageTools(msg: Record<string, unknown>): Record<string, unknown> {
  const content = msg.content;
  if (!Array.isArray(content)) return msg;

  const newContent = content.map((block: any) => {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      return { ...block, name: `${TOOL_PREFIX}${block.name}` };
    }
    return block;
  });

  return { ...msg, content: newContent };
}
