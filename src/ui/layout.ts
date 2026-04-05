/**
 * Layout — Header, footer, message chrome, tool summaries
 *
 * Pure functions that return styled strings. No I/O.
 */

import {
  RESET, BOLD, DIM, ITALIC,
  FG, BG, fg256,
  UI, ROLE, BOX,
  stripAnsi, visibleLength, padEnd,
} from './colors.js';
import type { ModelPreset } from '../presets.js';
import type { ChannelData } from '../channel.js';
import type { ToolCallInfo, Usage } from '../types.js';
import { relativeTime } from '../channel.js';

// --- Header / Footer ---

export function renderHeader(preset: ModelPreset, channel: ChannelData, cols: number): string {
  const left = `${UI.accent}${BOX.bullet}${RESET} ${BOLD}${preset.displayName}${RESET} ${UI.muted}${BOX.dot} ${channel.name}${RESET}`;
  const msgCount = `${channel.messages.length} msgs`;
  const right = `${UI.muted}${msgCount}${RESET}`;

  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  const gap = Math.max(1, cols - leftLen - rightLen - 2);

  return `${left}${' '.repeat(gap)}${right}`;
}

export function renderFooter(projectRoot: string, cols: number): string {
  const cwd = `${UI.muted}${projectRoot}${RESET}`;
  return `${FG.gray}${BOX.h.repeat(Math.min(cols, 60))}${RESET}\n${cwd}`;
}

// --- Message Chrome ---

export function renderUserLabel(): string {
  return '';
}

export function renderAssistantLabel(_presetId: string, cols = 0): string {
  const width = cols > 0 ? cols : (process.stdout.columns || 80);
  const label = `${BOX.arrow} assistant`;
  const leftPad = 2;
  const rightLen = Math.max(0, width - leftPad - label.length - 2);
  return `\n${DIM}${BOX.h.repeat(leftPad)} ${ROLE.assistant}${label}${RESET}${DIM} ${BOX.h.repeat(rightLen)}${RESET}`;
}

// --- Thinking Block ---
// Collapsed by default: shows a one-liner with word count.
// Pass expand=true to show the full text.

export function renderThinkingBlock(text: string, expand = false): string {
  const wordCount = text.trim().split(/\s+/).length;
  const header = `  ${FG.gray}┃${RESET} ${DIM}${ITALIC}thinking${RESET} ${DIM}(${wordCount} words)${RESET}`;
  if (!expand) return header;

  const lines = text.split('\n');
  const body = lines.map(l => `  ${FG.gray}┃${RESET} ${ROLE.thinking}${l}${RESET}`).join('\n');
  return `${header}\n${body}`;
}

// --- Tool Icons (ANSI colored symbols, no emoji) ---

export const TOOL_ICONS: Record<string, string> = {
  read_file:                 `${FG.cyan}◆${RESET}`,
  code_search:               `${FG.yellow}◆${RESET}`,
  list_directory:            `${FG.blue}◆${RESET}`,
  directory_tree:            `${FG.blue}◆${RESET}`,
  find_files:                `${FG.magenta}◆${RESET}`,
  propose_write:             `${FG.brightGreen}◆${RESET}`,
  propose_edit:              `${FG.green}◆${RESET}`,
  run_subagent:              `${FG.brightCyan}◆${RESET}`,
};

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? `${FG.gray}◆${RESET}`;
}

// --- Tool Call Display ---

export function renderToolCalls(toolCalls: ToolCallInfo[]): string {
  if (toolCalls.length === 0) return '';

  const lines = toolCalls.map(tc => {
    const icon = getToolIcon(tc.name);
    const status = tc.isError
      ? `${FG.brightRed}${BOX.cross}${RESET}`
      : `${FG.brightGreen}${BOX.check}${RESET}`;
    const time = `${DIM}${tc.durationMs}ms${RESET}`;
    const name = `${FG.white}${tc.name}${RESET}`;
    return `  ${status} ${icon} ${name} ${time}`;
  });

  const totalMs = toolCalls.reduce((sum, tc) => sum + tc.durationMs, 0);
  const summary = `${DIM}${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''} · ${totalMs}ms${RESET}`;

  return `\n${lines.join('\n')}\n  ${summary}`;
}

// --- Usage + Context Footer ---
// Right-aligns the stats line against `cols`. Falls back to left-padded if cols=0.

