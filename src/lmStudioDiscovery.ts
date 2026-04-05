/**
 * LM Studio Model Discovery — detects running LM Studio instance and enumerates loaded models.
 *
 * Uses LM Studio's REST API:
 *   GET  /v1/models          — standard OpenAI-compatible model list
 *   GET  /api/v0/models      — LM Studio extended info (max_context_length, arch, state, ...)
 *
 * LM Studio defaults to http://localhost:1234. Override with LM_STUDIO_BASE_URL.
 */

import type { ModelPreset } from './presets.js';

const HEALTH_TIMEOUT_MS = 2_000;
const LIST_TIMEOUT_MS = 3_000;
const MAX_MODELS = 20;
const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Strip trailing /v1 or /v1/ from URL to get LM Studio's native base.
 * Users may configure LM_STUDIO_BASE_URL as http://host:1234/v1
 * but the REST API lives at http://host:1234/.
 */
function stripV1(url: string): string {
  let u = url.replace(/\/+$/, '');
  if (u.endsWith('/v1')) u = u.slice(0, -3);
  return u;
}

/**
 * Check if LM Studio is running at the given base URL.
 * Probes /v1/models — returns 200 when the server is up (even with no models loaded).
 */
export async function checkLmStudioHealth(baseURL: string): Promise<boolean> {
  try {
    const base = stripV1(baseURL);
    const url = `${base}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (process.env.LM_STUDIO_DEBUG) {
      process.stderr.write(`[lm-studio-discovery] ${url} -> ${response.status}\n`);
    }
    return response.ok;
  } catch (err) {
    if (process.env.LM_STUDIO_DEBUG) {
      process.stderr.write(`[lm-studio-discovery] Health check error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return false;
  }
}

interface LmStudioExtendedModel {
  id: string;
  object: string;
  type?: string;              // "llm" | "vlm" | "embeddings"
  publisher?: string;
  arch?: string;
  compatibility_type?: string; // "gguf" | "mlx"
  quantization?: string;
  state?: string;              // "loaded" | "not-loaded"
  max_context_length?: number;
  loaded_context_length?: number;
}

interface OpenAiModel {
  id: string;
  object: string;
  owned_by?: string;
}

/**
 * List models via LM Studio's extended endpoint (/api/v0/models).
 * Returns [] if the endpoint is unavailable (older LM Studio versions).
 */
async function listExtendedModels(baseURL: string): Promise<LmStudioExtendedModel[]> {
  try {
    const base = stripV1(baseURL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    const response = await fetch(`${base}/api/v0/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.data || []) as LmStudioExtendedModel[];
  } catch {
    return [];
  }
}

/**
 * Fallback: list models via standard /v1/models (OpenAI-compatible).
 */
async function listOpenAiModels(baseURL: string): Promise<OpenAiModel[]> {
  try {
    const base = stripV1(baseURL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    const response = await fetch(`${base}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.data || []) as OpenAiModel[];
  } catch {
    return [];
  }
}

/**
 * Sanitize LM Studio model id into a preset id.
 * e.g. "qwen2.5-7b-instruct" → "lmstudio-qwen2.5-7b-instruct"
 *      "mlx-community/Qwen2-VL-7B" → "lmstudio-mlx-community-Qwen2-VL-7B"
 */
function sanitizePresetId(modelId: string): string {
  const name = modelId.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `lmstudio-${name}`;
}

/**
 * Build a human-friendly display name from extended model info.
 */
function buildDisplayName(model: LmStudioExtendedModel): string {
  const parts: string[] = [model.id];
  if (model.quantization) parts.push(model.quantization);
  if (model.state === 'loaded') parts.push('[loaded]');
  parts.push('(LM Studio)');
  return parts.join(' ');
}

/**
 * Discover all LM Studio models and generate ModelPresets.
 * Prefers /api/v0/models for rich metadata, falls back to /v1/models.
 * Returns empty array if LM Studio is not running or has no models.
 */
export async function discoverLmStudioModels(baseURL: string): Promise<ModelPreset[]> {
  const base = stripV1(baseURL);
  if (process.env.LM_STUDIO_DEBUG) {
    process.stderr.write(`[lm-studio-discovery] Probing ${base}/v1/models ...\n`);
  }

  const healthy = await checkLmStudioHealth(baseURL);
  if (!healthy) {
    if (process.env.LM_STUDIO_DEBUG) {
      process.stderr.write(`[lm-studio-discovery] Health check failed for ${base}\n`);
    }
    return [];
  }

  // Try extended endpoint first — it gives us context length + filter signals
  const extended = await listExtendedModels(baseURL);

  if (extended.length > 0) {
    if (process.env.LM_STUDIO_DEBUG) {
      process.stderr.write(`[lm-studio-discovery] Found ${extended.length} models via /api/v0/models\n`);
    }

    // Filter out embedding/non-LLM entries — keep llm + vlm
    const chatCapable = extended.filter(m => !m.type || m.type === 'llm' || m.type === 'vlm');

    // Sort: loaded models first, then by id
    const sorted = chatCapable
      .sort((a, b) => {
        const aLoaded = a.state === 'loaded' ? 0 : 1;
        const bLoaded = b.state === 'loaded' ? 0 : 1;
        if (aLoaded !== bLoaded) return aLoaded - bLoaded;
        return a.id.localeCompare(b.id);
      })
      .slice(0, MAX_MODELS);

    return sorted.map(model => ({
      id: sanitizePresetId(model.id),
      providerId: 'lm-studio' as const,
      modelId: model.id,
      displayName: buildDisplayName(model),
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: 0.7,
      thinkingBudget: 0,
      contextWindow: model.max_context_length && model.max_context_length > 0
        ? model.max_context_length
        : DEFAULT_CONTEXT_WINDOW,
      needsIdentity: false,
    }));
  }

  // Fallback: standard OpenAI /v1/models (older LM Studio versions)
  const openai = await listOpenAiModels(baseURL);
  if (process.env.LM_STUDIO_DEBUG) {
    process.stderr.write(`[lm-studio-discovery] Found ${openai.length} models via /v1/models (fallback)\n`);
  }
  if (openai.length === 0) return [];

  return openai.slice(0, MAX_MODELS).map(model => ({
    id: sanitizePresetId(model.id),
    providerId: 'lm-studio' as const,
    modelId: model.id,
    displayName: `${model.id} (LM Studio)`,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: 0.7,
    thinkingBudget: 0,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    needsIdentity: false,
  }));
}
