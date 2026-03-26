import readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { Provider, ApiMessage, MessageContent, TextContent, ThinkingContent, ToolResultContent } from './types.js';
import type { ModelPreset } from './presets.js';
import { findPreset } from './presets.js';
import { Engine } from './engine.js';
import { ToolRegistry } from './tools/registry.js';
import { buildBuiltinTools } from './tools/builtins.js';
import { StagedWriteManager } from './tools/staged.js';
import { StagedExecManager } from './tools/stagedExec.js';
import { handleCommand, type CommandContext } from './commands.js';
import {
  createChannel,
  branchChannel as branchChannelData,
  saveChannel,
  loadChannel as loadChannelData,
  loadChannelByName,
  type ChannelData,
} from './channel.js';
import { compactChannel, buildEffectiveSystemPrompt } from './compaction.js';
import { FileTracker } from './fileTracking.js';
import { createContextUsage, recordTurn, getContextStats, formatContextBar, formatContextInfo } from './context.js';
import { collectStateText, type StateContext } from './state.js';
import { openEditor } from './editor.js';
import { SubagentManager } from './subagent.js';
import { buildSubagentTool } from './tools/subagentTool.js';
import { buildIdentityTool } from './tools/identityTool.js';
import { buildDismissTools } from './tools/dismissTool.js';
import { loadScriptTools } from './tools/scriptRegistry.js';
import { DEFAULT_SYSTEM_PROMPT } from './prompts.js';
import { buildBootstrapSteps, executeBootstrap } from './bootstrap.js';
import { getCliRoot } from './selfAware.js';
import { type AgentMode, DEFAULT_MODE, findMode as findAgentMode, getNextMode, AGENT_MODES } from './modes.js';
import path from 'node:path';
import {
  RESET, BOLD, DIM, FG, UI, ROLE, BOX, fg256,
  Spinner,
  renderMarkdown,
  renderThinkingBlock,
  renderToolCalls,
  renderUsage,
  renderUsageFooter,
  renderStagedNotice,
  renderWelcome,
  StreamRenderer,
  getToolIcon,
  showChannelSidebar,
} from './ui/index.js';

export interface ReplOptions {
  providers: Map<string, { provider: Provider; label: string }>;
  initialPreset: ModelPreset;
  projectRoot: string;
  systemPrompt?: string;
  resumeChannel?: ChannelData;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  let currentPreset = opts.initialPreset;
  let systemPrompt = opts.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  let running = true;
  let turnInProgress = false;
  let turnAbortController: AbortController | null = null;
  let lastCtrlC = 0;
  let currentMode: AgentMode = DEFAULT_MODE;
  let fastApprove = false;

  // Self-awareness — detect coding-cli's own source root
  const cliRoot = getCliRoot();

  // Set up tools
  const registry = new ToolRegistry();
  const staged = new StagedWriteManager(opts.projectRoot);
  const stagedExec = new StagedExecManager(opts.projectRoot);
  for (const tool of buildBuiltinTools(opts.projectRoot, cliRoot)) registry.register(tool);
  for (const tool of staged.getTools()) registry.register(tool);
  for (const tool of stagedExec.getTools()) registry.register(tool);

  // run_subagent tool — model can spawn subagents from the tool loop
  const subagentTool = buildSubagentTool(
    opts.projectRoot,
    () => opts.providers.get(currentPreset.providerId)!.provider,
    () => currentPreset,
    staged,
    (agentType, toolName) => {
      // Show subagent tool progress inline
      spinner.pause();
      process.stdout.write(`  ${DIM}[${agentType}]${RESET} ${FG.gray}${BOX.arrow} ${toolName}${RESET}\n`);
      spinner.resume();
    },
  );
  registry.register(subagentTool);

  // Self-identity tool (registered after channel setup below, but tool ref created now)
  // Uses a getter so it always reads from the current channel
  const identityTool = buildIdentityTool(() => {
    if (!channel.identity) channel.identity = {};
    return channel.identity;
  });
  registry.register(identityTool);

