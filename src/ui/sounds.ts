/**
 * Sound notifications for grove-cli events.
 *
 * Generates short WAV tones in-memory (pure Node.js, zero dependencies) and
 * plays them via whatever audio player is available on the system.
 *
 * Player detection order: paplay → aplay → afplay (macOS) → terminal bell.
 * Detection runs once on first play; result is cached.
 */

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let enabled = true;

// --- Player detection (cached) ---

type Player = 'paplay' | 'aplay' | 'afplay' | 'bell';
let detectedPlayer: Player | null = null;

function detectPlayer(): Player {
  if (detectedPlayer) return detectedPlayer;
  for (const cmd of ['paplay', 'aplay', 'afplay'] as const) {
    try {
      execSync(`command -v ${cmd}`, { stdio: 'ignore' });
      detectedPlayer = cmd;
      return cmd;
    } catch { /* not found */ }
  }
  detectedPlayer = 'bell';
  return 'bell';
}

// --- WAV generation ---

interface ToneSpec {
  /** Frequency in Hz */
  freq: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Amplitude 0.0–1.0 */
  amplitude: number;
  /** Optional second frequency for a two-tone chirp */
  freq2?: number;
}

const SAMPLE_RATE = 22050;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

/**
 * Generate a 16-bit mono WAV buffer for a sine tone (or linear frequency sweep).
 */
function generateWav(spec: ToneSpec): Buffer {
  const numSamples = Math.floor(SAMPLE_RATE * spec.durationMs / 1000);
  const dataSize = numSamples * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const headerSize = 44;
  const buf = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);

  // fmt chunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);              // chunk size
  buf.writeUInt16LE(1, 20);               // PCM format
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 28); // byte rate
  buf.writeUInt16LE(NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 32);               // block align
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // data chunk
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  const f1 = spec.freq;
  const f2 = spec.freq2 ?? spec.freq;
  const maxVal = 32767;

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = i / numSamples;

    // Linear frequency sweep from f1 to f2
    const freq = f1 + (f2 - f1) * progress;

    // Envelope: quick fade-in (5ms) and fade-out (last 20%)
    const fadeIn = Math.min(1, i / (SAMPLE_RATE * 0.005));
    const fadeOut = progress > 0.8 ? (1 - progress) / 0.2 : 1;
    const envelope = fadeIn * fadeOut;

    const sample = Math.round(spec.amplitude * envelope * maxVal * Math.sin(2 * Math.PI * freq * t));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), headerSize + i * 2);
  }

  return buf;
}

// --- Tone definitions ---

const TONES = {
  /** Short quiet tick — individual tool completion */
  toolComplete: { freq: 880, durationMs: 60, amplitude: 0.15 },
  /** Pleasant rising two-tone chime — full turn done */
  turnComplete: { freq: 660, freq2: 880, durationMs: 180, amplitude: 0.25 },
} as const;

// --- Temp file management ---

const wavCache = new Map<string, string>();

function getWavPath(name: string, spec: ToneSpec): string {
  const cached = wavCache.get(name);
  if (cached && existsSync(cached)) return cached;

  const wavPath = join(tmpdir(), `grove-cli-${name}-${process.pid}.wav`);
  writeFileSync(wavPath, generateWav(spec));
  wavCache.set(name, wavPath);
  return wavPath;
}

/** Clean up temp WAV files on exit */
function cleanup(): void {
  for (const p of wavCache.values()) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
  wavCache.clear();
}
process.on('exit', cleanup);

// --- Playback ---

function play(name: string, spec: ToneSpec): void {
  if (!enabled) return;

  const player = detectPlayer();

  if (player === 'bell') {
    process.stdout.write('\x07');
    return;
  }

  const wavPath = getWavPath(name, spec);

  let cmd: string;
  switch (player) {
    case 'paplay':
      cmd = `paplay ${wavPath}`;
      break;
    case 'aplay':
      cmd = `aplay -q ${wavPath}`;
      break;
    case 'afplay':
      cmd = `afplay ${wavPath}`;
      break;
  }

  spawn('sh', ['-c', `${cmd} 2>/dev/null`], { stdio: 'ignore' }).unref();
}

// --- Public API ---

/** Play after each individual tool call completes. */
export function playToolComplete(): void {
  play('toolComplete', TONES.toolComplete);
}

/** Play when the full agent turn finishes (all tool loops done, final text rendered). */
export function playTurnComplete(): void {
  play('turnComplete', TONES.turnComplete);
}

/** Enable or disable all sounds. */
export function setSoundsEnabled(value: boolean): void {
  enabled = value;
}

export function isSoundsEnabled(): boolean {
  return enabled;
}
