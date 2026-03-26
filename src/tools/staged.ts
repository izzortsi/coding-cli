import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDef, StagedWrite } from '../types.js';

export class StagedWriteManager {
  pendingWrites: Map<string, StagedWrite> = new Map();
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  getTools(): ToolDef[] {
    return [this.proposeWriteTool(), this.proposeEditTool(), this.proposePatchTool()];
  }

  list(): StagedWrite[] {
    return Array.from(this.pendingWrites.values());
  }

  async approve(selector: string): Promise<{ success: boolean; filepath?: string; error?: string }> {
    const write = this.findWrite(selector);
    if (!write) return { success: false, error: `No staged write matching "${selector}"` };

    try {
      if (write.mode === 'whole_file') {
        if (write.content === '') {
          // Delete operation — remove file from disk
          await fs.unlink(write.filepath);
        } else {
          await fs.mkdir(path.dirname(write.filepath), { recursive: true });
          await fs.writeFile(write.filepath, write.content, 'utf-8');
        }
      } else if (write.mode === 'search_replace') {
        if (!write.searchContent) return { success: false, error: 'No search content for S&R' };
        const current = await fs.readFile(write.filepath, 'utf-8');
        if (!current.includes(write.searchContent)) {
          return { success: false, error: 'Search content not found in file (may have changed)' };
        }
        await fs.writeFile(write.filepath, current.split(write.searchContent).join(write.content), 'utf-8');
      }
      this.pendingWrites.delete(write.token);
      return { success: true, filepath: write.filepath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async approveAll(): Promise<Array<{ token: string; success: boolean; filepath?: string; error?: string }>> {
    const results = [];
    for (const [token] of this.pendingWrites) {
      results.push({ token, ...await this.approve(token) });
    }
    return results;
  }

  reject(selector: string): boolean {
    const write = this.findWrite(selector);
    if (!write) return false;
    this.pendingWrites.delete(write.token);
    return true;
  }

  rejectAll(): number {
    const count = this.pendingWrites.size;
    this.pendingWrites.clear();
    return count;
  }

  private findWrite(selector: string): StagedWrite | undefined {
    if (this.pendingWrites.has(selector)) return this.pendingWrites.get(selector);
    for (const [token, write] of this.pendingWrites) {
      if (token.startsWith(selector)) return write;
    }
    const idx = parseInt(selector, 10);
    if (!isNaN(idx) && idx >= 1) {
      const entries = Array.from(this.pendingWrites.values());
      if (idx <= entries.length) return entries[idx - 1];
    }
    return undefined;
  }

  private generateToken(filepath: string, content: string): string {
    return createHash('sha256')
      .update(filepath)
      .update(content)
      .update(Date.now().toString())
      .digest('hex')
      .substring(0, 8);
  }

  private resolve(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(this.projectRoot, filePath);
  }

  private proposeWriteTool(): ToolDef {
    return {
      name: 'propose_write',
      description: 'Propose creating or fully replacing a file. The write is staged for user approval.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to file (relative to project root)' },
          content: { type: 'string', description: 'Complete file content' },
          rationale: { type: 'string', description: 'Why this change is needed' },
        },
        required: ['file_path', 'content', 'rationale'],
      },
      execute: async (args) => {
        const filepath = this.resolve(args.file_path as string);
        const content = args.content as string;
        const rationale = args.rationale as string;
        const token = this.generateToken(filepath, content);

        this.pendingWrites.set(token, {
          filepath,
          mode: 'whole_file',
          content,
          token,
          validated: true,
        });

        return `Staged write for ${path.relative(this.projectRoot, filepath)} (token: ${token})\nRationale: ${rationale}\nUse /approve to apply.`;
      },
    };
  }

