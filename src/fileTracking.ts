/**
 * File Tracking — Track files the model has read with content hashes
 *
 * Every successful read_file call records the file path and a SHA-256
 * hash of its content. This enables drift detection for staged writes
 * and gives the model awareness of which files it has seen.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export interface TrackedFile {
  path: string;
  contentHash: string;
  timestamp: number;
}

export class FileTracker {
  tracked: Map<string, TrackedFile> = new Map();

  /**
   * Record a file read. Computes SHA-256 hash of current content.
   */
  async trackFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex').substring(0, 16);
      this.tracked.set(filePath, {
        path: filePath,
        contentHash: hash,
        timestamp: Date.now(),
      });
    } catch {
      // File may have been deleted — still track it without hash
      this.tracked.set(filePath, {
        path: filePath,
        contentHash: '',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Check if a file's content has changed since it was tracked.
   */
  async hasDrifted(filePath: string): Promise<boolean> {
    const entry = this.tracked.get(filePath);
    if (!entry || !entry.contentHash) return false;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const currentHash = createHash('sha256').update(content).digest('hex').substring(0, 16);
      return currentHash !== entry.contentHash;
    } catch {
      return true; // File deleted = drifted
    }
  }

  /**
   * Get all tracked files sorted by most recently read.
   */
  list(): TrackedFile[] {
    return Array.from(this.tracked.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Format tracked files for state injection.
   */
  formatForState(): string | null {
    const files = this.list();
    if (files.length === 0) return null;

    const lines = files.map(f => {
      const ago = formatTimeAgo(f.timestamp);
      return `  ${f.path} — read ${ago}`;
    });

    return [
      `---[ STATE: tracked_files (${files.length}) ]---`,
      ...lines,
    ].join('\n');
  }

  clear(): void {
    this.tracked.clear();
  }

  /** Serialize for channel persistence */
  toJSON(): Record<string, TrackedFile> {
    const out: Record<string, TrackedFile> = {};
    for (const [k, v] of this.tracked) out[k] = v;
    return out;
  }

  /** Restore from channel persistence */
  fromJSON(data: Record<string, TrackedFile>): void {
    this.tracked.clear();
    for (const [k, v] of Object.entries(data || {})) {
      this.tracked.set(k, v);
    }
  }
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
