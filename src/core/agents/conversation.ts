import { readPrompt } from '../../shared/agents';
import type { ClaudeOffer, Exchange } from '../../shared/model';
import { EMPTY_STREAM, foldClaudeMessage, type ClaudeStreamState } from './claudeStream';

/**
 * A message of a Claude Code session as the Agent SDK's `getSessionMessages` returns it (only the fields used here).
 * The SDK reads Claude Code's own files, whose format is internal; this is its documented shape.
 */
export interface SessionLine {
  type: string;
  uuid: string;
  message: unknown;
  /** Set on a subagent's messages, which aren't the conversation. */
  parent_tool_use_id?: string | null;
  /** A prompt sent while Claude was still answering: Claude Code queues it into the same turn. */
  isQueuedCommand?: boolean;
  timestamp?: string;
}

type Block = { type?: string; text?: unknown; content?: unknown; name?: unknown; input?: unknown };

/**
 * Text Claude Code puts in a prompt that isn't a question: a command or its output (`<command-name>`, `<bash-input>`…),
 * or its note that you stopped an answer ("[Request interrupted by user]").
 */
const COMMAND = /^(?:<[a-z][\w-]*>|\[Request interrupted by user)/;

/**
 * Claude Code's note that something Claude started in the background (a subagent, a shell command) has ended, which it
 * puts in the session as a prompt and Claude answers. Its summary, for the exchange's list of what Claude did.
 */
function finishedInBackground(text: string): string | null {
  if (!text.startsWith('<task-notification>')) return null;
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? '';
  const summary = tag('summary');
  if (summary) return summary;
  const status = tag('status');
  return status === 'failed' ? 'Something running in the background failed' : status === 'killed' || status === 'stopped' ? 'Something running in the background was stopped' : 'Something running in the background finished';
}

/** The text of a prompt, or null for the other user messages (tool results). An image-only prompt has empty text. */
function promptText(message: unknown): string | null {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return null;
  const blocks = content as Block[];
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  return blocks
    .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n')
    .trim();
}

/** The drafts an add_draft result reports ("Added draft <id> on <path>:<line>…"). */
function addedDrafts(message: unknown): string[] {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content as Block[]) {
    if (block.type !== 'tool_result') continue;
    const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as Block[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('') : '';
    const m = /^Added draft (\S+) on /.exec(text);
    if (m) ids.push(m[1]!);
  }
  return ids;
}

/** The choices Claude offered with the offer_choices tool in an assistant message, when it did (and they're well formed). */
function offered(message: unknown): ClaudeOffer | null {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return null;
  let offer: ClaudeOffer | null = null;
  for (const block of content as Block[]) {
    if (block.type !== 'tool_use' || block.name !== 'mcp__pr-review__offer_choices') continue;
    const input = block.input as { question?: unknown; choices?: unknown } | null;
    const choices = Array.isArray(input?.choices) ? (input.choices as { label?: unknown; prompt?: unknown }[]) : [];
    const valid = choices.flatMap((c) => (typeof c.label === 'string' && c.label.trim() ? [{ label: c.label.trim(), prompt: typeof c.prompt === 'string' && c.prompt.trim() ? c.prompt.trim() : null }] : []));
    if (typeof input?.question === 'string' && valid.length > 0) offer = { question: input.question.trim(), choices: valid.slice(0, 4) };
  }
  return offer;
}

/**
 * How many tokens the session's context holds: what Claude's last call in the conversation (not a subagent's) read and
 * wrote, as the session records its usage. Null before Claude has answered.
 */
export function contextTokens(lines: readonly SessionLine[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.type !== 'assistant' || line.parent_tool_use_id) continue;
    const usage = (line.message as { usage?: Record<string, unknown> } | null)?.usage;
    if (!usage) continue;
    const n = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
    return n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens');
  }
  return null;
}

/**
 * The conversation in a PR's Claude session: each prompt and Claude's answer. Prompts PR Review sent carry a header
 * (see `readPrompt`) that gives back what they were about; the others were typed in Claude Desktop or Claude Code.
 * What Claude says once something it started in the background has finished belongs to the answer that started it.
 */
export function buildConversation(lines: readonly SessionLine[]): Exchange[] {
  const exchanges: Exchange[] = [];
  const states = new Map<Exchange, ClaudeStreamState>();
  type Current = { exchange: Exchange; state: ClaudeStreamState };
  let current: Current | null = null;
  for (const line of lines) {
    if (line.parent_tool_use_id) continue;
    const text = line.type === 'user' ? promptText(line.message) : null;
    const finished = text !== null ? finishedInBackground(text) : null;
    if (finished !== null) {
      // Claude answers it next, as more of the latest answer: not done until that turn ends.
      const ongoing = current as Current | null;
      const exchange = ongoing?.exchange ?? exchanges.at(-1);
      if (exchange) {
        const state = ongoing?.state ?? states.get(exchange) ?? EMPTY_STREAM;
        current = { exchange, state: { ...state, activity: [...state.activity, finished] } };
        exchange.activity = current.state.activity;
        exchange.done = false;
        states.set(exchange, current.state);
      }
      continue;
    }
    if (text !== null) {
      // A question queued while Claude answered the one before goes into the same turn, so that one has no end of its
      // own: it was answered all the same.
      if (current && line.isQueuedCommand && !COMMAND.test(text)) current.exchange.done = true;
      current = null;
      if (COMMAND.test(text)) continue;
      const request = readPrompt(text);
      const exchange: Exchange = {
        id: line.uuid,
        asked: request ? 'app' : 'elsewhere',
        request: request ?? { kind: 'prompt', prompt: text, target: null },
        at: line.timestamp ?? null,
        endedAt: null,
        reply: '',
        activity: [],
        draftIds: [],
        offer: null,
        done: false,
      };
      exchanges.push(exchange);
      current = { exchange, state: EMPTY_STREAM };
      continue;
    }
    if (!current || (line.type !== 'assistant' && line.type !== 'user')) continue;
    const { exchange } = current;
    if (line.type === 'assistant' && line.timestamp) exchange.endedAt = line.timestamp;
    current.state = foldClaudeMessage(current.state, line);
    states.set(exchange, current.state);
    exchange.reply = current.state.reply;
    exchange.activity = current.state.activity;
    if (line.type === 'user') for (const id of addedDrafts(line.message)) if (!exchange.draftIds.includes(id)) exchange.draftIds.push(id);
    if (line.type === 'assistant') exchange.offer = offered(line.message) ?? exchange.offer;
    if (line.type === 'assistant' && (line.message as { stop_reason?: unknown } | null)?.stop_reason === 'end_turn') exchange.done = true;
  }
  return exchanges;
}