export function renderUsageFooter(usageLine: string, ctxBar: string, cols: number): string {
  if (!usageLine && !ctxBar) return '';
  const parts = [usageLine, ctxBar].filter(Boolean).join('  ');
  if (cols <= 0) return `\n  ${parts}`;

  const visible = visibleLength(parts);
  const pad = Math.max(2, cols - visible - 1);
  return `\n${' '.repeat(pad)}${parts}`;
}

// Keep the old renderUsage for callers that only need the string.
export function renderUsage(usage: Usage): string {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return '';
  const inK = (usage.inputTokens / 1000).toFixed(1);
  const outK = (usage.outputTokens / 1000).toFixed(1);
  return `${DIM}${inK}K in ${BOX.dot} ${outK}K out${RESET}`;
}

// --- Staged Writes Notification ---
// Full-width colored bar so it's impossible to miss.

export function renderStagedNotice(count: number, cols = 0): string {
  if (count === 0) return '';
  const label = count === 1 ? '1 pending item' : `${count} pending items`;
  const hint = '/approve . to apply · /reject . to discard';
  const inner = `  ${BOX.arrow} ${label}  ${DIM}${hint}${RESET}`;
  const barWidth = cols > 0 ? cols : 60;
  const visLen = visibleLength(inner);
  const pad = Math.max(0, barWidth - visLen);
  return `\n${FG.brightYellow}${inner}${' '.repeat(pad)}${RESET}`;
}

// --- Welcome Banner ---

export function renderWelcome(preset: ModelPreset, channel: ChannelData, projectRoot: string, modeId?: string): string {
  const ctxK = preset.contextWindow >= 1_000_000
    ? `${(preset.contextWindow / 1_000_000).toFixed(0)}M`
    : `${(preset.contextWindow / 1_000).toFixed(0)}K`;

  const lines = [
    '',
    `  ${fg256(75)}╭─${RESET} ${BOLD}coding-cli${RESET} ${DIM}v0.1.0${RESET}`,
    `  ${fg256(75)}│${RESET}`,
    `  ${fg256(75)}│${RESET}  ${UI.label}model${RESET}    ${preset.displayName} ${DIM}(${preset.providerId})${RESET}`,
    `  ${fg256(75)}│${RESET}  ${UI.label}context${RESET}  ${ctxK} tokens`,
    `  ${fg256(75)}│${RESET}  ${UI.label}channel${RESET}  ${channel.name} ${DIM}(${channel.id})${RESET}${channel.messages.length > 0 ? ` ${DIM}· ${channel.messages.length} msgs${RESET}` : ''}`,
    `  ${fg256(75)}│${RESET}  ${UI.label}mode${RESET}     ${modeId || 'implement'}`,
    `  ${fg256(75)}│${RESET}  ${UI.label}project${RESET}  ${projectRoot}`,
    `  ${fg256(75)}│${RESET}`,
    `  ${fg256(75)}╰─${RESET} ${DIM}type /help for commands${RESET}`,
    '',
  ];
  return lines.join('\n');
}

// --- Turn Separator ---

export function renderTurnSeparator(): string {
  return '';
}

// --- Tab Bar ---

export interface TabInfo {
  id: string;
  name: string;
  isCurrent: boolean;
}

export function renderTabBar(tabs: TabInfo[], cols = 0): string {
  if (tabs.length <= 1) return '';
  const width = cols > 0 ? cols : (process.stdout.columns || 80);

  const rendered = tabs.map(tab => {
    if (tab.isCurrent) {
      return `${FG.brightCyan}${BOX.v}${RESET} ${BOLD}${tab.name}${RESET} `;
    }
    return `${DIM}${BOX.v}${RESET} ${DIM}${tab.name}${RESET} `;
  }).join('');

  const barLen = Math.min(width, 60);
  return `${rendered}\n${DIM}${BOX.h.repeat(barLen)}${RESET}`;
}

// --- Channel List ---

export function renderChannelList(
  channels: Array<{ id: string; name: string; presetId: string; messageCount: number; lastActivity: number }>,
  currentId: string,
): string {
  if (channels.length === 0) return `${DIM}No saved channels.${RESET}`;

  return channels.map((ch, i) => {
    const current = ch.id === currentId ? ` ${FG.brightGreen}◀${RESET}` : '';
    const num = `${DIM}${i + 1}.${RESET}`;
    const name = `${BOLD}${ch.name}${RESET}`;
    const meta = `${DIM}${ch.presetId} · ${ch.messageCount} msgs · ${relativeTime(ch.lastActivity)}${RESET}`;
    return `  ${num} ${name} ${meta}${current}`;
  }).join('\n');
}
