import type { StagedWriteManager } from './tools/staged.js';
import type { StagedExecManager } from './tools/stagedExec.js';
import type { Provider, ApiMessage, TextContent } from './types.js';
import type { ModelPreset } from './presets.js';
import type { ChannelData } from './channel.js';
import type { SubagentManager } from './subagent.js';
import { getAvailablePresets, findPreset } from './presets.js';
import { AGENT_MODES, findMode as findAgentMode, type AgentMode } from './modes.js';
import { listChannels, relativeTime } from './channel.js';
import { getCompactionStats } from './compaction.js';
import { BOOTSTRAP_PROMPT } from './prompts.js';
import { buildBootstrapSteps, executeBootstrap } from './bootstrap.js';
import { rebuildSelf } from './selfAware.js';
import { pick } from './picker.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RESET, DIM, UI } from './ui/index.js';
import {
  setBlob,
  getBlob,
  listFields,
  getVanityName,
  getFunctionalRole,
  listReservedNames,
  type IdentityData,
} from './identity.js';

interface CustomCommand {
  description: string;
  prompt: string;
}

type CustomCommands = Record<string, CustomCommand>;

async function loadCustomCommands(projectRoot: string): Promise<CustomCommands | null> {
  try {
    const filePath = join(projectRoot, '.coding-cli', 'commands.json');
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as CustomCommands;
  } catch {
    return null;
  }
}

export interface CommandContext {
  staged: StagedWriteManager;
  stagedExec: StagedExecManager;
  get fastApprove(): boolean;
  setFastApprove: (value: boolean) => void;
  // Current state
  currentPreset: ModelPreset;
  systemPrompt: string;
  channel: ChannelData;
  // Available providers
  providers: Map<string, { provider: Provider; label: string }>;
  // Callbacks
  switchModel: (preset: ModelPreset) => void;
  agentMode: AgentMode;
  switchMode: (mode: AgentMode) => void;
  setSystemPrompt: (prompt: string) => void;
  newChannel: (name: string) => void;
  branchChannel: (name: string) => void;
  loadChannel: (id: string) => Promise<boolean>;
  compact: (keepRecent: number) => Promise<string>;
  getStateText: () => string;
  getContextInfo: () => string[];
  getMessages: () => ApiMessage[];
  projectRoot: string;
  /** Execute bootstrap and inject results into engine messages */
  runBootstrap: () => Promise<string>;
  subagents: SubagentManager;
  spawnSubagent: (name: string, task: string, timeoutMs?: number) => void;
  joinSubagent: (name: string) => Promise<string>;
  killSubagent: (name: string) => string;
  sendTurn: (text: string) => Promise<void>;
  /** Inject a user message into the conversation without triggering a model turn */
  injectUserMessage: (text: string) => void;
  showSidebar?: () => Promise<void>;
  /** coding-cli's own source root for self-modification */
  cliRoot: string;
  quit: () => void;
}

type CommandHandler = (args: string, ctx: CommandContext) => Promise<string | void>;

