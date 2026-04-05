/**
 * Test Runner Tool — Detect and run project tests
 *
 * Detects the test command from project configuration (package.json, Cargo.toml,
 * go.mod, Makefile, etc.) or uses an explicit override from channel config.
 *
 * Supports optional file and pattern filtering for targeted test runs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ToolDef } from '../types.js';

const MAX_OUTPUT = 20_000;

interface TestConfig {
  /** Base command to run tests (e.g. "npm test", "cargo test") */
  command: string;
  /** How to append a file filter */
  fileFlag?: string;
  /** How to append a pattern/name filter */
  patternFlag?: string;
}

/**
 * Detect the test configuration from project files.
 * Returns null if no test setup is found.
 */
async function detectTestConfig(projectRoot: string): Promise<TestConfig | null> {
  // 1. package.json — check for test script and test runner configs
  try {
    const pkgRaw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);

    // Check for vitest config
    const vitestConfigs = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'];
    for (const cfg of vitestConfigs) {
      try {
        await fs.access(path.join(projectRoot, cfg));
        return {
          command: 'npx vitest run',
          patternFlag: '-t',
        };
      } catch { /* not found */ }
    }

    // Check for jest config
    const jestConfigs = ['jest.config.ts', 'jest.config.js', 'jest.config.cjs'];
    for (const cfg of jestConfigs) {
      try {
        await fs.access(path.join(projectRoot, cfg));
        return {
          command: 'npx jest',
          patternFlag: '-t',
        };
      } catch { /* not found */ }
    }
    // jest can also be configured in package.json
    if (pkg.jest) {
      return {
        command: 'npx jest',
        patternFlag: '-t',
      };
    }

    // Check for scripts.test (but skip the npm default stub)
    if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
      return {
        command: 'npm test --',
        patternFlag: undefined, // framework-dependent
      };
    }
  } catch { /* no package.json */ }

  // 2. Cargo.toml → cargo test
  try {
    await fs.access(path.join(projectRoot, 'Cargo.toml'));
    return {
      command: 'cargo test',
      patternFlag: undefined, // cargo test uses positional filter
    };
  } catch { /* not found */ }

  // 3. go.mod → go test
  try {
    await fs.access(path.join(projectRoot, 'go.mod'));
    return {
      command: 'go test ./...',
      patternFlag: '-run',
    };
  } catch { /* not found */ }

  // 4. pytest (pyproject.toml or pytest.ini or setup.cfg)
  for (const cfg of ['pyproject.toml', 'pytest.ini', 'setup.cfg']) {
    try {
      const content = await fs.readFile(path.join(projectRoot, cfg), 'utf-8');
      if (cfg === 'pyproject.toml' && !content.includes('[tool.pytest')) continue;
      if (cfg === 'setup.cfg' && !content.includes('[tool:pytest]')) continue;
      return {
        command: 'pytest',
        patternFlag: '-k',
      };
    } catch { /* not found */ }
  }

  // 5. Makefile with test target
  try {
    const makefile = await fs.readFile(path.join(projectRoot, 'Makefile'), 'utf-8');
    if (/^test\s*:/m.test(makefile)) {
      return { command: 'make test' };
    }
  } catch { /* not found */ }

  return null;
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT) return output;
  const half = Math.floor(MAX_OUTPUT / 2);
  const head = output.slice(0, half);
  const tail = output.slice(-half);
  const skipped = output.length - MAX_OUTPUT;
  return `${head}\n\n[... ${skipped} characters truncated ...]\n\n${tail}`;
}

export function buildTestRunnerTool(
  projectRoot: string,
  getTestCommand: () => string | undefined,
): ToolDef {
  return {
    name: 'run_tests',
    description:
      'Run the project\'s test suite. Auto-detects the test runner (vitest, jest, pytest, cargo test, go test, etc.) ' +
      'or uses the configured test command. Optionally filter by file path or test name pattern.',
    input_schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Run tests from a specific file or directory (relative path)',
        },
        pattern: {
          type: 'string',
          description: 'Filter tests by name/pattern (framework-specific matching)',
        },
      },
      required: [],
    },
    async execute(args) {
      const file = args.file as string | undefined;
      const pattern = args.pattern as string | undefined;

      // Resolve test config: explicit override > auto-detect
      const override = getTestCommand();
      let config: TestConfig | null;
      if (override) {
        config = { command: override };
      } else {
        config = await detectTestConfig(projectRoot);
      }

      if (!config) {
        return 'Error: Could not detect test runner. No package.json scripts.test, vitest, jest, pytest, Cargo.toml, go.mod, or Makefile test target found.\n\nYou can configure a test command by setting channel.testCommand.';
      }

      // Build the full command
      let cmd = config.command;

      if (file) {
        // For most frameworks, appending the file path works
        cmd += ` ${file}`;
      }

      if (pattern) {
        if (config.patternFlag) {
          cmd += ` ${config.patternFlag} ${JSON.stringify(pattern)}`;
        } else {
          // Append as positional (works for cargo test, etc.)
          cmd += ` ${pattern}`;
        }
      }

      return new Promise<string>((resolve) => {
        const proc = spawn('sh', ['-c', cmd], {
          cwd: projectRoot,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
          timeout: 120_000,
        });

        let stdout = '';
        let stderr = '';
        const MAX_BUFFER = 512_000;
        proc.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_BUFFER) stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_BUFFER) stderr += d.toString(); });

        proc.on('close', (code) => {
          let output = '';
          if (stdout.trim()) output += stdout;
          if (stderr.trim()) {
            if (output) output += '\n';
            output += stderr;
          }
          if (!output.trim()) {
            output = code === 0 ? 'Tests passed (no output).' : `Tests failed with exit code ${code} (no output).`;
          }

          output = truncateOutput(output);

          const status = code === 0 ? '✓ Tests passed' : `✗ Tests failed (exit code ${code})`;
          resolve(`${status}\nCommand: ${cmd}\n\n${output}`);
        });

        proc.on('error', (err) => {
          resolve(`Error running tests: ${err.message}\nCommand: ${cmd}`);
        });
      });
    },
  };
}
