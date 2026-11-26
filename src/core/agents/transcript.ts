import type { OutsideClaude } from '../../shared/model';
import { EMPTY_STREAM, parseClaudeLine, type ClaudeStreamState } from './claudeStream';

/** A request typed in a PR's Claude Code session outside the app, and Claude's answer so far. */
export interface OutsideTurn {
  /** The prompt's id in the transcript. */
  id: string;
  where: OutsideClaude;
  prompt: string;
  startedAt: string;
  endedAt: string | null;
  reply: string;
  activity: string[];
  /** Claude finished answering (its message ended the turn, or another prompt followed). */
  done: boolean;
}

/** The fields of a transcript line this reads. */
interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  entrypoint?: string;
  turnOrigin?: string;
  origin?: { kind?: string } | null;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown; stop_reason?: string | null };
}

type Block = { type?: string; text?: unknown };

/** Text Claude Code puts in a prompt for a command or its output (`<command-name>`, `<bash-input>`…), not a question. */
const COMMAND = /^<[a-z][\w-]*>/;

/** A prompt's text, or null for the other user lines: tool results and notes Claude Code adds. */
function promptText(e: Entry): string | null {
  if (e.isMeta || e.isCompactSummary) return null;
  const content = e.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return null;
  const blocks = content as Block[];
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  return blocks
    .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n')
    .trim();
}

/** Typed by a person, as Claude Code records it (Claude Desktop: `turnOrigin: "human"`; older terminals say nothing). */
const typed = (e: Entry): boolean => (e.turnOrigin ?? e.origin?.kind ?? (e.entrypoint === 'cli' ? 'human' : '')) === 'human';

/**
 * Follows a Claude Code transcript (`~/.claude/projects/…/<session>.jsonl`) and picks out what was asked outside the
 * app: prompts typed in Claude Desktop or a terminal, with Claude's answers. The app's own requests (`claude -p`,
 * an `sdk-…` entrypoint) are skipped: the app has them already.
 */
export class TranscriptReader {
  private current: { turn: OutsideTurn; state: ClaudeStreamState } | null = null;

  /** Reads whole transcript lines; returns the turns they started or changed. */
  read(text: string): OutsideTurn[] {
    const changed = new Set<OutsideTurn>();
    for (const line of text.split('\n')) {
      let e: Entry;
      try {
        e = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      // A subagent's work, not the conversation.
      if (e.isSidechain) continue;
      const prompt = e.type === 'user' ? promptText(e) : null;
      if (prompt !== null) {
        this.start(e, prompt, changed);
        continue;
      }
      const cur = this.current;
      if (!cur || (e.type !== 'user' && e.type !== 'assistant')) continue;
      cur.state = parseClaudeLine(cur.state, line);
      Object.assign(cur.turn, { reply: cur.state.reply, activity: cur.state.activity });
      if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') Object.assign(cur.turn, { done: true, endedAt: e.timestamp ?? null });
      changed.add(cur.turn);
    }
    return [...changed];
  }

  private start(e: Entry, prompt: string, changed: Set<OutsideTurn>): void {
    const prev = this.current?.turn;
    if (prev && !prev.done) {
      Object.assign(prev, { done: true, endedAt: e.timestamp ?? null });
      changed.add(prev);
    }
    this.current = null;
    if (e.entrypoint?.startsWith('sdk') || !typed(e) || COMMAND.test(prompt) || !e.uuid) return;
    const turn: OutsideTurn = {
      id: e.uuid,
      where: e.entrypoint === 'claude-desktop' ? 'desktop' : 'terminal',
      prompt,
      startedAt: e.timestamp ?? new Date().toISOString(),
      endedAt: null,
      reply: '',
      activity: [],
      done: false,
    };
    this.current = { turn, state: EMPTY_STREAM };
    changed.add(turn);
  }
}
