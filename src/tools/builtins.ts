import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ToolDef } from '../types.js';
import { validateSelf } from '../selfAware.js';

const FILE_READ_LIMIT = 512_000;

/**
 * Tools whose output can be reproduced by calling them again.
 * All tools not in this set are treated as non-re-readable.
 */
export const RE_READABLE_TOOLS: Set<string> = new Set([
  'read_file',
  'list_directory',
  'directory_tree',
  'find_files',
]);

export function buildBuiltinTools(projectRoot: string, groveRoot?: string): ToolDef[] {
  const tools = [
    readFileTool(projectRoot),
    codeSearchTool(projectRoot),
    listDirectoryTool(projectRoot),
    directoryTreeTool(projectRoot),
    findFilesTool(projectRoot),
  ];
  if (groveRoot) {
    tools.push(validateSelfTool(groveRoot));
  }
  return tools;
}

function resolve(projectRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
}

function readFileTool(projectRoot: string): ToolDef {
  return {
    name: 'read_file',
    description: 'Read file contents with line numbers. Use offset/limit for large files.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to file (relative to project root or absolute)' },
        offset: { type: 'number', description: 'Starting line (1-based). Omit for beginning.' },
        limit: { type: 'number', description: 'Max lines to return. Omit for all.' },
      },
      required: ['file_path'],
    },
    async execute(args) {
      const resolved = resolve(projectRoot, args.file_path as string);
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);

      if (stat.size > FILE_READ_LIMIT) {
        const fd = await fs.open(resolved, 'r');
        try {
          const buf = Buffer.alloc(FILE_READ_LIMIT);
          await fd.read(buf, 0, FILE_READ_LIMIT, 0);
          const lines = buf.toString('utf-8').split('\n');
          return lines.map((l, i) => `${i + 1} | ${l}`).join('\n')
            + `\n\n[Truncated: ${stat.size} bytes, showed first ${FILE_READ_LIMIT}]`;
        } finally {
          await fd.close();
        }
      }

      const content = await fs.readFile(resolved, 'utf-8');
      const lines = content.split('\n');
      const offset = typeof args.offset === 'number' ? Math.max(0, args.offset - 1) : 0;
      const limit = typeof args.limit === 'number' ? args.limit : lines.length;
      const slice = lines.slice(offset, offset + limit);

      const header = (offset > 0 || limit < lines.length)
        ? `[Lines ${offset + 1}-${Math.min(offset + limit, lines.length)} of ${lines.length}]\n`
        : '';
      return header + slice.map((l, i) => `${offset + i + 1} | ${l}`).join('\n');
    },
  };
}

function codeSearchTool(projectRoot: string): ToolDef {
  return {
    name: 'code_search',
    description: 'Search for literal text in code files. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        patterns: { type: 'string', description: 'Literal text to search for' },
        paths: { type: 'string', description: 'Directory to search (relative or absolute). Use "." for project root.' },
        extensions: { type: 'string', description: 'Comma-separated extensions (e.g. "ts,py"). Default: "ts,tsx,py,css"' },
      },
      required: ['patterns', 'paths'],
    },
    async execute(args) {
      const pattern = args.patterns as string;
      const searchPath = resolve(projectRoot, args.paths as string);
      const extensions = ((args.extensions as string) || 'ts,tsx,py,css').split(',').map(e => e.trim()).filter(Boolean);
      const includeFlags = extensions.flatMap(ext => ['--include', `*.${ext}`]);

      return new Promise((res, rej) => {
        const proc = spawn('grep', ['-rn', '--color=never', '-F', ...includeFlags, '--', pattern, searchPath]);
        let out = '';
        proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr.on('data', () => {});
        proc.on('close', (code) => {
          if (code === 1 || !out.trim()) {
            res(`No matches found for "${pattern}"`);
          } else if (code === 0) {
            const lines = out.split('\n').map(l =>
              l.startsWith(projectRoot) ? l.substring(projectRoot.length + 1) : l
            );
            res(lines.join('\n'));
          } else {
            rej(new Error(`grep exited with code ${code}`));
          }
        });
        proc.on('error', rej);
      });
    },
  };
}