  // Dismiss tools — model can free context by dismissing stale tool results
  for (const tool of buildDismissTools(
    () => engine.messages,
    (filePath: string) => {
      const entry = fileTracker.tracked.get(filePath);
      return entry ? entry.contentHash : null;
    },
  )) {
    registry.register(tool);
  }

  // Apply initial mode filter
  registry.setToolFilter(currentMode.excludeTools);

  // Set up channel
  let channel: ChannelData = opts.resumeChannel
    || createChannel('default', currentPreset.id, systemPrompt);

  // If resuming, restore preset from channel
  if (opts.resumeChannel) {
    const restored = findPreset(opts.resumeChannel.presetId);
    if (restored && opts.providers.has(restored.providerId)) {
      currentPreset = restored;
      systemPrompt = opts.resumeChannel.systemPrompt;
    }
  }

  // Resolve provider
  const initialProvider = opts.providers.get(currentPreset.providerId)!.provider;

  // File tracking
  const fileTracker = new FileTracker();
  if (channel.trackedFiles) fileTracker.fromJSON(channel.trackedFiles);

  // Context tracking
  const contextUsage = channel.contextUsage || createContextUsage();

  // State context helper
  function getStateCtx(): StateContext {
    return {
      channel,
      fileTracker,
      staged,
      contextUsage,
      contextLimit: currentPreset.contextWindow,
      model: currentPreset.modelId,
      agentMode: currentMode.id,
      tools: registry.getDefinitions(),
      cliRoot,
      get fastApprove() { return fastApprove; },
    };
  }

