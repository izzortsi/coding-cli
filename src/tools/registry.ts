import type {
  ToolDef,
  ToolDefinition,
  ToolUseContent,
  ToolResultContent,
  MessageContent,
} from '../types.js';

export class ToolRegistry {
  private tools: Map<string, ToolDef> = new Map();
  private scriptToolNames: Set<string> = new Set();
  private toolFilter: Set<string> | null = null;

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  /** Register a ToolDef that came from the script registry (tracked for hot-reload). */
  registerScriptTool(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
    this.scriptToolNames.add(tool.name);
  }

  /** Remove all script-registry tools (called before re-loading .coding-cli/tools.json). */
  unregisterScriptTools(): void {
    for (const name of this.scriptToolNames) {
      this.tools.delete(name);
    }
    this.scriptToolNames.clear();
  }

  /** Set a mode-based tool filter. Excluded tools won't appear in definitions or execute. */
  setToolFilter(excludeNames: Set<string> | null): void {
    this.toolFilter = excludeNames;
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter(t => !this.toolFilter || !this.toolFilter.has(t.name))
      .map(({ name, description, input_schema }) => ({
        name,
        description: typeof description === 'function' ? description() : description,
        input_schema,
      }));
  }

  extractToolCalls(content: MessageContent[]): ToolUseContent[] {
    return content.filter(
      (block): block is ToolUseContent => block.type === 'tool_use',
    );
  }

  async execute(toolCall: ToolUseContent): Promise<ToolResultContent> {
    if (this.toolFilter && this.toolFilter.has(toolCall.name)) {
      return {
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: `Tool "${toolCall.name}" is not available in the current mode. Switch to implement mode (/mode implement or Ctrl+X Tab) to use file modification tools.`,
        is_error: true,
      };
    }

    return this.executeDirect(toolCall);
  }

  /** Execute a tool bypassing mode filters. For internal bridges (Lisp runtime, subagents). */
  async executeDirect(toolCall: ToolUseContent): Promise<ToolResultContent> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: `Error: Unknown tool "${toolCall.name}". Available: ${this.getDefinitions().map(t => t.name).join(', ')}`,
        is_error: true,
      };
    }

    try {
      const result = await tool.execute(toolCall.input);
      return {
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: `Error executing ${toolCall.name}: ${message}`,
        is_error: true,
      };
    }
  }

  /** Get all tool names (unfiltered). */
  allToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
