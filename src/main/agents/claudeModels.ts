import { homedir } from 'node:os';
import type { ClaudeEffort, ClaudeModel, ClaudeModels } from '../../shared/model';
import { claudeBin } from './claudeProcess';

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

/** Claude Code's rows as Settings lists them: its "default" row is the empty model, which passes no `--model`. */
export function toClaudeModels(rows: readonly SdkModel[]): ClaudeModel[] {
  return rows.map((m) => ({
    value: m.value === 'default' ? '' : m.value,
    name: m.displayName,
    description: m.description,
    efforts: (m.supportedEffortLevels ?? []).filter((e) => EFFORTS.includes(e)),
  }));
}

let cached: ClaudeModel[] | null = null;

/**
 * The models your Claude Code offers, with each one's effort levels, as its /model picker lists them. The Agent SDK
 * asks a `claude` started for nothing else (no prompt is sent, so it costs nothing) and closes it. The list is kept for
 * the app's run; when it can't be read, the standard list stands in.
 */
export async function claudeModels(): Promise<ClaudeModels> {
  if (cached) return { models: cached, fromClaudeCode: true };
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const never = async function* (): AsyncGenerator<never> {
    await new Promise<never>(() => undefined);
  };
  const q = query({ prompt: never(), options: { pathToClaudeCodeExecutable: claudeBin(), cwd: homedir(), settingSources: ['user'] } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const rows = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS);
      }),
    ]);
    const models = toClaudeModels(rows);
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