  // Set up engine with all hooks
  const engine = new Engine(initialProvider, registry, {
    systemPrompt,
    maxTokens: currentPreset.maxTokens,
    temperature: currentPreset.temperature,
    thinkingBudget: currentPreset.thinkingBudget,
    hooks: {
      onBeforeApiCall: async (messages: ApiMessage[]): Promise<ApiMessage[]> => {
        // Hot-reload script tools from .coding-cli/tools.json before every API call.
        // Errors are logged but don't abort the turn.
        try {
          const scriptTools = await loadScriptTools(opts.projectRoot);
          registry.unregisterScriptTools();
          for (const tool of scriptTools) registry.registerScriptTool(tool);
        } catch (err: any) {
          process.stderr.write(`[coding-cli] script registry error: ${err.message}\n`);
        }

        // Inject compaction summaries into system prompt
        engine.config.systemPrompt = buildEffectiveSystemPrompt(systemPrompt, channel) + currentMode.promptAddendum;

        // Slice dormant messages
        const dormantBefore = channel.dormantBefore || 0;
        let active = dormantBefore > 0 && messages.length > dormantBefore
          ? messages.slice(dormantBefore)
          : messages;

        // Inject ephemeral state into the last text-bearing user message
        const stateText = collectStateText(getStateCtx());
        const lastTextUserIdx = findLastTextUserIndex(active);
        if (lastTextUserIdx >= 0) {
          const msg = active[lastTextUserIdx];
          active = [...active];
          active[lastTextUserIdx] = {
            ...msg,
            content: [{ type: 'text', text: stateText } as TextContent, ...msg.content],
          };
        }

        // Tag the last few undismissed tool_result blocks with cache_control for billing optimization.
        // API allows max 4 cache_control blocks, so only tag the most recent ones.
        // Clone affected messages so cache_control doesn't persist on engine.messages.
        const MAX_CACHE_BLOCKS = 4;
        const toolResultPositions: { msgIdx: number; blockIdx: number }[] = [];
        for (let m = 0; m < active.length; m++) {
          const msg = active[m];
          if (msg.role !== 'user') continue;
          for (let b = 0; b < msg.content.length; b++) {
            const block = msg.content[b];
            if (block.type === 'tool_result') {
              const tr = block as ToolResultContent;
              if (!tr.content.startsWith('[Dismissed:')) {
                toolResultPositions.push({ msgIdx: m, blockIdx: b });
              }
            }
          }
        }

        const toTag = toolResultPositions.slice(-MAX_CACHE_BLOCKS);
        const msgIndicesToClone = new Set(toTag.map(p => p.msgIdx));
        for (const msgIdx of msgIndicesToClone) {
          active[msgIdx] = { ...active[msgIdx], content: [...active[msgIdx].content] };
        }
        for (const pos of toTag) {
          const tr = active[pos.msgIdx].content[pos.blockIdx] as ToolResultContent;
          active[pos.msgIdx].content[pos.blockIdx] = { ...tr, cache_control: { type: 'ephemeral' } };
        }

        return active;
      },

      onAfterToolResult: (toolName: string, result: string): void => {
        // Pause spinner so its interval doesn't overwrite the tool result line
        spinner.pause();
        const isError = result.startsWith('Error');
        const status = isError ? `${UI.danger}${BOX.cross}${RESET}` : `${UI.success}${BOX.check}${RESET}`;
        const toolIcon = getToolIcon(toolName);
        const preview = result.substring(0, 60).replace(/\n/g, ' ');
        process.stdout.write(`  ${status} ${toolIcon} ${FG.white}${toolName}${RESET} ${DIM}${preview}${RESET}\n`);
        spawn('sh', ['-c', 'paplay --volume=39321 /usr/share/sounds/freedesktop/stereo/device-added.oga 2>/dev/null || printf "\\a"'], { stdio: 'ignore' }).unref();
        spinner.resume();

        // Track files read by read_file tool
        if (toolName === 'read_file') {
          // Extract file path from the tool result (it's the arg, but we don't have it here)
          // Instead, track from the most recent tool_use block
          const lastMsg = engine.messages[engine.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            for (const block of lastMsg.content) {
              if (block.type === 'tool_use' && (block as any).name === 'read_file') {
                const filePath = (block as any).input?.file_path as string;
                if (filePath) {
                  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(opts.projectRoot, filePath);
                  fileTracker.trackFile(resolved).catch(() => {});
                }
              }
            }
          }
        }
      },

      onTurnComplete: (turnResult): void => {
        recordTurn(
          contextUsage,
          turnResult.usage.inputTokens,
          turnResult.usage.outputTokens,
          turnResult.lastCallInputTokens,
        );
      },

      // Streaming hooks
      onStreamStart: (): void => {
        spinner.stop();
        assistantLabelShown = true;
        streamRenderer = new StreamRenderer();
        streamingActive = true;
      },
      onTextDelta: (text: string): void => {
        if (streamRenderer) streamRenderer.write(text);
      },
      onThinkingDelta: (_text: string): void => {
        // Thinking deltas are not streamed to terminal — shown in summary
      },
      onStreamEnd: (): void => {
        if (streamRenderer) {
          streamRenderer.flush();
          streamRenderer = null;
        }
        streamingActive = false;
      },
    },
  });
  engine.messages = [...channel.messages];

  // Spinner & stream state
  const spinner = new Spinner();
  let streamRenderer: StreamRenderer | null = null;
  let streamingActive = false;
  let assistantLabelShown = false;

  // Subagent manager with progress streaming to terminal
  const subagentManager = new SubagentManager(opts.projectRoot, (progress) => {
    const prefix = `${DIM}[${FG.cyan}${progress.agentName}${RESET}${DIM}]${RESET}`;
    switch (progress.event) {
      case 'tool_call':
        process.stdout.write(`\r\x1b[2K${prefix} ${FG.gray}${BOX.arrow} ${progress.detail}${RESET}\n`);
        break;
      case 'done':
        process.stdout.write(`\r\x1b[2K${prefix} ${UI.success}${BOX.check} done${RESET}\n`);
        break;
      case 'error':
        process.stdout.write(`\r\x1b[2K${prefix} ${UI.danger}${BOX.cross} ${progress.detail}${RESET}\n`);
        break;
      case 'killed':
        process.stdout.write(`\r\x1b[2K${prefix} ${UI.warning}${BOX.cross} killed${RESET}\n`);
        break;
      case 'timed_out':
        process.stdout.write(`\r\x1b[2K${prefix} ${UI.warning}${BOX.cross} timed out${RESET}\n`);
        break;
    }
  });