  private proposeEditTool(): ToolDef {
    return {
      name: 'propose_edit',
      description: 'Propose a search-and-replace edit on an existing file. Read the file first to ensure exact match.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to file' },
          search: { type: 'string', description: 'Exact content to find' },
          replace: { type: 'string', description: 'Content to replace with' },
          rationale: { type: 'string', description: 'Why this change is needed' },
        },
        required: ['file_path', 'search', 'replace', 'rationale'],
      },
      execute: async (args) => {
        const filepath = this.resolve(args.file_path as string);
        const search = args.search as string;
        const replace = args.replace as string;
        const rationale = args.rationale as string;
        const token = this.generateToken(filepath, replace);

        this.pendingWrites.set(token, {
          filepath,
          mode: 'search_replace',
          content: replace,
          searchContent: search,
          token,
          validated: true,
        });

        return `Staged edit for ${path.relative(this.projectRoot, filepath)} (token: ${token})\nRationale: ${rationale}\nUse /approve to apply.`;
      },
    };
  }

  private proposePatchTool(): ToolDef {
    return {
      name: 'propose_patch',
      description: 'Propose coordinated multi-file changes using patch format. Atomic: validates all files before staging any writes. Use for changes that span multiple files.',
      input_schema: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Patch content in the patch format (*** Begin Patch ... *** End Patch)' },
          rationale: { type: 'string', description: 'Why these changes are needed' },
        },
        required: ['patch', 'rationale'],
      },
      execute: async (args) => {
        const patchText = args.patch as string;
        const rationale = args.rationale as string;

        // Parse the patch into operations
        const operations = this.parsePatch(patchText);
        if (operations.length === 0) {
          return 'Error: No valid operations found in patch. Ensure format uses *** Begin Patch / *** End Patch markers.';
        }

        // Validate all operations before staging any
        const validationErrors: string[] = [];
        const stagedEntries: StagedWrite[] = [];

        for (const op of operations) {
          const filepath = this.resolve(op.filePath);

          if (op.type === 'add') {
            // For new files, check that the file does NOT already exist
            try {
              await fs.access(filepath);
              validationErrors.push(`Add File: ${op.filePath} already exists`);
              continue;
            } catch {
              // File doesn't exist — good
            }
            const content = op.addLines.join('\n');
            const token = this.generateToken(filepath, content);
            stagedEntries.push({
              filepath,
              mode: 'whole_file',
              content,
              token,
              validated: true,
            });
          } else if (op.type === 'update') {
            // Read existing file and apply hunks
            let currentContent: string;
            try {
              currentContent = await fs.readFile(filepath, 'utf-8');
            } catch {
              validationErrors.push(`Update File: ${op.filePath} does not exist`);
              continue;
            }

            for (const hunk of op.hunks) {
              const result = this.applyHunk(currentContent, hunk);
              if (result.error) {
                validationErrors.push(`Update File: ${op.filePath}: ${result.error}`);
              } else {
                const token = this.generateToken(filepath, result.searchBlock!);
                stagedEntries.push({
                  filepath,
                  mode: 'search_replace',
                  content: result.replaceBlock!,
                  searchContent: result.searchBlock!,
                  token,
                  validated: true,
                });
              }
            }
          } else if (op.type === 'delete') {
            // For delete: stage a whole_file write with empty content
            // The approve method will write an empty file; we note this in the summary
            try {
              await fs.access(filepath);
            } catch {
              validationErrors.push(`Delete File: ${op.filePath} does not exist`);
              continue;
            }
            const token = this.generateToken(filepath, '__delete__');
            stagedEntries.push({
              filepath,
              mode: 'whole_file',
              content: '',
              token,
              validated: true,
            });
          }
        }

        if (validationErrors.length > 0) {
          return `Patch validation failed (atomic — no changes staged):\n${validationErrors.map(e => `  - ${e}`).join('\n')}`;
        }

        // All validated — stage all entries
        const summaryLines: string[] = [];
        for (const entry of stagedEntries) {
          this.pendingWrites.set(entry.token, entry);
          const rel = path.relative(this.projectRoot, entry.filepath);
          const action = entry.content === '' ? 'delete' : entry.mode === 'whole_file' ? 'add' : 'edit';
          summaryLines.push(`  ${action}: ${rel} (token: ${entry.token})`);
        }

        return `Staged ${stagedEntries.length} operation(s) from patch:\n${summaryLines.join('\n')}\nRationale: ${rationale}\nUse /approve to apply all.`;
      },
    };
  }

  private parsePatch(patchText: string): PatchOperation[] {
    const lines = patchText.split('\n');
    const operations: PatchOperation[] = [];

    let i = 0;
    // Find *** Begin Patch
    while (i < lines.length && !lines[i].trim().startsWith('*** Begin Patch')) {
      i++;
    }
    if (i >= lines.length) return [];
    i++; // skip Begin Patch line

    while (i < lines.length) {
      const line = lines[i].trim();
      if (line.startsWith('*** End Patch')) break;

      if (line.startsWith('*** Add File:')) {
        const filePath = line.replace('*** Add File:', '').trim();
        i++;
        const addLines: string[] = [];
        while (i < lines.length) {
          const l = lines[i];
          if (l.trimStart().startsWith('***')) break;
          if (l.startsWith('+')) {
            addLines.push(l.substring(1));
          }
          i++;
        }
        operations.push({ type: 'add', filePath, addLines, hunks: [] });
      } else if (line.startsWith('*** Update File:')) {
        const filePath = line.replace('*** Update File:', '').trim();
        i++;
        const hunks: PatchHunk[] = [];
        while (i < lines.length) {
          const l = lines[i].trim();
          if (l.startsWith('***')) break;
          if (l.startsWith('@@')) {
            const contextLine = l.substring(2).trim();
            i++;
            const hunkLines: HunkLine[] = [];
            while (i < lines.length) {
              const hl = lines[i];
              if (hl.trimStart().startsWith('***') || hl.trimStart().startsWith('@@')) break;
              if (hl.startsWith('+')) {
                hunkLines.push({ type: 'add', text: hl.substring(1) });
              } else if (hl.startsWith('-')) {
                hunkLines.push({ type: 'remove', text: hl.substring(1) });
              } else if (hl.startsWith(' ')) {
                hunkLines.push({ type: 'context', text: hl.substring(1) });
              } else if (hl === '') {
                // Empty line in patch = empty context line
                hunkLines.push({ type: 'context', text: '' });
              } else {
                i++;
                continue;
              }
              i++;
            }
            hunks.push({ contextLine, lines: hunkLines });
          } else {
            i++;
          }
        }
        operations.push({ type: 'update', filePath, addLines: [], hunks });
      } else if (line.startsWith('*** Delete File:')) {
        const filePath = line.replace('*** Delete File:', '').trim();
        operations.push({ type: 'delete', filePath, addLines: [], hunks: [] });
        i++;
      } else {
        i++;
      }
    }
    return operations;
  }

  private applyHunk(fileContent: string, hunk: PatchHunk): { searchBlock?: string; replaceBlock?: string; error?: string } {
    const fileLines = fileContent.split('\n');

    // Find the context line in the file
    let contextIdx = -1;
    for (let i = 0; i < fileLines.length; i++) {
      if (fileLines[i].trim() === hunk.contextLine.trim()) {
        contextIdx = i;
        break;
      }
    }
    if (contextIdx === -1) {
      return { error: `Context line not found: "${hunk.contextLine}"` };
    }

    // Build the expected search block and the replacement block from hunk lines
    // The context line itself is the anchor — hunk lines follow after it
    const searchLines: string[] = [fileLines[contextIdx]];
    const replaceLines: string[] = [fileLines[contextIdx]];
    let filePos = contextIdx + 1;

    for (const hl of hunk.lines) {
      if (hl.type === 'context') {
        if (filePos >= fileLines.length || fileLines[filePos].trim() !== hl.text.trim()) {
          return { error: `Context mismatch at line ${filePos + 1}: expected "${hl.text}", got "${filePos < fileLines.length ? fileLines[filePos] : '<EOF>'}"` };
        }
        searchLines.push(fileLines[filePos]);
        replaceLines.push(fileLines[filePos]);
        filePos++;
      } else if (hl.type === 'remove') {
        if (filePos >= fileLines.length || fileLines[filePos].trim() !== hl.text.trim()) {
          return { error: `Remove mismatch at line ${filePos + 1}: expected "${hl.text}", got "${filePos < fileLines.length ? fileLines[filePos] : '<EOF>'}"` };
        }
        searchLines.push(fileLines[filePos]);
        // Do NOT add to replaceLines — it's being removed
        filePos++;
      } else if (hl.type === 'add') {
        // Add lines go into replacement only
        replaceLines.push(hl.text);
      }
    }

    return {
      searchBlock: searchLines.join('\n'),
      replaceBlock: replaceLines.join('\n'),
    };
  }
}

interface HunkLine {
  type: 'add' | 'remove' | 'context';
  text: string;
}

interface PatchHunk {
  contextLine: string;
  lines: HunkLine[];
}

interface PatchOperation {
  type: 'add' | 'update' | 'delete';
  filePath: string;
  addLines: string[];
  hunks: PatchHunk[];
}
