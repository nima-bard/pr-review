import type { ClaudeEffort, ClaudeModel, ClaudeModels } from '../../shared/model';
import { claudeBin, claudeScratchDir } from './claudeProcess';

const EFFORTS: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** When Claude Code's own list can't be read: the current models, with the standard effort levels. */
export const STANDARD_MODELS: ClaudeModel[] = [
  { value: '', name: 'Claude Code’s default', description: 'The model your Claude Code uses', efforts: EFFORTS },
  { value: 'claude-opus-5-5', name: 'Opus 5.5', description: 'Best for everyday, complex tasks', efforts: EFFORTS },
  { value: 'claude-fable-5-2', name: 'Fable 5.2', description: 'Most capable for the hardest tasks', efforts: EFFORTS },
  { value: 'claude-haiku-5-5', name: 'Haiku 5.5', description: 'Fastest for quick answers', efforts: EFFORTS },
];

const TIMEOUT_MS = 15_000;

/** The SDK's model row (only the fields used here). */
interface SdkModel {
  value: string;
  displayName: string;
  description: string;
  supportedEffortLevels?: ClaudeEffort[];
}

/**
 * Claude Code's rows as Settings lists them: its "default" row is the empty model, which passes no `--model`. With
 * each one's context window, by its value, where Claude Code said.
 */
export function toClaudeModels(rows: readonly SdkModel[], windows: ReadonlyMap<string, number> = new Map()): ClaudeModel[] {
  return rows.map((m) => {
    const window = windows.get(m.value);
    return {
      value: m.value === 'default' ? '' : m.value,
      name: m.displayName,
      description: m.description,
      efforts: (m.supportedEffortLevels ?? []).filter((e) => EFFORTS.includes(e)),
      ...(window ? { contextWindow: window } : {}),
    };
  });
}

let cached: ClaudeModel[] | null = null;

/** A model's context window as Claude Code said when the list was read, or null before that (or when it didn't). */
export function knownContextWindow(model: string): number | null {
  return cached?.find((m) => m.value === model)?.contextWindow ?? null;
}

/**
 * The models your Claude Code offers, with each one's effort levels, as its /model picker lists them, and how big
 * each one's context is for your account (switching the model and asking for the context's size, from its own
 * estimate). The Agent SDK asks a `claude` started for nothing else (no prompt is sent, so it costs nothing) and closes
 * it. The list is kept for the app's run; when it can't be read, the standard list stands in.
 */
export async function claudeModels(): Promise<ClaudeModels> {
  if (cached) return { models: cached, fromClaudeCode: true };
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const never = async function* (): AsyncGenerator<never> {
    await new Promise<never>(() => undefined);
  };
  const q = query({ prompt: never(), options: { pathToClaudeCodeExecutable: claudeBin(), cwd: claudeScratchDir(), settingSources: ['user'] } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const windows = new Map<string, number>();
    const read = async () => {
      const rows = await q.supportedModels();
      for (const row of rows) {
        await q.setModel(row.value === 'default' ? undefined : row.value);
        const usage = await q.getContextUsage({ detail: 'summary' });
        if (usage.rawMaxTokens > 0) windows.set(row.value, usage.rawMaxTokens);
      }
      return rows;
    };
    const rows = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS);
      }),
    ]);
    const models = toClaudeModels(rows, windows);
    if (models.length === 0) return { models: STANDARD_MODELS, fromClaudeCode: false };
    cached = models;
    return { models, fromClaudeCode: true };
  } catch {
    return { models: STANDARD_MODELS, fromClaudeCode: false };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