  // Readline — Ctrl+C handled manually via SIGINT, not by readline
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Prevent readline from exiting on Ctrl+C — we handle it ourselves
  rl.on('SIGINT', () => {
    // Emit to process so our handler below runs
    process.emit('SIGINT' as any);
  });

  rl.on('close', () => {
    if (running) {
      running = false;
      syncChannelFromEngine();
      saveChannel(channel).catch(() => {});
      console.log(`\n${DIM}Saved. Goodbye.${RESET}`);
      process.exit(0);
    }
  });

  // --- Ctrl+C handling ---
  // First Ctrl+C: cancel current line (or interrupt turn)
  // Second Ctrl+C within 1s: quit
  process.on('SIGINT', () => {
    const now = Date.now();

    if (turnInProgress) {
      // Abort the in-flight API call and tool execution
      turnAbortController?.abort();
      spinner.stop();
      turnInProgress = false;
      console.log(`\n${UI.warning}Interrupted.${RESET}`);
      prompt();
      return;
    }

    if (now - lastCtrlC < 1500) {
      // Double Ctrl+C — quit
      syncChannelFromEngine();
      saveChannel(channel).catch(() => {});
      console.log(`\n${DIM}Saved. Goodbye.${RESET}`);
      process.exit(0);
    }

    lastCtrlC = now;
    // Clear the current line and show hint
    process.stdout.write('\r\x1b[2K');
    console.log(`${DIM}Press Ctrl+C again to quit${RESET}`);
    prompt();
  });

  // --- Ctrl+B keybinding (channel sidebar) ---
  async function openSidebar(): Promise<void> {
    if (turnInProgress || streamingActive) return;

    // Pause readline so sidebar gets raw stdin
    rl.pause();
    const selected = await showChannelSidebar(channel.id);
    rl.resume();

    if (selected && selected !== channel.id) {
      await switchToChannel(selected);
    }
  }

  // --- Ctrl+X E keybinding (open $EDITOR) ---
  if (process.stdin.isTTY) {
    process.stdin.on('keypress', (_str: string, key: readline.Key) => {
      // Ctrl+B — channel sidebar
      if (key && key.ctrl && key.name === 'b' && !turnInProgress && !streamingActive) {
        openSidebar().then(() => prompt());
        return;
      }

      if (key && key.ctrl && key.name === 'x') {
        // Set flag for next keypress
        (rl as any)._ctrlXPending = true;
        return;
      }
      if ((rl as any)._ctrlXPending && key && key.name === 'e') {
        (rl as any)._ctrlXPending = false;
        // Get current line text
        const currentLine = (rl as any).line || '';
        // Clear the current line
        (rl as any).line = '';
        (rl as any).cursor = 0;
        process.stdout.write('\r\x1b[2K');

        const content = openEditor(currentLine);
        if (content) {
          // Feed the content back as if the user typed it
          (rl as any).line = content;
          (rl as any).cursor = content.length;
          // Trigger the line event
          rl.write(null, { name: 'return' } as any);
        } else {
          prompt();
        }
        return;
      }
      if ((rl as any)._ctrlXPending && key && key.name === 'tab') {
        (rl as any)._ctrlXPending = false;
        const next = getNextMode(currentMode.id);
        switchMode(next);
        process.stdout.write('\r\x1b[2K');
        prompt();
        return;
      }
      (rl as any)._ctrlXPending = false;
    });
  }