function listDirectoryTool(projectRoot: string): ToolDef {
  return {
    name: 'list_directory',
    description: 'List directory contents (single level) with file sizes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Use "." for project root.' },
      },
      required: ['path'],
    },
    async execute(args) {
      const resolved = resolve(projectRoot, args.path as string);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const skip = new Set(['node_modules', '.git', 'dist', '__pycache__']);
      const lines: string[] = [];

      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (skip.has(entry.name)) continue;
        if (entry.isDirectory()) {
          lines.push(`  ${entry.name}/`);
        } else if (entry.isFile()) {
          try {
            const s = await fs.stat(path.join(resolved, entry.name));
            lines.push(`  ${entry.name} (${formatSize(s.size)})`);
          } catch {
            lines.push(`  ${entry.name}`);
          }
        }
      }
      return `${path.relative(projectRoot, resolved) || '.'}/\n${lines.join('\n')}`;
    },
  };
}

// --- directory_tree ---

function directoryTreeTool(projectRoot: string): ToolDef {
  return {
    name: 'directory_tree',
    description: 'Recursive tree view of a directory. Use ext_filter to focus on specific file types. Capped at 200 entries.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root directory (relative or absolute).' },
        ext_filter: { type: 'string', description: 'Comma-separated extensions to filter (e.g. "ts,tsx"). Only shows matching files.' },
      },
      required: ['path'],
    },
    async execute(args) {
      const dirPath = args.path as string;
      const extFilter = args.ext_filter as string | undefined;
      const resolved = resolve(projectRoot, dirPath);

      const allowedExts = extFilter
        ? new Set(extFilter.split(',').map(e => `.${e.trim()}`))
        : null;

      const lines: string[] = [];
      const MAX_ENTRIES = 200;
      let entryCount = 0;
      const skip = new Set(['node_modules', '.git', 'dist', '__pycache__', '.ruff_cache']);

      async function walk(dir: string, prefix: string): Promise<void> {
        if (entryCount >= MAX_ENTRIES) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

        const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
        const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

        for (const d of dirs) {
          if (skip.has(d.name)) continue;
          if (entryCount >= MAX_ENTRIES) break;
          lines.push(`${prefix}${d.name}/`);
          entryCount++;
          await walk(path.join(dir, d.name), prefix + '  ');
        }

        for (const f of files) {
          if (entryCount >= MAX_ENTRIES) break;
          if (allowedExts && !allowedExts.has(path.extname(f.name))) continue;
          lines.push(`${prefix}${f.name}`);
          entryCount++;
        }
      }

      const relativePath = path.relative(projectRoot, resolved) || '.';
      lines.push(`${relativePath}/`);
      entryCount++;
      await walk(resolved, '  ');

      if (entryCount >= MAX_ENTRIES) {
        lines.push(`\n[Tree truncated at ${MAX_ENTRIES} entries]`);
      }

      return lines.join('\n');
    },
  };
}

// --- find_files ---

function findFilesTool(projectRoot: string): ToolDef {
  return {
    name: 'find_files',
    description: 'Find files by name glob or extension. Recursive. Max 200 results.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root directory. Default "."' },
        name: { type: 'string', description: 'Glob pattern (e.g. "*.test.*")' },
        ext: { type: 'string', description: 'Comma-separated extensions (e.g. "ts,tsx")' },
      },
      required: ['path'],
    },
    async execute(args) {
      const root = resolve(projectRoot, (args.path as string) || '.');
      const namePattern = args.name as string | undefined;
      const allowedExts = args.ext
        ? new Set(((args.ext as string)).split(',').map(e => `.${e.trim()}`))
        : null;

      const results: string[] = [];
      const MAX = 200;
      const skip = new Set(['node_modules', '.git', 'dist', '__pycache__']);

      async function walk(dir: string): Promise<void> {
        if (results.length >= MAX) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= MAX) break;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!skip.has(e.name)) await walk(full);
          } else if (e.isFile()) {
            if (allowedExts && !allowedExts.has(path.extname(e.name))) continue;
            if (namePattern && !matchGlob(e.name, namePattern)) continue;
            results.push(path.relative(projectRoot, full));
          }
        }
      }

      await walk(root);
      if (results.length === 0) return 'No files found.';
      let out = results.join('\n');
      if (results.length >= MAX) out += `\n\n[Truncated at ${MAX} files]`;
      return out;
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function matchGlob(filename: string, pattern: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i').test(filename);
}

function validateSelfTool(groveRoot: string): ToolDef {
  return {
    name: 'validate_self',
    description: 'Run TypeScript compilation check (tsc --noEmit) on coding-cli\'s own source. Use after proposing changes to coding-cli itself.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute() {
      return validateSelf(groveRoot);
    },
  };
}
