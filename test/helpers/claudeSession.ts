import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Adds messages to a Claude Code session file the way Claude Code does (`<config>/projects/<cwd as a name>/<id>.jsonl`,
 * each line chained to the one before), for tests that read sessions through the Agent SDK: what Claude Desktop or
 * Claude Code would add. The e2e test's stand-in `claude` writes the same lines; `test/main/claudeSessionReader.test.ts`
 * checks the SDK reads them.
 */
export function appendSession(configDir: string, cwd: string, sessionId: string, messages: { type: 'user' | 'assistant'; message: unknown }[]): void {
  const folder = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const file = join(folder, `${sessionId}.jsonl`);
  mkdirSync(folder, { recursive: true });
  let parent = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop()!) as { uuid: string }).uuid : null;
  for (const m of messages) {
    const uuid = randomUUID();
    const line = { type: m.type, uuid, parentUuid: parent, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, userType: 'external', entrypoint: 'claude-desktop', version: '2.1.0', message: m.message };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    parent = uuid;
  }
}
