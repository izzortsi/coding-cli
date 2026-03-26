import { AnthropicProvider } from './provider.js';
import { createZaiFetch } from './zaiFetch.js';

export interface AuthResult {
  provider: AnthropicProvider;
  providerId: string;
  label: string;
}

export function initProvider(): AuthResult {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error('ZHIPU_API_KEY not set. Add it to .env or export it.');
    process.exit(1);
  }

  const baseURL = process.env.ZAI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  const customFetch = createZaiFetch(apiKey, baseURL);
  const provider = new AnthropicProvider({ fetch: customFetch });

  return {
    provider,
    providerId: 'zai',
    label: `z.ai (${baseURL})`,
  };
}
