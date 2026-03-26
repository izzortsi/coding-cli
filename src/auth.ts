import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnthropicProvider } from './provider.js';
import { createOAuthFetch } from './oauthFetch.js';
import { createZaiFetch } from './zaiFetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.resolve(__dirname, '../scripts/auth_bridge.py');
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedToken: { value: string; expires: number } | null = null;

function getPythonCommand(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'pipe' });
      return cmd;
    } catch {}
  }
  return null;
}

function callBridge(pythonCmd: string, command: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(pythonCmd, [BRIDGE_PATH, command], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: any) {
    return { stdout: '', exitCode: err.status ?? 3 };
  }
}

function getOAuthToken(pythonCmd: string): string | null {
  if (cachedToken && Date.now() < cachedToken.expires) {
    return cachedToken.value;
  }

  const result = callBridge(pythonCmd, 'token');
  if (result.exitCode !== 0 || !result.stdout) return null;

  cachedToken = { value: result.stdout, expires: Date.now() + TOKEN_CACHE_TTL_MS };
  return result.stdout;
}

export interface DetectedProviders {
  providers: Map<string, { provider: AnthropicProvider; label: string }>;
  defaultId: string;
}

export function detectAuth(): DetectedProviders | null {
  const providers = new Map<string, { provider: AnthropicProvider; label: string }>();

  // Try OAuth first
  const pythonCmd = getPythonCommand();
  if (pythonCmd) {
    const token = getOAuthToken(pythonCmd);
    if (token) {
      const oauthFetch = createOAuthFetch(() => getOAuthToken(pythonCmd));
      providers.set('anthropic', {
        provider: new AnthropicProvider({ fetch: oauthFetch }),
        label: 'OAuth (Claude Pro/Max)',
      });
    }
  }

  // Try API key (only if OAuth not already set up)
  if (!providers.has('anthropic') && process.env.ANTHROPIC_API_KEY) {
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    providers.set('anthropic', {
      provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL }),
      label: `API key${baseURL ? ` (${baseURL})` : ''}`,
    });
  }

  // z.ai (OpenAI-compatible — needs fetch translation layer)
  if (process.env.ZHIPU_API_KEY) {
    const baseURL = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/coding/paas/v4';
    const zaiFetch = createZaiFetch(process.env.ZHIPU_API_KEY, baseURL);
    providers.set('zai', {
      provider: new AnthropicProvider({ fetch: zaiFetch }),
      label: `z.ai (${baseURL})`,
    });
  }

  if (providers.size === 0) return null;
  const defaultId = providers.keys().next().value!;
  return { providers, defaultId };
}

export async function runOAuthLogin(): Promise<void> {
  const pythonCmd = getPythonCommand();
  if (!pythonCmd) {
    console.error('Python 3 required for OAuth. Install Python or use ANTHROPIC_API_KEY instead.');
    process.exit(1);
  }

  const { execFileSync: exec } = await import('node:child_process');
  exec(pythonCmd, [BRIDGE_PATH, 'login'], { stdio: 'inherit' });
}

export async function runOAuthLogout(): Promise<void> {
  const pythonCmd = getPythonCommand();
  if (!pythonCmd) {
    console.error('Python 3 not found.');
    process.exit(1);
  }
  const result = callBridge(pythonCmd, 'logout');
  console.log(result.stdout || 'Tokens cleared.');
}
