/**
 * Lisp Persistence
 *
 * Serializes the agent's Lisp environment to a string of (define ...)
 * forms that can be stored in identity and restored across sessions.
 *
 * Only user-defined bindings are serialized (not builtins/natives).
 * Round-trips through read → eval to restore.
 */

import type { LispVal, Env } from './types.js';
import { isList, isSym } from './types.js';
import { envOwnBindings } from './env.js';
import { print } from './printer.js';

/**
 * Serialize an environment's own bindings as (define ...) forms.
 * Skips native functions (they'll be re-installed on load).
 * Skips lambda closures that reference non-serializable state.
 */
export function serializeEnv(env: Env): string {
  const bindings = envOwnBindings(env);
  const lines: string[] = [];

  // Header
  lines.push(';; grove-lisp agent image');
  lines.push(`;; saved: ${new Date().toISOString()}`);
  lines.push('');

  for (const [name, val] of bindings) {
    // Skip native functions — they're reinstalled by builtins
    if (val.tag === 'native') continue;

    // Serialize user-defined functions and macros
    if (val.tag === 'fn') {
      const params = val.params.join(' ');
      const body = print(val.body);
      if (val.isMacro) {
        // Macros use defmacro form
        lines.push(`(defmacro (${val.name || name} ${params}) ${body})`);
      } else if (val.name) {
        lines.push(`(define (${val.name} ${params}) ${body})`);
      } else {
        lines.push(`(define ${name} (lambda (${params}) ${body}))`);
      }
      continue;
    }

    // Serialize data values — quote lists so they don't get evaluated as function calls
    if (isList(val)) {
      lines.push(`(define ${name} '${print(val)})`);
    } else {
      lines.push(`(define ${name} ${print(val)})`);
    }
  }

  return lines.join('\n');
}

/**
 * Extract define forms from a serialized image.
 * Returns the raw source — caller should readAll + eval each.
 */
export function extractDefines(source: string): string {
  // Strip empty lines and comments, return clean source
  return source
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith(';;');
    })
    .join('\n');
}

/**
 * Merge two serialized images. Later definitions win.
 * Used when combining base knowledge with session updates.
 */
export function mergeImages(base: string, overlay: string): string {
  const overlayNames = extractDefinedNames(overlay);

  // Keep base definitions not overridden by overlay
  // Use paren depth tracking for robust multi-line handling
  const baseLines = base.split('\n');
  const kept: string[] = [];
  let skippingDef: string | null = null;
  let parenDepth = 0;

  for (const line of baseLines) {
    const trimmed = line.trim();
    
    // Check for start of a new define
    const name = getDefineName(line);
    if (name) {
      if (overlayNames.has(name)) {
        skippingDef = name;
        parenDepth = 0; // Reset depth for new definition
      } else {
        skippingDef = null;
        kept.push(line);
        continue;
      }
    }
    
    if (skippingDef) {
      // Count parens to track when definition ends, ignoring parens inside string literals
      let inString = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          // Toggle string state; escaped quotes don't toggle (preceded by odd number of backslashes)
          let backslashes = 0;
          let j = i - 1;
          while (j >= 0 && line[j] === '\\') { backslashes++; j--; }
          if (backslashes % 2 === 0) inString = !inString;
        } else if (!inString) {
          if (ch === '(') parenDepth++;
          else if (ch === ')') parenDepth--;
        }
      }
      // Definition ends when we close all parens (depth reaches 0 after starting)
      if (parenDepth <= 0 && line.includes(')')) {
        skippingDef = null;
      }
      continue;
    }
    
    kept.push(line);
  }

  return kept.join('\n') + '\n' + overlay;
}

// --- Helpers ---

function extractDefinedNames(source: string): Set<string> {
  const names = new Set<string>();
  const definePattern = /\((?:define|defmacro)\s+(?:\((\S+)|(\S+))/g;
  let match;
  while ((match = definePattern.exec(source)) !== null) {
    names.add(match[1] || match[2]);
  }
  return names;
}

function getDefineName(line: string): string | null {
  const match = line.match(/^\s*\((?:define|defmacro)\s+(?:\((\S+)|(\S+))/);
  if (!match) return null;
  return match[1] || match[2] || null;
}
