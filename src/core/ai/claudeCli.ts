import { execFile } from 'child_process';

export interface ClaudeCliOptions {
  cliPath: string;
  model: string;
  timeoutMs?: number;
}

interface CliResult {
  is_error?: boolean;
  result?: string;
}

/** Whether the claude CLI is installed and runnable. Cached per path. */
const availability = new Map<string, Promise<boolean>>();

export function claudeCliAvailable(cliPath: string): Promise<boolean> {
  let cached = availability.get(cliPath);
  if (!cached) {
    cached = new Promise((resolve) => {
      execFile(cliPath, ['--version'], { timeout: 10_000 }, (err) => resolve(!err));
    });
    availability.set(cliPath, cached);
  }
  return cached;
}

/**
 * Run a single prompt through the local Claude Code CLI in headless mode
 * (reuses the user's existing Claude Code login; no API key handling).
 * Tools are disabled and effort is low: pure text in, text out.
 */
export function runClaude(prompt: string, opts: ClaudeCliOptions): Promise<string> {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    opts.model,
    '--effort',
    'low',
    '--tools',
    '',
    // Skip loading the user's MCP servers — they'd add seconds (sometimes tens
    // of seconds) of startup per call and are useless for pure text tasks.
    '--strict-mcp-config',
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      opts.cliPath,
      args,
      { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(new Error(`claude CLI failed: ${err.message}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as CliResult;
          if (parsed.is_error || typeof parsed.result !== 'string') {
            reject(new Error('claude CLI returned an error result'));
            return;
          }
          resolve(parsed.result);
        } catch {
          reject(new Error('claude CLI returned unparseable output'));
        }
      },
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

/** Extract the first JSON object from a model reply that may include prose. */
export function extractJson<T>(text: string): T | undefined {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return undefined;
  }
}
