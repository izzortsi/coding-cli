export type ProviderId = 'anthropic' | 'zai' | 'ollama' | 'lm-studio';

export interface ModelPreset {
  id: string;
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  maxTokens: number;
  temperature: number;
  thinkingBudget: number;
  contextWindow: number;
  needsIdentity: boolean;
}

export const PRESETS: ModelPreset[] = [
  // --- Anthropic ---
  {
    id: 'opus-4-6',
    providerId: 'anthropic',
    modelId: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    maxTokens: 32768,
    temperature: 1,
    thinkingBudget: 16384,
    contextWindow: 1_000_000,
    needsIdentity: true,
  },
  {
    id: 'sonnet-4-6',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    maxTokens: 16384,
    temperature: 0.7,
    thinkingBudget: 0,
    contextWindow: 1_000_000,
    needsIdentity: true,
  },
  // --- z.ai ---
  {
    id: 'glm-5',
    providerId: 'zai',
    modelId: 'GLM-5',
    displayName: 'GLM-5',
    maxTokens: 16384,
    temperature: 0.7,
    thinkingBudget: 0,
    contextWindow: 200_000,
    needsIdentity: false,
  },
  {
    id: 'glm-5-turbo',
    providerId: 'zai',
    modelId: 'GLM-5-Turbo',
    displayName: 'GLM-5 Turbo',
    maxTokens: 16384,
    temperature: 0.7,
    thinkingBudget: 0,
    contextWindow: 200_000,
    needsIdentity: false,
  },
  {
    id: 'glm-4.7-flash',
    providerId: 'zai',
    modelId: 'GLM-4.7-Flash',
    displayName: 'GLM-4.7 Flash',
    maxTokens: 16384,
    temperature: 0.7,
    thinkingBudget: 0,
    contextWindow: 200_000,
    needsIdentity: false,
  },
];

export function getAvailablePresets(availableProviders: Set<string>): ModelPreset[] {
  return PRESETS.filter(p => availableProviders.has(p.providerId));
}

export function findPreset(idOrModelId: string): ModelPreset | undefined {
  return PRESETS.find(p => p.id === idOrModelId || p.modelId === idOrModelId);
}

export function getDefaultPreset(providerId: ProviderId): ModelPreset | undefined {
  return PRESETS.find(p => p.providerId === providerId);
}

/**
 * Get presets filtered by a specific provider.
 */
export function getPresetsForProvider(providerId: string): ModelPreset[] {
  return PRESETS.filter(p => p.providerId === providerId);
}

/**
 * Register dynamically discovered presets (e.g., from Ollama).
 * Avoids duplicates by id.
 */
export function registerPresets(presets: ModelPreset[]): void {
  for (const preset of presets) {
    if (!PRESETS.some(p => p.id === preset.id)) {
      PRESETS.push(preset);
    }
  }
}
