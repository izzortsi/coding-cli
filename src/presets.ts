export type ProviderId = 'zai';

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
    id: 'glm-4.7',
    providerId: 'zai',
    modelId: 'GLM-4.7',
    displayName: 'GLM-4.7',
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
  {
    id: 'glm-4.5-air',
    providerId: 'zai',
    modelId: 'GLM-4.5-Air',
    displayName: 'GLM-4.5 Air',
    maxTokens: 8192,
    temperature: 0.7,
    thinkingBudget: 0,
    contextWindow: 128_000,
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