const commands: Record<string, CommandHandler> = {
  help: async (_args, ctx) => {
    const lines = [
      'Commands:',
      '  /help                    Show this help',
      '  /model [id]              Select model (interactive picker if no args)',
      '  /mode [name]             Switch agent mode (picker if no args)',
      '  /system <prompt>         Set system prompt',
      '  /new <name>              New empty channel',
      '  /branch <name>           New channel with current context',
      '  /load [id|name]          Switch channel (picker if no args)',
      '  /channel                 Switch channel (alias for /load)',
      '  /list                    List all channels',
      '  /compact [keep]          Compact older messages into summary (keep last N, default 20)',
      '  /info                    Show channel info and compaction stats',
      '  /bootstrap               Orient the model — scans project structure, key files',
      '  /state                   Show ephemeral state (what the model sees)',
      '  /history [n]             Show last n messages (default 10)',
      '  /spawn <name> <task>     Spawn background subagent (optional: --timeout <s>)',
      '  /agents                  List running/completed subagents',
      '  /join <name>             Wait for subagent, inject result + staged writes',
      '  /kill <name>             Abort a running subagent',
      '  /identity [sub]          Agent self-identity (list/get/set/clear/reserved)',
      '  /edit                    Compose message in $EDITOR',
      '  /edit system             Edit system prompt in $EDITOR',
      '  /paste                   Multi-line input mode (end with /end)',
      '  /fast                    Toggle fast-approve mode (Enter to approve all)',
      '  /approve [all|sel]       Approve all (all/empty) or one item by selector',
      '  /reject [all|sel]        Reject all (all/empty) or one item by selector',
      '  /files                   List pending staged writes',
      '  /commit [message]        Stage all changes and git commit (alias for /git commit)',
      '  /git status              Show git status',
      '  /git log [n]             Show last n commits (default 10)',
      '  /git diff                Show working tree diff',
      '  /git commit [message]    Stage all + commit (auto-generates message from diff)',
      '  /git branch <name> [src] Create branch (from src or current)',
      '  /git pr <base> [title]   Create PR to base branch (auto-generates title/body)',
      '  /rebuild                 Rebuild coding-cli after self-modification',
      '  /sidebar                 Open channel sidebar (same as Ctrl+B)',
      '  /quit                    Save and exit',
    ];

    const custom = await loadCustomCommands(ctx.projectRoot);
    if (custom) {
      const entries = Object.entries(custom);
      if (entries.length > 0) {
        lines.push('');
        lines.push('Custom commands:');
        for (const [cmdName, cmd] of entries) {
          // Extract placeholders to show usage hint
          const placeholders = cmd.prompt.match(/\{[^}]+\}/g);
          const argHint = placeholders
            ? ' ' + placeholders.map(p => `<${p.slice(1, -1)}>`).join(' ')
            : '';
          const padded = `  /${cmdName}${argHint}`.padEnd(27);
          lines.push(`${padded}${cmd.description}`);
        }
      }
    }

    lines.push('');
    lines.push('Keys:');
    lines.push('  Ctrl+B              Open channel sidebar');
    lines.push('  Ctrl+X Tab          Cycle agent mode');
    lines.push('  Ctrl+X E            Open $EDITOR with current line');
    lines.push('  Ctrl+C              Cancel line / interrupt turn');
    lines.push('  Ctrl+C Ctrl+C       Quit (within 1s)');

    return lines.join('\n');
  },

  model: async (args, ctx) => {
    // Direct model switch by id
    if (args.trim()) {
      const preset = findPreset(args.trim());
      if (!preset) return `Unknown model: ${args.trim()}. Use /model to see available models.`;
      if (!ctx.providers.has(preset.providerId)) {
        return `Provider "${preset.providerId}" not configured for ${preset.displayName}.`;
      }
      ctx.switchModel(preset);
      return undefined; // switchModel prints its own output
    }

    // Interactive picker
    const available = getAvailablePresets(new Set(ctx.providers.keys()));
    if (available.length === 0) return 'No models available.';

    const items = available.map((p, i) => ({
      label: `${i + 1}. ${p.displayName}`,
      value: p.id,
      detail: `${p.providerId} · ${(p.contextWindow / 1000).toFixed(0)}K ctx`,
      marker: p.id === ctx.currentPreset.id ? '(current)' : undefined,
    }));

    const selected = await pick(items, 'Select a model:');
    if (!selected) return undefined; // cancelled

    const preset = findPreset(selected);
    if (!preset) return 'Selection error.';
    if (preset.id === ctx.currentPreset.id) return `Already using ${preset.displayName}.`;

    ctx.switchModel(preset);
    return undefined;
  },

  mode: async (args, ctx) => {
    if (args.trim()) {
      const mode = findAgentMode(args.trim());
      if (!mode) return `Unknown mode: ${args.trim()}. Available: ${AGENT_MODES.map(m => m.id).join(', ')}`;
      if (mode.id === ctx.agentMode.id) return `Already in ${mode.displayName} mode.`;
      ctx.switchMode(mode);
      return undefined;
    }

    const items = AGENT_MODES.map((m, i) => ({
      label: `${i + 1}. ${m.displayName}`,
      value: m.id,
      detail: m.description,
      marker: m.id === ctx.agentMode.id ? '(current)' : undefined,
    }));

    const selected = await pick(items, 'Select a mode:');
    if (!selected) return undefined;

    const mode = findAgentMode(selected);
    if (!mode) return 'Selection error.';
    if (mode.id === ctx.agentMode.id) return `Already in ${mode.displayName} mode.`;

    ctx.switchMode(mode);
    return undefined;
  },

  new: async (args, ctx) => {
    const name = args.trim();
    if (!name) return 'Usage: /new <name>';
    ctx.newChannel(name);
    return undefined;
  },

  branch: async (args, ctx) => {
    const name = args.trim();
    if (!name) return 'Usage: /branch <name>';
    ctx.branchChannel(name);
    return undefined;
  },

  load: async (args, ctx) => {
    const sel = args.trim();

    if (sel) {
      // Direct load by id or name
      const ok = await ctx.loadChannel(sel);
      return ok ? undefined : `Channel not found: ${sel}`;
    }

    // Interactive picker
    const channels = await listChannels();
    if (channels.length === 0) return 'No saved channels.';

    const items = channels.map((ch, i) => ({
      label: `${i + 1}. ${ch.name} (${ch.id})`,
      value: ch.id,
      detail: `${ch.presetId} · ${ch.messageCount} msgs · ${relativeTime(ch.lastActivity)}`,
      marker: ch.id === ctx.channel.id ? '(current)' : undefined,
    }));

    const selected = await pick(items, 'Select a channel:');
    if (!selected) return undefined;
    if (selected === ctx.channel.id) return 'Already on this channel.';

    const ok = await ctx.loadChannel(selected);
    return ok ? undefined : 'Failed to load channel.';
  },

  list: async () => {
    const channels = await listChannels();
    if (channels.length === 0) return 'No saved channels.';
    return channels.map((ch, i) =>
      `  ${i + 1}. ${ch.name} (${ch.id}) · ${ch.presetId} · ${ch.messageCount} msgs · ${relativeTime(ch.lastActivity)}`
    ).join('\n');
  },

  channel: async (args, ctx) => commands.load(args, ctx),

  compact: async (args, ctx) => {
    const keepRecent = parseInt(args.trim(), 10) || 20;
    return ctx.compact(keepRecent);
  },

  info: async (_args, ctx) => {
    const stats = getCompactionStats(ctx.channel);
    const contextInfo = ctx.getContextInfo();
    const lines = [
      `Channel: ${ctx.channel.name} (${ctx.channel.id})`,
      `Model: ${ctx.currentPreset.displayName} (${ctx.currentPreset.providerId})`,
      `Messages: ${stats.activeMessages} active, ${stats.dormantMessages} dormant`,
      `Compactions: ${stats.compactionCount}`,
      `Est. active tokens: ~${(stats.estimatedActiveTokens / 1000).toFixed(1)}K`,
    ];
    if (contextInfo.length > 0) {
      lines.push('');
      lines.push(...contextInfo);
    }
    if (ctx.channel.compactionSummaries && ctx.channel.compactionSummaries.length > 0) {
      lines.push('');
      lines.push('Summaries:');
      for (let i = 0; i < ctx.channel.compactionSummaries.length; i++) {
        const preview = ctx.channel.compactionSummaries[i].substring(0, 100).replace(/\n/g, ' ');
        lines.push(`  ${i + 1}. ${preview}...`);
      }
    }
    return lines.join('\n');
  },

  bootstrap: async (_args, ctx) => {
    return ctx.runBootstrap();
  },

  state: async (_args, ctx) => {
    return ctx.getStateText();
  },

  history: async (args, ctx) => {
    const n = parseInt(args.trim(), 10) || 10;
    const messages = ctx.getMessages();
    const recent = messages.slice(-n);

    if (recent.length === 0) return 'No messages yet.';

    const lines: string[] = [];
    for (const msg of recent) {
      const role = msg.role === 'user' ? 'USER' : 'ASSISTANT';
      // Extract text content
      const textParts = msg.content
        .filter((b): b is TextContent => b.type === 'text')
        .map(b => b.text);
      const toolUses = msg.content.filter(b => b.type === 'tool_use');
      const toolResults = msg.content.filter(b => b.type === 'tool_result');

      let preview = textParts.join(' ').substring(0, 120).replace(/\n/g, ' ');
      if (toolUses.length > 0) preview += ` [${toolUses.length} tool call(s)]`;
      if (toolResults.length > 0) preview += ` [${toolResults.length} result(s)]`;
      if (!preview.trim()) preview = `[${msg.content.map(b => b.type).join(', ')}]`;

      lines.push(`  ${role}: ${preview}`);
    }

    const showing = recent.length < messages.length
      ? `Showing last ${recent.length} of ${messages.length} messages:`
      : `${messages.length} message(s):`;

    return `${showing}\n${lines.join('\n')}`;
  },

  spawn: async (args, ctx) => {
    // Parse optional --timeout <seconds> flag
    const timeoutMatch = args.match(/--timeout\s+(\d+)/);
    const timeoutMs = timeoutMatch ? parseInt(timeoutMatch[1], 10) * 1000 : undefined;
    const cleanArgs = args.replace(/--timeout\s+\d+/, '').trim();

    const spaceIdx = cleanArgs.indexOf(' ');
    if (spaceIdx <= 0) return 'Usage: /spawn <name> <task> [--timeout <seconds>]';
    const name = cleanArgs.substring(0, spaceIdx).trim();
    const task = cleanArgs.substring(spaceIdx + 1).trim();
    if (!name || !task) return 'Usage: /spawn <name> <task> [--timeout <seconds>]';
    try {
      ctx.spawnSubagent(name, task, timeoutMs);
      return undefined;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  agents: async (_args, ctx) => {
    const agents = ctx.subagents.list();
    if (agents.length === 0) return 'No subagents.';
    return agents.map(a => {
      const statusColor =
        a.status === 'running'   ? '\x1b[96m' :  // bright cyan
        a.status === 'completed' ? '\x1b[92m' :  // bright green
        '\x1b[91m';                               // bright red (failed/killed/timed_out)
      const statusGlyph =
        a.status === 'running'   ? '◆ running' :
        a.status === 'completed' ? '◆ done' :
        `◆ ${a.status}`;
      const tools = a.toolCalls.length > 0 ? ` · ${a.toolCalls.length} tools` : '';
      const staged = a.staged.list().length > 0 ? ` · ${a.staged.list().length} staged` : '';
      const elapsed = `${((Date.now() - a.startedAt) / 1000).toFixed(0)}s`;
      return `  ${statusColor}${statusGlyph}\x1b[0m  ${a.name}${tools}${staged} · ${elapsed} · ${a.channel.id}`;
    }).join('\n');
  },

  join: async (args, ctx) => {
    const name = args.trim();
    if (!name) return 'Usage: /join <name>';
    return ctx.joinSubagent(name);
  },

  kill: async (args, ctx) => {
    const name = args.trim();
    if (!name) return 'Usage: /kill <name>';
    return ctx.killSubagent(name);
  },

  system: async (args, ctx) => {
    if (!args.trim()) return `Current system prompt:\n${ctx.systemPrompt || '(none)'}`;
    ctx.setSystemPrompt(args.trim());
    return `System prompt updated.`;
  },

  approve: async (args, ctx) => {
    const sel = args.trim();
    const pendingWrites = ctx.staged.list();
    const pendingExecs = ctx.stagedExec.list();
    const totalCount = pendingWrites.length + pendingExecs.length;

    // empty or all = approve all immediately
    if (sel === 'all' || sel === '') {
      if (totalCount === 0) return 'Nothing pending.';
      const lines: string[] = [];

      if (pendingWrites.length > 0) {
        const results = await ctx.staged.approveAll();
        for (const r of results) {
          lines.push(r.success ? `Applied: ${r.filepath}` : `Failed (${r.token}): ${r.error}`);
        }
      }

      if (pendingExecs.length > 0) {
        const results = await ctx.stagedExec.approveAll();
        const execOutputs: string[] = [];
        for (const r of results) {
          if (r.success) {
            const entry = pendingExecs.find(e => e.token === r.token);
            const cmd = entry ? entry.command : r.token;
            const preview = (r.output || '').substring(0, 200).replace(/\n/g, ' ');
            console.log(`Executed: $ ${cmd}`);
            if (r.output) console.log(`  ${preview}${r.output!.length > 200 ? '...' : ''}`);
            execOutputs.push(`$ ${cmd}\n${r.output || '(no output)'}`);
          } else {
            execOutputs.push(`$ ???\nFailed: ${r.error}`);
          }
        }
        if (execOutputs.length > 0) {
          const appliedWritesForLabel = pendingWrites.filter(w => !ctx.staged.pendingWrites.has(w.token));
          const label = appliedWritesForLabel.length > 0 ? ' (other writes applied separately)' : '';
          await ctx.sendTurn(`[Staged execs approved and executed${label}]:\n${execOutputs.join('\n---\n')}`);
        }
      }

      const appliedWrites = pendingWrites.filter(w => !ctx.staged.pendingWrites.has(w.token));
      if (appliedWrites.length > 0) {
        const files = appliedWrites.map(w => w.filepath).join(', ');
        const label = pendingExecs.length > 0 ? ' (other execs completed separately)' : '';
        await ctx.sendTurn(`[Staged writes approved and applied${label}: ${files}]`);
      }
      return undefined;
    }

    if (totalCount === 0) return 'Nothing pending.';

    // Build combined list for display
    const allPending: Array<{ type: 'write'; entry: typeof pendingWrites[0] } | { type: 'exec'; entry: typeof pendingExecs[0] }> = [];
    for (const w of pendingWrites) allPending.push({ type: 'write', entry: w });
    for (const e of pendingExecs) allPending.push({ type: 'exec', entry: e });

    if (!sel && totalCount === 1) {
      const item = allPending[0];
      if (item.type === 'write') {
        const r = await ctx.staged.approve(item.entry.token);
        if (r.success) {
          console.log(`Applied: ${r.filepath}`);
          await ctx.sendTurn(`[Staged write approved and applied: ${r.filepath}]`);
          return undefined;
        }
        return `Failed: ${r.error}`;
      } else {
        console.log(`Executing: $ ${item.entry.command}`);
        const r = await ctx.stagedExec.approve(item.entry.token);
        if (r.success) {
          const msg = `[Staged exec approved and executed: $ ${item.entry.command}]\n${r.output || '(no output)'}`;
          await ctx.sendTurn(msg);
          return undefined;
        }
        return `Failed: ${r.error}`;
      }
    }

    if (!sel) {
      const lines = allPending.map((item, i) => {
        if (item.type === 'write') {
          const w = item.entry;
          return `  ${i + 1}. ${w.filepath} [write] token: ${w.token}`;
        } else {
          const e = item.entry;
          return `  ${i + 1}. $ ${e.command} [exec] token: ${e.token}`;
        }
      });
      return `Pending (${totalCount}):\n${lines.join('\n')}\n\nUse /approve <number|token|all>`;
    }

    // Try writes first, then execs
    const writeResult = await ctx.staged.approve(sel);
    if (writeResult.success) {
      console.log(`Applied: ${writeResult.filepath}`);
      await ctx.sendTurn(`[Staged write approved and applied: ${writeResult.filepath}]`);
      return undefined;
    }
    if (writeResult.error && !writeResult.error.startsWith('No staged write')) {
      return `Failed: ${writeResult.error}`;
    }

    const execResult = await ctx.stagedExec.approve(sel);
    if (execResult.success) {
      console.log(`Executed.`);
      const msg = `[Staged exec approved and executed]\n${execResult.output || '(no output)'}`;
      await ctx.sendTurn(msg);
      return undefined;
    }
    return execResult.error || `No pending item matching "${sel}"`;
  },

  apply: async (args, ctx) => commands.approve(args, ctx),

  reject: async (args, ctx) => {
    const sel = args.trim();
    const pendingWrites = ctx.staged.list();
    const pendingExecs = ctx.stagedExec.list();
    const totalCount = pendingWrites.length + pendingExecs.length;

    // . or empty = approve all (shortcut for single-keystroke approval)
    if (sel === 'all' || sel === '.' || totalCount === 0) {
      const wCount = ctx.staged.rejectAll();
      const eCount = ctx.stagedExec.rejectAll();
      const total = wCount + eCount;
      return total === 0 ? 'Nothing pending.' : `Rejected ${total} pending item(s) (${wCount} writes, ${eCount} execs).`;
    }

    if (!sel) {
      if (totalCount === 0) return 'Nothing pending.';
      if (totalCount === 1) {
        if (pendingWrites.length === 1) {
          ctx.staged.reject(pendingWrites[0].token);
          return `Rejected: ${pendingWrites[0].filepath}`;
        } else {
          ctx.stagedExec.reject(pendingExecs[0].token);
          return `Rejected: $ ${pendingExecs[0].command}`;
        }
      }
      const allPending: Array<{ type: 'write'; entry: typeof pendingWrites[0] } | { type: 'exec'; entry: typeof pendingExecs[0] }> = [];
      for (const w of pendingWrites) allPending.push({ type: 'write', entry: w });
      for (const e of pendingExecs) allPending.push({ type: 'exec', entry: e });
      const lines = allPending.map((item, i) => {
        if (item.type === 'write') {
          const w = item.entry;
          return `  ${i + 1}. ${w.filepath} [write] token: ${w.token}`;
        } else {
          const e = item.entry;
          return `  ${i + 1}. $ ${e.command} [exec] token: ${e.token}`;
        }
      });
      return `Pending (${totalCount}):\n${lines.join('\n')}\n\nUse /reject <number|token|all>`;
    }

    if (ctx.staged.reject(sel)) return 'Rejected.';
    if (ctx.stagedExec.reject(sel)) return 'Rejected.';
    return `No pending item matching "${sel}"`;
  },

  files: async (_args, ctx) => {
    const pendingWrites = ctx.staged.list();
    const pendingExecs = ctx.stagedExec.list();
    const totalCount = pendingWrites.length + pendingExecs.length;

    if (totalCount === 0) return 'Nothing pending.';

    const lines: string[] = [];
    if (pendingWrites.length > 0) {
      lines.push('Staged writes:');
      lines.push(...pendingWrites.map((w, i) =>
        `  ${i + 1}. ${w.filepath} [${w.mode}] token: ${w.token}`
      ));
    }
    if (pendingExecs.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Staged execs:');
      lines.push(...pendingExecs.map((e, i) =>
        `  ${pendingWrites.length + i + 1}. $ ${e.command} token: ${e.token}`
      ));
    }
    return lines.join('\n');
  },

  fast: async (_args, ctx) => {
    ctx.setFastApprove(!ctx.fastApprove);
    if (ctx.fastApprove) {
      return `${UI.danger}FAST${RESET} Fast-approve mode ON — press Enter to approve all staged items.\n${DIM}Use /fast to disable.${RESET}`;
    }
    return `${DIM}Fast-approve mode OFF — staged items require manual /approve.${RESET}`;
  },

  identity: async (args, ctx) => {
    const identity: IdentityData = ctx.channel.identity || (ctx.channel.identity = {});
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] || '';

    if (!sub || sub === 'list') {
      const fields = listFields(identity);
      if (fields.length === 0) return 'No identity fields defined. Use /identity set <field> <value> to create one.';

      const lines: string[] = ['Identity fields:'];
      for (const name of fields) {
        const f = identity[name];
        const info: string[] = [];
        if (f.blob !== null) {
          const preview = f.blob.length > 60 ? f.blob.substring(0, 57) + '...' : f.blob;
          info.push(`blob: "${preview}"`);
        }
        const sfCount = Object.keys(f.subfields).length;
        if (sfCount > 0) info.push(`${sfCount} subfield(s)`);
        if (f.schema) info.push(`schema(${f.schema.join(',')})`);
        const versionCount = f.blobVersions.length + f.schemaVersions.length;
        if (versionCount > 0) info.push(`${versionCount} version(s)`);
        lines.push(`  ${name}: ${info.join(' · ') || '(empty)'}`);
      }

      const vanity = getVanityName(identity);
      const role = getFunctionalRole(identity);
      if (vanity || role) {
        lines.push('');
        lines.push('Canonical:');
        if (vanity) lines.push(`  vanity_name: ${vanity}`);
        if (role) lines.push(`  functional_role: ${role}`);
      }

      return lines.join('\n');
    }

    if (sub === 'get') {
      const field = parts[1];
      if (!field) return 'Usage: /identity get <field>';
      const blob = getBlob(identity, field);
      if (blob === null) return `No identity field "${field}"`;
      return `${field}: ${blob}`;
    }

    if (sub === 'set') {
      const field = parts[1];
      if (!field) return 'Usage: /identity set <field> <value>';
      const value = parts.slice(2).join(' ');
      if (!value) return 'Usage: /identity set <field> <value>';
      const result = setBlob(identity, field, value);
      return result.ok ? result.message : `Error: ${result.message}`;
    }

    if (sub === 'clear') {
      const field = parts[1];
      if (!field) return 'Usage: /identity clear <field>';
      const result = setBlob(identity, field, '');
      return result.ok ? `Cleared "${field}" (archived to history)` : `Error: ${result.message}`;
    }

    if (sub === 'reserved') {
      const reserved = listReservedNames();
      const lines = ['Reserved names:'];
      lines.push('  System: ' + reserved.system.join(', '));
      for (const op of reserved.operator) {
        lines.push(`  Operator: "${op.name}" — ${op.reason}`);
      }
      return lines.join('\n');
    }

    return [
      'Usage: /identity [subcommand]',
      '  /identity              List all identity fields',
      '  /identity get <field>  Read a field',
      '  /identity set <field> <value>  Set a field',
      '  /identity clear <field>  Clear a field (archived)',
      '  /identity reserved     Show reserved names',
    ].join('\n');
  },

  sidebar: async (_args, ctx) => {
    // Delegate to context — the repl handles the actual sidebar display
    if (ctx.showSidebar) {
      await ctx.showSidebar();
    }
    return undefined;
  },

  commit: async (args, ctx) => commands.git(`commit ${args}`, ctx),

  git: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] || '';
    const subArgs = parts.slice(1).join(' ').trim();

    const git = (gitArgs: string[]): { ok: boolean; out: string } => {
      const r = spawnSync('git', gitArgs, { cwd: ctx.projectRoot, encoding: 'utf8', timeout: 10_000 });
      return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
    };

    const modelCall = async (prompt: string, system: string, maxTokens = 100): Promise<string> => {
      const provider = ctx.providers.get(ctx.currentPreset.providerId)?.provider;
      if (!provider) throw new Error('No provider available.');
      const response = await provider.chat(
        [{ role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] }],
        ctx.currentPreset.modelId, [],
        { systemPrompt: system, maxTokens, temperature: 0.3 },
      );
      return response.content.filter((b): b is TextContent => b.type === 'text').map(b => b.text).join('').trim();
    };

    switch (sub) {
      case 'status':
        return git(['status', '--short', '--branch']).out || 'Clean.';

      case 'log': {
        const n = parseInt(subArgs, 10) || 10;
        return git(['log', '--oneline', `-${n}`]).out;
      }

      case 'diff':
        return git(['diff', '--stat']).out || 'No changes.';

      case 'commit': {
        let message = subArgs;

        const add = git(['add', '-A']);
        if (!add.ok) return `git add failed: ${add.out}`;

        if (!message) {
          const stat = git(['diff', '--cached', '--stat']).out;
          if (!stat) return 'Nothing to commit — working tree clean.';

          const rawDiff = git(['diff', '--cached']).out;
          const diff = rawDiff.length > 20_000 ? rawDiff.substring(0, 20_000) + '\n\n[diff truncated]' : rawDiff;

          try {
            const generated = await modelCall(
              `Generate a concise git commit message for these changes. Return ONLY the commit message, nothing else.\n\n--- stat ---\n${stat}\n\n--- diff ---\n${diff}`,
              'You write concise git commit messages. Use conventional commit format (feat:, fix:, refactor:, etc). One line, max 72 chars. No quotes, no markdown, no explanation — just the message.',
            );
            message = generated.split('\n')[0];
            if (!message) return 'Failed to generate commit message — model returned empty.';
          } catch (err) {
            return `Failed to generate commit message: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        const commit = git(['commit', '-m', message]);
        if (!commit.ok) {
          if (commit.out.includes('nothing to commit')) return 'Nothing to commit — working tree clean.';
          return `git commit failed: ${commit.out}`;
        }
        return commit.out;
      }

      case 'branch': {
        if (!subArgs) return 'Usage: /git branch <name> [source]\n  Creates a new branch. Source defaults to current branch.';
        const branchParts = subArgs.split(/\s+/);
        const name = branchParts[0];
        const source = branchParts[1];
        const r = git(source ? ['checkout', '-b', name, source] : ['checkout', '-b', name]);
        return r.ok ? `Switched to new branch '${name}'` : `Failed: ${r.out}`;
      }

      case 'pr': {
        if (!subArgs) return 'Usage: /git pr <base-branch> [title]\n  Creates a PR from current branch to base. Auto-generates title/body if not given.';
        const prParts = subArgs.split(/\s+/);
        const baseBranch = prParts[0];
        let prTitle = prParts.slice(1).join(' ').trim();

        const currentBranch = git(['branch', '--show-current']).out;
        if (!currentBranch) return 'Could not determine current branch.';

        const commits = git(['log', `${baseBranch}..${currentBranch}`, '--oneline']).out;
        const stat = git(['diff', `${baseBranch}...${currentBranch}`, '--stat']).out;
        if (!commits && !stat) return `No changes between ${currentBranch} and ${baseBranch}.`;

        let prBody = '';
        try {
          const prompt = prTitle
            ? `Generate a PR body (description) for this PR titled "${prTitle}". Return ONLY the body text, in markdown.\n\n--- commits ---\n${commits}\n\n--- stat ---\n${stat}`
            : `Generate a PR title and body for these changes. Return the title on the first line, then a blank line, then the body in markdown. No prefix like "Title:" — just the raw title.\n\n--- commits ---\n${commits}\n\n--- stat ---\n${stat}`;

          const generated = await modelCall(
            prompt,
            'You write clear, concise PR titles and descriptions. Title: max 72 chars, no conventional commit prefix. Body: summarize what changed and why, use markdown.',
            500,
          );

          if (!prTitle) {
            const lines = generated.split('\n');
            prTitle = lines[0].trim();
            prBody = lines.slice(1).join('\n').trim();
          } else {
            prBody = generated;
          }
        } catch (err) {
          return `Failed to generate PR description: ${err instanceof Error ? err.message : String(err)}`;
        }

        if (!prTitle) return 'Failed to generate PR title.';

        const ghArgs = ['pr', 'create', '--base', baseBranch, '--title', prTitle];
        if (prBody) ghArgs.push('--body', prBody);

        const ghResult = spawnSync('gh', ghArgs, { cwd: ctx.projectRoot, encoding: 'utf8', timeout: 30_000 });
        if (ghResult.status !== 0) {
          return `gh pr create failed: ${((ghResult.stderr || '') + (ghResult.stdout || '')).trim()}\n\nMake sure the GitHub CLI (gh) is installed and authenticated.`;
        }
        return (ghResult.stdout || '').trim();
      }

      default:
        return [
          'Usage: /git <subcommand>',
          '  status              Show git status',
          '  log [n]             Show last n commits',
          '  diff                Show working tree diff stats',
          '  commit [message]    Stage all + commit (auto-generates message)',
          '  branch <name> [src] Create a new branch',
          '  pr <base> [title]   Create PR (auto-generates title/body)',
        ].join('\n');
    }
  },

  rebuild: async (_args, ctx) => {
    const result = rebuildSelf(ctx.cliRoot);
    if (result.success) {
      return `Build successful. Restart coding-cli to load changes.\n${result.output}`;
    }
    return `Build failed:\n${result.output}`;
  },

  quit: async (_args, ctx) => {
    ctx.quit();
  },
};

export async function handleCommand(input: string, ctx: CommandContext): Promise<string | void> {
  const trimmed = input.slice(1);
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx >= 0 ? trimmed.substring(0, spaceIdx) : trimmed;
  const args = spaceIdx >= 0 ? trimmed.substring(spaceIdx + 1) : '';

  const handler = commands[name];
  if (handler) return handler(args, ctx);

  // Try custom commands from .coding-cli/commands.json
  const custom = await loadCustomCommands(ctx.projectRoot);
  if (custom && custom[name]) {
    const cmd = custom[name];
    // Extract placeholder names in order
    const placeholderMatches = cmd.prompt.match(/\{[^}]+\}/g) || [];
    const placeholderNames = placeholderMatches.map(p => p.slice(1, -1));
    // Deduplicate while preserving order (same placeholder can appear multiple times)
    const uniquePlaceholders: string[] = [];
    const seen = new Set<string>();
    for (const ph of placeholderNames) {
      if (!seen.has(ph)) {
        uniquePlaceholders.push(ph);
        seen.add(ph);
      }
    }

    if (uniquePlaceholders.length === 0) {
      // No placeholders — send the prompt as-is (with any extra args appended)
      const prompt = args.trim() ? `${cmd.prompt} ${args.trim()}` : cmd.prompt;
      await ctx.sendTurn(prompt);
      return undefined;
    }

    // Split args to fill placeholders; last placeholder gets all remaining text
    const argParts = args.trim().split(/\s+/);
    if (!args.trim() || argParts.length < uniquePlaceholders.length) {
      const usage = uniquePlaceholders.map(p => `<${p}>`).join(' ');
      return `Usage: /${name} ${usage}\n  ${cmd.description}`;
    }

    // Map each unique placeholder to its value
    const values: Record<string, string> = {};
    for (let i = 0; i < uniquePlaceholders.length; i++) {
      if (i === uniquePlaceholders.length - 1) {
        // Last placeholder gets all remaining args
        values[uniquePlaceholders[i]] = argParts.slice(i).join(' ');
      } else {
        values[uniquePlaceholders[i]] = argParts[i];
      }
    }

    // Substitute all occurrences of each placeholder
    let expanded = cmd.prompt;
    for (const [ph, val] of Object.entries(values)) {
      expanded = expanded.split(`{${ph}}`).join(val);
    }

    await ctx.sendTurn(expanded);
    return undefined;
  }

  return `Unknown command: /${name}. Type /help for available commands.`;
}