  function syncChannelFromEngine(): void {
    channel.messages = [...engine.messages];
    channel.presetId = currentPreset.id;
    channel.systemPrompt = systemPrompt;
    channel.lastActivity = Date.now();
    channel.trackedFiles = fileTracker.toJSON();
    channel.contextUsage = contextUsage;
  }

  function switchMode(mode: AgentMode): void {
    currentMode = mode;
    registry.setToolFilter(mode.excludeTools);
    console.log(`${currentMode.color}${BOX.bullet}${RESET} Mode: ${BOLD}${mode.displayName}${RESET} ${DIM}${mode.description}${RESET}`);
  }

  function switchModel(preset: ModelPreset): void {
    const entry = opts.providers.get(preset.providerId);
    if (!entry) {
      console.log(`${UI.danger}Provider "${preset.providerId}" not configured.${RESET}`);
      return;
    }

    currentPreset = preset;
    engine.provider = entry.provider;
    engine.config.maxTokens = preset.maxTokens;
    engine.config.temperature = preset.temperature;
    engine.config.thinkingBudget = preset.thinkingBudget;

    console.log(`${UI.success}${BOX.check}${RESET} Switched to ${BOLD}${preset.displayName}${RESET} ${DIM}(${preset.providerId})${RESET}`);
  }

  function newChannel(name: string): void {
    syncChannelFromEngine();
    saveChannel(channel).catch(() => {});

    channel = createChannel(name, currentPreset.id, systemPrompt);
    engine.messages = [];
    staged.pendingWrites.clear();
    stagedExec.pendingExecs.clear();

    console.log(`${UI.success}${BOX.check}${RESET} New channel: ${BOLD}${name}${RESET} ${DIM}(${channel.id})${RESET}`);
    saveChannel(channel).catch(() => {});
  }

  function branchChannel(name: string): void {
    syncChannelFromEngine();
    saveChannel(channel).catch(() => {});

    channel = branchChannelData(name, channel, currentPreset.id);
    engine.messages = [...channel.messages];
    staged.pendingWrites.clear();
    stagedExec.pendingExecs.clear();

    console.log(`${UI.success}${BOX.check}${RESET} Branched: ${BOLD}${name}${RESET} ${DIM}(${channel.id}) · ${channel.messages.length} messages carried${RESET}`);
    saveChannel(channel).catch(() => {});
  }

  async function switchToChannel(id: string): Promise<boolean> {
    let loaded = await loadChannelData(id);
    if (!loaded) loaded = await loadChannelByName(id);
    if (!loaded) return false;

    syncChannelFromEngine();
    await saveChannel(channel);

    channel = loaded;
    engine.messages = [...channel.messages];
    systemPrompt = channel.systemPrompt;
    engine.config.systemPrompt = systemPrompt;
    staged.pendingWrites.clear();
    stagedExec.pendingExecs.clear();

    const restored = findPreset(channel.presetId);
    if (restored && opts.providers.has(restored.providerId)) {
      currentPreset = restored;
      engine.provider = opts.providers.get(restored.providerId)!.provider;
      engine.config.maxTokens = restored.maxTokens;
      engine.config.temperature = restored.temperature;
      engine.config.thinkingBudget = restored.thinkingBudget;
    }

    console.log(`${UI.success}${BOX.check}${RESET} Loaded: ${BOLD}${channel.name}${RESET} ${DIM}(${channel.id}) · ${channel.messages.length} messages · ${currentPreset.displayName}${RESET}`);
    return true;
  }

