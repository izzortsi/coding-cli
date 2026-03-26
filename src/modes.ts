/**
 * Agent Modes — Behavioral configurations for the primary conversation
 *
 * Each mode controls which tools are available to the model and shapes
 * behavior through a system prompt addendum. Modes are session-level
 * state (not persisted to channel).
 *
 * Cycle through modes with Ctrl+X Tab or switch directly with /mode.
 */

export interface AgentMode {
  id: string;
  displayName: string;
  description: string;
  /** Tool names to exclude when this mode is active. null = no filtering. */
  excludeTools: Set<string> | null;
  /** Appended to system prompt when this mode is active */
  promptAddendum: string;
  /** ANSI color code for prompt display */
  color: string;
}

const STAGING_TOOLS = new Set([
  'propose_write',
  'propose_edit',
  'propose_patch',
  'validate_self',
]);

export const AGENT_MODES: AgentMode[] = [
  {
    id: 'explore',
    displayName: 'Explore',
    description: 'Read-only investigation — no file changes',
    excludeTools: STAGING_TOOLS,
    promptAddendum: `\n\n## Mode: Explore\nYou are in EXPLORE mode. Focus on investigation and understanding. Read files, search code, trace dependencies, map architecture. Build comprehensive codesight before making claims. Do not propose file changes — report findings.`,
    color: '\x1b[96m',
  },
  {
    id: 'plan',
    displayName: 'Plan',
    description: 'Design and architecture — reason without implementing',
    excludeTools: STAGING_TOOLS,
    promptAddendum: `\n\n## Mode: Plan\nYou are in PLAN mode. Focus on design and architecture. Reason about approaches, tradeoffs, and implications. Present plans as prose, not code. Identify what needs to change and why, without implementing. Ask clarifying questions when intent is ambiguous.`,
    color: '\x1b[93m',
  },
  {
    id: 'review',
    displayName: 'Review',
    description: 'Analysis and critique — examine without changing',
    excludeTools: STAGING_TOOLS,
    promptAddendum: `\n\n## Mode: Review\nYou are in REVIEW mode. Focus on analysis and critique. Examine code for correctness, patterns, edge cases, and potential issues. Report findings with specific file paths and line references. Do not propose file changes — identify what needs attention and why.`,
    color: '\x1b[95m',
  },
  {
    id: 'implement',
    displayName: 'Implement',
    description: 'Full tool access — read, write, explore, execute',
    excludeTools: null,
    promptAddendum: '',
    color: '\x1b[92m',
  },
];

export const DEFAULT_MODE = AGENT_MODES[3]; // implement

export function findMode(id: string): AgentMode | undefined {
  return AGENT_MODES.find(m => m.id === id);
}

export function getNextMode(currentId: string): AgentMode {
  const idx = AGENT_MODES.findIndex(m => m.id === currentId);
  return AGENT_MODES[(idx + 1) % AGENT_MODES.length];
}
