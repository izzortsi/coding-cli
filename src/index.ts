#!/usr/bin/env node
import dotenv from 'dotenv';
import { initProvider } from './auth.js';
import { startRepl } from './repl.js';
import { getAvailablePresets, getDefaultPreset, findPreset } from './presets.js';
import { listChannels, loadChannel } from './channel.js';
import { Engine } from './engine.js';
import { ToolRegistry } from './tools/registry.js';
import { buildBuiltinTools } from './tools/builtins.js';
import { DEFAULT_SYSTEM_PROMPT } from './prompts.js';

dotenv.config();

// --- Argument parsing for non-interactive mode ---

interface ParsedFlags {
  prompt: string | null;
  format: 'text' | 'json';
  quiet: boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = { prompt: null, format: 'text', quiet: false };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-p' || arg === '--prompt') {
      flags.prompt = args[++i] || null;
    } else if (arg === '-f' || arg === '--format') {
      const val = args[++i];
      if (val === 'json') flags.format = 'json';
      else if (val === 'text') flags.format = 'text';
      else {
        console.error(`Invalid format: "${val}". Must be "text" or "json".`);
        process.exit(1);
      }
    } else if (arg === '-q' || arg === '--quiet') {
      flags.quiet = true;
    }
  }

  return flags;
}

// --- Non-interactive single-turn execution ---

async function runSingleTurn(flags: ParsedFlags): Promise<void> {
  const promptText = flags.prompt!;
  const quiet = flags.quiet;
  const jsonOutput = flags.format === 'json';

  const auth = initProvider();

  const preset = getDefaultPreset('zai');
  if (!preset) {
    if (!quiet) console.error('No model presets available.');
    process.exit(1);
  }

  const projectRoot = process.cwd();

  const registry = new ToolRegistry();
  for (const tool of buildBuiltinTools(projectRoot)) registry.register(tool);

  const engine = new Engine(auth.provider, registry, {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxTokens: preset.maxTokens,
    temperature: preset.temperature,
    thinkingBudget: preset.thinkingBudget || undefined,
  });

  if (!quiet) {
    console.error(`Model: ${preset.displayName}`);
  }

  try {
    const result = await engine.turn(promptText, preset.modelId);

    if (jsonOutput) {
      const output = {
        text: result.finalText,
        toolCalls: result.toolCalls.map(tc => ({ name: tc.name, result: tc.result })),
        usage: result.usage,
      };
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else {
      process.stdout.write(result.finalText + '\n');
    }

    process.exit(0);
  } catch (err) {
    if (!quiet) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
    }
    if (jsonOutput) {
      const output = {
        text: '',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        error: err instanceof Error ? err.message : String(err),
      };
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
coding-cli — Interactive CLI for LLM conversations with tool use (z.ai)

Usage:
  coding-cli                        Start interactive REPL
  coding-cli -p "prompt"            Run a single turn and exit
  coding-cli -p "prompt" -f json    Output structured JSON
  coding-cli -p "prompt" -q         Suppress non-output messages
  coding-cli help                   Show this help

Flags (non-interactive mode):
  -p, --prompt "text"    Run a single turn with this prompt and exit
  -f, --format <fmt>     Output format: "text" (default) or "json" (only with -p)
  -q, --quiet            Suppress non-output messages (only with -p)

Environment:
  ZHIPU_API_KEY          z.ai API key (required)
  ZAI_BASE_URL           z.ai base URL (default: https://open.bigmodel.cn/api/paas/v4)
  CODING_CLI_DATA_DIR    Data directory (default: ~/.coding-cli)
`.trim());
    return;
  }

  // Check for non-interactive mode flags
  const flags = parseFlags(process.argv);
  if (flags.prompt !== null) {
    await runSingleTurn(flags);
    return;
  }

  // Validate that -f and -q are not used without -p
  if (flags.format === 'json' || flags.quiet) {
    console.error('Flags -f and -q are only valid with -p (non-interactive mode).');
    process.exit(1);
  }

  console.log('coding-cli v0.1.0\n');

  const auth = initProvider();
  console.log(`Auth: ${auth.label} [${auth.providerId}]`);

  const available = getAvailablePresets(new Set([auth.providerId]));
  if (available.length === 0) {
    console.error('No model presets available.');
    process.exit(1);
  }

  const initialPreset = getDefaultPreset('zai') || available[0];
  const projectRoot = process.cwd();

  // Try to resume most recent channel
  let resumeChannel = undefined;
  const channels = await listChannels();
  if (channels.length > 0) {
    const recent = channels[0];
    const preset = findPreset(recent.presetId);
    if (preset) {
      resumeChannel = await loadChannel(recent.id) || undefined;
      if (resumeChannel) {
        console.log(`Resuming: ${recent.name} (${recent.id}) · ${recent.messageCount} msgs`);
      }
    }
  }

  // Build providers map (single entry for z.ai)
  const providers = new Map<string, { provider: typeof auth.provider; label: string }>();
  providers.set(auth.providerId, { provider: auth.provider, label: auth.label });

  await startRepl({
    providers,
    initialPreset,
    projectRoot,
    resumeChannel: resumeChannel || undefined,
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
