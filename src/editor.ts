/**
 * Editor Integration — Opens $EDITOR for prompt composition
 *
 * Creates a temp file, spawns editor synchronously, reads content on exit.
 * Supports any terminal editor (nvim, vim, nano, etc.).
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Detect the user's preferred editor.
 * Priority: $EDITOR > $VISUAL > nvim
 */
function getEditor(): string {
  return process.env.EDITOR || process.env.VISUAL || 'nvim';
}

/**
 * Open the user's editor with optional initial content.
 * Blocks until the editor exits.
 *
 * Returns the edited content, or null if cancelled/empty/error.
 *
 * @param initialContent — Pre-fill the temp file
 * @param fileSuffix — File extension for syntax highlighting (default: '.md')
 */
export function openEditor(initialContent?: string, fileSuffix?: string): string | null {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'coding-cli-'));
  const tmpFile = path.join(tmpDir, `prompt${fileSuffix || '.md'}`);

  try {
    writeFileSync(tmpFile, initialContent || '', 'utf-8');
    const editor = getEditor();

    const result = spawnSync(editor, [tmpFile], {
      stdio: 'inherit', // Connect editor directly to terminal
    });

    if (result.error) {
      console.error(`Failed to open editor '${editor}': ${result.error.message}`);
      console.error('Set $EDITOR to your preferred editor.');
      return null;
    }

    if (result.status !== 0) {
      return null; // Editor exited with error — treat as cancel
    }

    const content = readFileSync(tmpFile, 'utf-8');
    return content.trim() || null;
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }
}
