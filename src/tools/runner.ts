import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 512_000;

export async function runScriptTool(
  command: string[],
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const [cmd, ...cmdArgs] = command;

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, {
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

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const truncated = stdout.length >= MAX_OUTPUT_BYTES
          ? stdout.substring(0, MAX_OUTPUT_BYTES) + `\n\n[Truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes]`
          : stdout;
        resolve(truncated);
      } else {
        reject(new Error(`Script exited with code ${code}: ${(stderr || stdout).substring(0, 2000)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn script: ${err.message}`));
    });
  });
}
