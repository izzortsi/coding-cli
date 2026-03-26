/**
 * Ollama Model Discovery — detects running Ollama instance and enumerates installed models.
 *
 * Uses Ollama's native API:
 *   GET  /           — health check
 *   GET  /api/tags   — list installed models
 *   POST /api/show   — get model metadata (context length, family, etc.)
 */

import type { ModelPreset } from './presets.js';

const HEALTH_TIMEOUT_MS = 2_000;
const SHOW_TIMEOUT_MS = 3_000;
const MAX_MODELS = 20;
const DEFAULT_CONTEXT_WINDOW = 4096;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Check if Ollama is running at the given base URL.
 */
export async function checkOllamaHealth(baseURL: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const response = await fetch(`${baseURL}/`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

/**
 * List all installed models from Ollama.
 */
async function listModels(baseURL: string): Promise<OllamaModel[]> {
  try {
    const response = await fetch(`${baseURL}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.models || [];
  } catch {
    return [];
  }
}

/**
 * Get context window length for a specific model via /api/show.
 * Looks for <arch>.context_length in model_info.
 */
async function getContextLength(baseURL: string, modelName: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHOW_TIMEOUT_MS);
    const response = await fetch(`${baseURL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return DEFAULT_CONTEXT_WINDOW;
    const data = await response.json();

    // Context length is in model_info under <architecture>.context_length
    const modelInfo = data.model_info || {};
    for (const key of Object.keys(modelInfo)) {
      if (key.endsWith('.context_length')) {
        const val = modelInfo[key];
        if (typeof val === 'number' && val > 0) return val;
      }
    }

    return DEFAULT_CONTEXT_WINDOW;
  } catch {
    return DEFAULT_CONTEXT_WINDOW;
  }
}

/**
 * Sanitize Ollama model name into a preset id.
 * e.g. "llama3:latest" → "ollama-llama3"
 *      "qwen2.5:7b-instruct" → "ollama-qwen2.5-7b-instruct"
 */
function sanitizePresetId(modelName: string): string {
  let name = modelName.replace(/:latest$/, '');
  name = name.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `ollama-${name}`;
}

/**
 * Build a human-friendly display name.
 * e.g. "llama3:latest" → "llama3 8.0B Q4_0 (Ollama)"
 *      "qwen2.5:7b-instruct" → "qwen2.5:7b-instruct 7.6B Q4_K_M (Ollama)"
 */
function buildDisplayName(modelName: string, details?: OllamaModel['details']): string {
  const name = modelName.replace(/:latest$/, '');
  const parts: string[] = [name];
  if (details?.parameter_size) parts.push(details.parameter_size);
  if (details?.quantization_level) parts.push(details.quantization_level);
  parts.push('(Ollama)');
  return parts.join(' ');
}

/**
 * Discover all Ollama models and generate ModelPresets.
 * Returns empty array if Ollama is not running or has no models.
 */
export async function discoverOllamaModels(baseURL: string): Promise<ModelPreset[]> {
  const healthy = await checkOllamaHealth(baseURL);
  if (!healthy) return [];

  const models = await listModels(baseURL);
  if (models.length === 0) return [];

  // Sort by modification time (most recent first), cap at MAX_MODELS
  const sorted = models
    .sort((a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime())
    .slice(0, MAX_MODELS);

  // Fetch context lengths in parallel (each has its own timeout)
  const contextLengths = await Promise.all(
    sorted.map(m => getContextLength(baseURL, m.name)),
  );

  return sorted.map((model, i) => ({
    id: sanitizePresetId(model.name),
    providerId: 'ollama' as const,
    modelId: model.name,
    displayName: buildDisplayName(model.name, model.details),
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: 0.7,
    thinkingBudget: 0,
    contextWindow: contextLengths[i],
    needsIdentity: false,
  }));
}
