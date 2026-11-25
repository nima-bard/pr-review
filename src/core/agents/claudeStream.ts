/** What a `claude -p --output-format stream-json --verbose` run has said so far. */
export interface ClaudeStreamState {
  /** The assistant's text, its messages separated by blank lines. */
  reply: string;
  /** Tool activity worth showing ("Read src/a.ts", "Added a draft on src/a.ts:42"). */
  activity: string[];
  /** The session the run wrote to (a new id after --fork-session). */
  sessionId: string | null;
  costUsd: number | null;
  /** Set when the run ended with an error result. */
  error: string | null;
  /** The result message arrived. */
  done: boolean;
  /** tool_use id → index in `activity`, to mark a rejected call. */
  tools: Record<string, number>;
}

export const EMPTY_STREAM: ClaudeStreamState = { reply: '', activity: [], sessionId: null, costUsd: null, error: null, done: false, tools: {} };

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean };
type Message =
  | { type: 'system'; subtype?: string; session_id?: string }
  | { type: 'assistant'; message?: { content?: Block[] } }
  | { type: 'user'; message?: { content?: Block[] | string } }
  | { type: 'result'; subtype?: string; is_error?: boolean; result?: string; session_id?: string; total_cost_usd?: number; errors?: string[] };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A tool call as one line for the Agent panel, or null for plumbing not worth showing. */
export function describeTool(name: string, input: Record<string, unknown>): string | null {
  const path = str(input.file_path) || str(input.path);
  switch (name) {
    case 'mcp__pr-review__add_draft': {
      const line = input.start_line ? `${String(input.start_line)}–${String(input.line)}` : String(input.line);
      return `Added a draft on ${str(input.path)}:${line}`;
    }
    case 'mcp__pr-review__update_draft':
      return 'Changed a draft';
    case 'mcp__pr-review__delete_draft':
      return 'Deleted a draft';
    case 'Read':
      return `Read ${path}`;
    case 'Grep':
      return `Searched for ${clip(str(input.pattern), 60)}`;
    case 'Glob':
      return `Listed ${clip(str(input.pattern), 60)}`;
    case 'Bash':
      return `Ran ${clip(str(input.command))}`;
    case 'Skill':
      return `Used the ${str(input.skill) || str(input.command)} skill`;
    case 'Edit':
    case 'Write':
      return `Edited ${path}`;
    case 'ToolSearch':
    case 'TodoWrite':
      return null;
    default:
      return name.startsWith('mcp__pr-review__') ? null : name.replace(/^mcp__([^_]+)__/, '$1: ');
  }
}

/** Folds one stdout line into the state; lines that aren't JSON messages are ignored. */
export function parseClaudeLine(state: ClaudeStreamState, line: string): ClaudeStreamState {
  let msg: Message;
  try {
    msg = JSON.parse(line) as Message;
  } catch {
    return state;
  }
  if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) return { ...state, sessionId: msg.session_id };
  if (msg.type === 'assistant') {
    let next = state;
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) next = { ...next, reply: next.reply ? `${next.reply}\n\n${block.text.trim()}` : block.text.trim() };
      if (block.type === 'tool_use' && block.name) {
        const label = describeTool(block.name, block.input ?? {});
        if (label) next = { ...next, activity: [...next.activity, label], tools: block.id ? { ...next.tools, [block.id]: next.activity.length } : next.tools };
      }
    }
    return next;
  }
  if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    let next = state;
    for (const block of msg.message.content) {
      const at = block.type === 'tool_result' && block.is_error && block.tool_use_id ? next.tools[block.tool_use_id] : undefined;
      if (at !== undefined) next = { ...next, activity: next.activity.map((a, i) => (i === at ? `${a} (rejected)` : a)) };
    }
    return next;
  }
  if (msg.type === 'result') {
    const failed = msg.is_error === true || (msg.subtype !== undefined && msg.subtype !== 'success');
    return {
      ...state,
      done: true,
      sessionId: msg.session_id ?? state.sessionId,
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : state.costUsd,
      reply: state.reply || (failed ? '' : str(msg.result)),
      error: failed ? str(msg.result) || msg.errors?.join('\n') || `Claude stopped (${msg.subtype ?? 'error'}).` : null,
    };
  }
  return state;
}