  const commandCtx: CommandContext = {
    staged,
    stagedExec,
    get fastApprove() { return fastApprove; },
    setFastApprove: (value: boolean) => { fastApprove = value; },
    providers: opts.providers,
    get currentPreset() { return currentPreset; },
    get systemPrompt() { return systemPrompt; },
    get channel() { return channel; },
    switchModel,
    get agentMode() { return currentMode; },
    switchMode,
    setSystemPrompt: (p) => {
      systemPrompt = p;
      engine.config.systemPrompt = p;
    },
    newChannel,
    branchChannel,
    loadChannel: switchToChannel,
    compact: async (keepRecent: number): Promise<string> => {
      syncChannelFromEngine();

      try {
        const provider = opts.providers.get(currentPreset.providerId)!.provider;
        spinner.start('compacting');
        const result = await compactChannel(channel, provider, currentPreset.modelId, keepRecent);
        spinner.stop();

        await saveChannel(channel);

        return [
          `${UI.success}${BOX.check}${RESET} Compacted ${BOLD}${result.compactedCount}${RESET} messages, kept ${result.preservedCount}`,
          `${DIM}Estimated tokens saved: ~${(result.estimatedTokensSaved / 1000).toFixed(1)}K${RESET}`,
          `${DIM}Summary length: ${result.summary.length} chars${RESET}`,
        ].join('\n');
      } catch (err) {
        spinner.stop();
        return `${UI.danger}${BOX.cross}${RESET} ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    getStateText: () => collectStateText(getStateCtx()),
    getContextInfo: () => formatContextInfo(getContextStats(contextUsage, currentPreset.contextWindow)),
    getMessages: () => engine.messages,
    subagents: subagentManager,
    spawnSubagent: (name: string, task: string, timeoutMs?: number): void => {
      syncChannelFromEngine();
      const provider = opts.providers.get(currentPreset.providerId)!.provider;
      subagentManager.spawn(name, task, channel, provider, currentPreset, systemPrompt, timeoutMs);
      const timeoutNote = timeoutMs === 0 ? 'no timeout' : `timeout ${((timeoutMs ?? 300_000) / 1000).toFixed(0)}s`;
      console.log(`${UI.success}${BOX.check}${RESET} Spawned subagent ${BOLD}${name}${RESET} ${DIM}(${timeoutNote}) — /agents to check, /join ${name} to collect${RESET}`);
    },
    joinSubagent: async (name: string): Promise<string> => {
      const handle = subagentManager.get(name);
      if (!handle) return `No subagent named "${name}". Use /agents to see all.`;

      if (handle.status === 'running') {
        spinner.start(`waiting for ${name}`);
        await subagentManager.join(name);
        spinner.stop();
      }

      // Merge subagent staged writes into parent staged manager
      const subStagedWrites = handle.staged.list();
      if (subStagedWrites.length > 0) {
        for (const w of subStagedWrites) {
          staged.pendingWrites.set(w.token, w);
        }
      }

      const resultText = subagentManager.formatResult(handle);

      // Inject result into parent conversation
      engine.messages.push({
        role: 'user',
        content: [{ type: 'text', text: resultText } as TextContent],
      });

      subagentManager.remove(name);

      const stagedNote = subStagedWrites.length > 0
        ? `\n${UI.warning}${BOX.arrow}${RESET} ${subStagedWrites.length} staged write(s) from ${name} merged — use /files to review`
        : '';

      return `${UI.success}${BOX.check}${RESET} Injected result from ${BOLD}${name}${RESET} into conversation.${stagedNote}\n${DIM}Channel: ${handle.channel.name} (${handle.channel.id})${RESET}`;
    },
    killSubagent: (name: string): string => {
      const ok = subagentManager.kill(name);
      return ok
        ? `${UI.warning}${BOX.cross}${RESET} Killed subagent ${BOLD}${name}${RESET}`
        : `No running subagent named "${name}".`;
    },
    sendTurn: async (text: string): Promise<void> => { await sendTurn(text); },
    injectUserMessage: (text: string): void => {
      engine.messages.push({ role: 'user', content: [{ type: 'text', text } as TextContent] });
      syncChannelFromEngine();
      saveChannel(channel).catch(() => {});
    },
    showSidebar: async (): Promise<void> => { await openSidebar(); },
    projectRoot: opts.projectRoot,
    cliRoot,
    runBootstrap: async (): Promise<string> => {
      spinner.start('bootstrapping');

      const steps = await buildBootstrapSteps(opts.projectRoot);
      if (steps.length === 0) {
        spinner.stop();
        return `${UI.warning}No bootstrap steps found for this project.${RESET}`;
      }

      const messages = await executeBootstrap(steps, registry, (step, total, desc) => {
        spinner.update(`bootstrap ${step}/${total}: ${desc}`);
      });

      spinner.stop();

      // Inject bootstrap messages into engine
      for (const msg of messages) {
        engine.messages.push(msg);
      }

      // Track files that were read during bootstrap
      for (const msg of messages) {
        if (msg.role === 'assistant') {
          for (const block of msg.content) {
            if (block.type === 'tool_use' && (block as any).name === 'read_file') {
              const filePath = (block as any).input?.file_path as string;
              if (filePath) {
                const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(opts.projectRoot, filePath);
                fileTracker.trackFile(resolved).catch(() => {});
              }
            }
          }
        }
      }

      // Auto-save
      syncChannelFromEngine();
      saveChannel(channel).catch(() => {});

      // Count what was injected
      const toolCount = steps.length;
      const trackedCount = fileTracker.tracked.size;

      return [
        `${UI.success}${BOX.check}${RESET} Bootstrap complete`,
        `${DIM}${toolCount} tool calls executed · ${trackedCount} files tracked${RESET}`,
        `${DIM}Context injected — the model now has project awareness.${RESET}`,
        `${DIM}Send a message to start working.${RESET}`,
      ].join('\n');
    },
    quit: () => {
      syncChannelFromEngine();
      saveChannel(channel).catch(() => {});
      console.log(`\n${DIM}Saved channel ${channel.name}. Goodbye.${RESET}\n`);
      running = false;
      rl.close();
    },
  };

  async function sendTurn(text: string): Promise<void> {
    turnInProgress = true;
    assistantLabelShown = false;
    turnAbortController = new AbortController();
    const wasStreamed = !!engine.provider.chatStream;
    try {
      spinner.start('thinking');

      const result = await engine.turn(text, currentPreset.modelId, turnAbortController.signal);
      spinner.stop();

      // If streaming was used, the onStreamStart/onTextDelta/onStreamEnd hooks
      // already rendered the assistant label and text. We only need to show
      // tool calls and the non-streamed parts.
      if (!wasStreamed) {
        // Thinking blocks (only shown in non-streaming mode)
        for (const msg of result.messages) {
          if (msg.role === 'assistant') {
            for (const block of msg.content) {
              if (block.type === 'thinking' && (block as ThinkingContent).thinking) {
                console.log(renderThinkingBlock((block as ThinkingContent).thinking));
              }
            }
          }
        }
      }

      // Tool calls (shown in both modes)
      if (result.toolCalls.length > 0) {
        console.log(renderToolCalls(result.toolCalls));
      }

      // Response text (only in non-streaming mode — streaming already rendered it)
      if (!wasStreamed && result.finalText) {
        console.log(renderMarkdown(result.finalText));
      }

      // Staged writes — full-width colored bar + audio notification
      const pendingWrites = staged.list();
      const pendingExecs = stagedExec.list();
      const totalPending = pendingWrites.length + pendingExecs.length;
      if (totalPending > 0) {
        const cols = process.stdout.columns || 80;
        console.log(renderStagedNotice(totalPending, cols));
        process.stdout.write('\x07'); // terminal bell — approval needed
      }

      // Usage + context bar — right-aligned
      const usageLine = renderUsage(result.usage);
      const stats = getContextStats(contextUsage, currentPreset.contextWindow);
      const ctxBar = stats.turnCount > 0 ? formatContextBar(stats) : '';
      const cols = process.stdout.columns || 80;
      console.log(renderUsageFooter(usageLine, ctxBar, cols));

      // Turn-complete sound — distinct from per-tool beeps
      spawn('sh', ['-c', 'paplay /usr/share/sounds/freedesktop/stereo/message-new-instant.oga 2>/dev/null || printf "\\a"'], { stdio: 'ignore' }).unref();

      // Auto-save
      syncChannelFromEngine();
      saveChannel(channel).catch(() => {});
    } catch (err) {
      spinner.stop();
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && (err as any).cause instanceof Error
        ? `\n  ${DIM}cause: ${(err as any).cause.message}${RESET}`
        : '';
      console.error(`\n  ${UI.danger}${BOX.cross} Error:${RESET} ${msg}${cause}`);
    } finally {
      turnInProgress = false;
    }
  }

  function getPrompt(): string {
    const preset = `${fg256(75)}${currentPreset.id}${RESET}`;
    const ch = `${FG.gray}${channel.name}${RESET}`;
    const mode = `${currentMode.color}${currentMode.id}${RESET}`;
    const fast = fastApprove ? ` ${UI.danger}FAST${RESET}` : '';
    return `${preset} ${DIM}${BOX.dot}${RESET} ${ch} ${DIM}${BOX.dot}${RESET} ${mode}${fast} ${FG.brightCyan}❯${RESET} `;
  }

  function prompt(): void {
    if (!running) return;
    rl.question(getPrompt(), async (input) => {
      const trimmed = input.trim();

      // Fast-approve: Enter approves all pending items
      if (!trimmed && fastApprove) {
        const totalPending = staged.list().length + stagedExec.list().length;
        if (totalPending > 0) {
          const output = await handleCommand('/approve all', commandCtx);
          if (output) console.log(output);
          prompt();
          return;
        }
        prompt();
        return;
      }

      if (!trimmed) { prompt(); return; }

      // /edit — open $EDITOR
      if (trimmed === '/edit') {
        const content = openEditor();
        if (content) {
          await sendTurn(content);
        } else {
          console.log(`${DIM}Editor cancelled.${RESET}`);
        }
        prompt();
        return;
      }

      // /edit system — edit system prompt in $EDITOR
      if (trimmed === '/edit system') {
        const content = openEditor(systemPrompt);
        if (content) {
          systemPrompt = content;
          engine.config.systemPrompt = content;
          console.log(`${UI.success}${BOX.check}${RESET} System prompt updated.`);
        } else {
          console.log(`${DIM}Editor cancelled.${RESET}`);
        }
        prompt();
        return;
      }

      // /paste — multi-line input mode
      if (trimmed === '/paste') {
        console.log(`${DIM}Paste mode. Type /end on a line by itself to send.${RESET}`);
        const lines: string[] = [];
        const collectLine = (): void => {
          rl.question(`${DIM}...${RESET} `, (line) => {
            if (line.trim() === '/end') {
              const text = lines.join('\n').trim();
              if (text) {
                sendTurn(text).then(() => prompt());
              } else {
                console.log(`${DIM}Empty input, cancelled.${RESET}`);
                prompt();
              }
            } else {
              lines.push(line);
              collectLine();
            }
          });
        };
        collectLine();
        return;
      }

      if (trimmed.startsWith('/')) {
        const output = await handleCommand(trimmed, commandCtx);
        if (output) console.log(output);
      } else {
        await sendTurn(trimmed);
      }

      prompt();
    });
  }

  // Welcome banner
  console.log(renderWelcome(currentPreset, channel, opts.projectRoot, currentMode.id));
  prompt();
}

// --- Utility ---

/**
 * Find the last user message that has text content (not just tool_result blocks).
 */
function findLastTextUserIndex(messages: ApiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && msg.content.some(b => b.type === 'text')) {
      return i;
    }
  }
  return -1;
}
