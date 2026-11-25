import { claudeCliAvailable, runClaude } from './claudeCli';

export interface AiCandidate {
  id: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  originalLine: number;
  diffHunk: string;
  comment: string;
  predicted: number;
  current: readonly string[];
}

export interface AiPlacement {
  id: string;
  line: number;
  confidence: number;
}

const WINDOW = 60;

export function buildPrompt(items: readonly AiCandidate[]): string {
  const parts = [
    'Each item below is a code review comment written against an old version of a file.',
    'For each item, find the line in the CURRENT file window that the comment most likely refers to now.',
    'Reply with ONLY a JSON array, no prose: [{"id": "<id>", "line": <line number from the window or null if the code is gone>, "confidence": <0..1>}].',
    '',
  ];
  for (const it of items) {
    const start = Math.max(0, it.predicted - 1 - WINDOW);
    const end = Math.min(it.current.length, it.predicted - 1 + WINDOW);
    parts.push(
      `### id: ${it.id}`,
      `File: ${it.path} (comment was on ${it.side} side, original line ${it.originalLine})`,
      'Original diff hunk (ends at the commented line):',
      '```',
      it.diffHunk,
      '```',
      `Comment: ${it.comment.slice(0, 400)}`,
      'Current file window (1-based line numbers):',
      '```',
      it.current
        .slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join('\n'),
      '```',
      '',
    );
  }
  return parts.join('\n');
}

export function parsePlacements(reply: string, items: readonly AiCandidate[]): AiPlacement[] {
  const match = /\[[\s\S]*\]/.exec(reply);
  if (!match) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const result: AiPlacement[] = [];
  for (const entry of raw as { id?: unknown; line?: unknown; confidence?: unknown }[]) {
    const item = typeof entry.id === 'string' ? byId.get(entry.id) : undefined;
    if (!item || typeof entry.line !== 'number') continue;
    const line = Math.round(entry.line);
    if (line < 1 || line > item.current.length) continue;
    const confidence = typeof entry.confidence === 'number' ? Math.max(0, Math.min(1, entry.confidence)) : 0;
    result.push({ id: item.id, line, confidence });
  }
  return result;
}

/** One local Claude Code CLI call for a batch of low-confidence threads. */
export async function placeWithClaude(items: readonly AiCandidate[], model: string): Promise<AiPlacement[]> {
  if (items.length === 0 || !(await claudeCliAvailable('claude'))) return [];
  const reply = await runClaude(buildPrompt(items), { cliPath: 'claude', model, timeoutMs: 120_000 });
  return parsePlacements(reply, items);
}
