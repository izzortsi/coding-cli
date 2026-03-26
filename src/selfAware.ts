/**
 * Self-Awareness — grove-cli introspection and self-modification support.
 *
 * Detects grove-cli's own installation root (distinct from the project
 * it is operating on) and provides self-validation and self-rebuild.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Locate grove-cli's own source root by walking up from the running
 * script and looking for a package.json with name "grove-cli".
 */
export function getGroveRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(thisFile);
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'grove-cli') return dir;
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  // Fallback: assume running from dist/ one level below root
  return path.resolve(path.dirname(thisFile), '..');
}

/**
 * Run `tsc --noEmit` against grove-cli's own tsconfig.
 * Returns compiler output or a success message.
 */
export function validateSelf(groveRoot: string): string {
  const result = spawnSync('npx', ['tsc', '--noEmit', '--project', 'tsconfig.json'], {
    cwd: groveRoot,
    encoding: 'utf8',
    timeout: 60_000,
    shell: true,
  });
  const output = ((result.stdout || '') + '\n' + (result.stderr || '')).trim();
  if (result.status === 0) return 'No TypeScript errors found in grove-cli source.';
  return output || 'Validation failed with no output.';
}

/**
 * Rebuild grove-cli by running `tsc` in the grove-cli root.
 * Returns success/failure and compiler output.
 */
export function rebuildSelf(groveRoot: string): { success: boolean; output: string } {
  const result = spawnSync('npx', ['tsc', '--project', 'tsconfig.json'], {
    cwd: groveRoot,
    encoding: 'utf8',
    timeout: 60_000,
    shell: true,
  });
  const output = ((result.stdout || '') + '\n' + (result.stderr || '')).trim();
  return {
    success: result.status === 0,
    output: output || (result.status === 0 ? 'Build successful.' : 'Build failed with no output.'),
  };
}
