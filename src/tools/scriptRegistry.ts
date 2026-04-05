/**
 * Script Tool Registry — File-based external tool loader
 *
 * Reads `.coding-cli/tools.json` from the project root and registers each entry
 * as a script tool. Scripts receive their arguments as JSON on stdin and
 * must write their result to stdout (exit 0) or stderr (exit non-zero).
 *
 * Supported runtimes (by file extension or explicit "command"):
 *   .py   → python3 <script> [extra args]
 *   .sh   → bash <script> [extra args]
 *   .lisp → sbcl --script <script> [extra args]  (Steel Bank Common Lisp)
 *   .scm  → guile <script> [extra args]           (GNU Guile Scheme)
 *   command: [...]  → used verbatim (overrides extension inference)
 *
 * The registry file is re-read on every call to loadScriptTools(), which
 * is called from onBeforeApiCall — so edits to tools.json take effect on
 * the next turn with no restart required.
 *
 * Example .coding-cli/tools.json:
 * [
 *   {
 *     "name": "run_tests",
 *     "description": "Run the test suite. Returns pass/fail summary.",
 *     "script": ".coding-cli/tools/run_tests.py",
 *     "input_schema": {
 *       "type": "object",
 *       "properties": {
 *         "filter": { "type": "string", "description": "Test name filter (optional)" }
 *       },
 *       "required": []
 *     },
 *     "timeoutMs": 60000
 *   }
 * ]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDef, ToolInputSchema } from '../types.js';
import { runScriptTool } from './runner.js';

export interface ScriptToolEntry {
  /** Tool name as the model sees it */
  name: string;
  /** Description shown to the model */
  description: string;
  /** Path to the script, relative to project root */
  script?: string;
  /** Explicit command array — overrides script + extension inference */
  command?: string[];
  /** Input schema */
  input_schema: ToolInputSchema;
  /** Max execution time in ms. Default: 30000 */
  timeoutMs?: number;
}

const REGISTRY_PATH = '.coding-cli/tools.json';

/** Infer the interpreter command from a script file extension. */
function inferCommand(scriptPath: string): string[] {
  const ext = path.extname(scriptPath).toLowerCase();
  switch (ext) {
    case '.py':   return ['python3', scriptPath];
    case '.sh':   return ['bash', scriptPath];
    case '.js':   return ['node', scriptPath];
    case '.ts':   return ['npx', 'tsx', scriptPath];
    case '.lisp':
    case '.lsp':  return ['sbcl', '--script', scriptPath];
    case '.scm':  return ['guile', scriptPath];
    default:
      throw new Error(
        `Cannot infer runtime for "${scriptPath}" (ext: "${ext}"). ` +
        `Supported: .py, .sh, .js, .ts, .lisp, .lsp, .scm. Or set "command" explicitly.`
      );
  }
}

/**
 * Load script tools from .coding-cli/tools.json.
 *
 * Returns an empty array (not an error) if the file doesn't exist —
 * the registry is optional. Throws on malformed JSON or invalid entries.
 */
export async function loadScriptTools(projectRoot: string): Promise<ToolDef[]> {
  const registryPath = path.resolve(projectRoot, REGISTRY_PATH);

  let raw: string;
  try {
    raw = await fs.readFile(registryPath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Failed to read ${REGISTRY_PATH}: ${err.message}`);
  }

  let entries: ScriptToolEntry[];
  try {
    entries = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Malformed ${REGISTRY_PATH}: ${err.message}`);
  }

  if (!Array.isArray(entries)) {
    throw new Error(`${REGISTRY_PATH} must be a JSON array`);
  }

  const tools: ToolDef[] = [];

  for (const entry of entries) {
    if (!entry.name || typeof entry.name !== 'string') {
      throw new Error(`Script tool entry missing "name": ${JSON.stringify(entry)}`);
    }
    if (!entry.description || typeof entry.description !== 'string') {
      throw new Error(`Script tool "${entry.name}" missing "description"`);
    }
    if (!entry.input_schema) {
      throw new Error(`Script tool "${entry.name}" missing "input_schema"`);
    }

    // Resolve command
    let command: string[];
    if (entry.command && entry.command.length > 0) {
      command = entry.command;
    } else if (entry.script) {
      const absScript = path.resolve(projectRoot, entry.script);
      command = inferCommand(absScript);
    } else {
      throw new Error(`Script tool "${entry.name}" must have either "script" or "command"`);
    }

    const timeoutMs = entry.timeoutMs ?? 30_000;

    tools.push({
      name: entry.name,
      description: entry.description,
      input_schema: entry.input_schema,
      execute: (args) => runScriptTool(command, args, timeoutMs),
    });
  }

  return tools;
}
