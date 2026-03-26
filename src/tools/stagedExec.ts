/**
 * Staged Exec Tool — Shell command execution with approval gate
 *
 * Follows the same pattern as StagedWriteManager: commands are staged
 * (proposed) by the model but only executed after user approval via /approve.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ToolDef } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 512_000;

export interface StagedExec {
  token: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  rationale: string;
}

export class StagedExecManager {
  pendingExecs: Map<string, StagedExec> = new Map();
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  getTools(): ToolDef[] {
    return [this.proposeExecTool()];
  }

  list(): StagedExec[] {
    return Array.from(this.pendingExecs.values());
  }

  hasPending(): boolean {
    return this.pendingExecs.size > 0;
  }

  async approve(selector: string): Promise<{ success: boolean; output?: string; error?: string }> {
    const entry = this.findExec(selector);
    if (!entry) return { success: false, error: `No staged exec matching "${selector}"` };

    try {
      const output = await this.execute(entry);
      this.pendingExecs.delete(entry.token);
      return { success: true, output };
    } catch (err) {
      this.pendingExecs.delete(entry.token);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async approveAll(): Promise<Array<{ token: string; success: boolean; output?: string; error?: string }>> {
    const results: Array<{ token: string; success: boolean; output?: string; error?: string }> = [];
    for (const [token] of this.pendingExecs) {
      const r = await this.approve(token);
      results.push({ token, ...r });
    }
    return results;
  }

  reject(selector: string): boolean {
    const entry = this.findExec(selector);
    if (!entry) return false;
    this.pendingExecs.delete(entry.token);
    return true;
  }

  rejectAll(): number {
    const count = this.pendingExecs.size;
    this.pendingExecs.clear();
    return count;
  }

  private findExec(selector: string): StagedExec | undefined {
    if (this.pendingExecs.has(selector)) return this.pendingExecs.get(selector);
    for (const [token, entry] of this.pendingExecs) {
      if (token.startsWith(selector)) return entry;
    }
    const idx = parseInt(selector, 10);
    if (!isNaN(idx) && idx >= 1) {
      const entries = Array.from(this.pendingExecs.values());
      if (idx <= entries.length) return entries[idx - 1];
    }
    return undefined;
  }

  private generateToken(command: string): string {
    return createHash('sha256')
      .update(command)
      .update(Date.now().toString())
      .digest('hex')
      .substring(0, 8);
  }

  private execute(entry: StagedExec): Promise<string> {
    const { command, cwd, timeoutMs } = entry;

    return new Promise((resolve, reject) => {
      const shell = process.env.SHELL || '/bin/sh';
      const proc = spawn(shell, ['-c', command], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += data.toString();
      });
      proc.stderr.on('data', (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += data.toString();
      });
      proc.stdin.end();

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, KILL_GRACE_MS);
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n' : '') + stderr;

        if (output.length >= MAX_OUTPUT_BYTES) {
          output = output.substring(0, MAX_OUTPUT_BYTES) + `\n\n[Truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes]`;
        }

        if (code === 0) {
          resolve(output || '(no output)');
        } else {
          reject(new Error(`Exit code ${code}${output ? `: ${output.substring(0, 2000)}` : ''}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to execute: ${err.message}`));
      });
    });
  }

  private proposeExecTool(): ToolDef {
    return {
      name: 'propose_exec',
      description: 'Propose executing a shell command. The command is staged for user approval before running. Use for git operations, builds, tests, package management, etc.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          rationale: { type: 'string', description: 'Why this command is needed' },
          timeout: { type: 'number', description: 'Timeout in seconds (default 30)' },
          cwd: { type: 'string', description: 'Working directory (relative to project root). Default: project root.' },
        },
        required: ['command', 'rationale'],
      },
      execute: async (args) => {
        const command = args.command as string;
        const rationale = args.rationale as string;
        const timeoutMs = ((args.timeout as number) || 30) * 1000;
        const cwdArg = args.cwd as string | undefined;
        const cwd = cwdArg
          ? path.isAbsolute(cwdArg) ? cwdArg : path.resolve(this.projectRoot, cwdArg)
          : this.projectRoot;

        const token = this.generateToken(command);

        this.pendingExecs.set(token, {
          token,
          command,
          cwd,
          timeoutMs,
          rationale,
        });

        const relCwd = path.relative(this.projectRoot, cwd) || '.';
        return `Staged exec (token: ${token})\n  $ ${command}\n  cwd: ${relCwd}\n  timeout: ${timeoutMs / 1000}s\nRationale: ${rationale}\nUse /approve to execute.`;
      },
    };
  }
}
