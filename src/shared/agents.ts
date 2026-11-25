import type { AgentConnector, AgentRequest, PrSnapshot } from './model';

/** Settings › Agents presets; Claude Code is the default. */
export const AGENT_PRESETS: Omit<AgentConnector, 'id'>[] = [
  { name: 'Claude', kind: 'claude-code', command: '', model: '' },
  { name: 'Claude in a terminal', kind: 'claude-terminal', command: '', model: '' },
  { name: 'Codex', kind: 'command', command: 'codex exec "$PR_PROMPT"', model: '' },
  { name: 'Gemini', kind: 'command', command: 'gemini -p "$PR_PROMPT"', model: '' },
];

/**
 * The name of a PR's Claude Code session, as Claude Desktop lists it: "PR #3022 · ci(pipelines): link Azure…". The
 * same every time, so the PR has one recognisable session. Null without a number.
 */
export function sessionTitle(number: string | undefined, title: string | undefined): string | null {
  if (!number) return null;
  const name = `PR #${number}${title?.trim() ? ` · ${title.trim()}` : ''}`;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

/** Whether `kind` is one the app still has (saved settings may hold a removed one, like the old Desktop hand-off). */
export const isConnectorKind = (kind: string): kind is AgentConnector['kind'] => Object.hasOwn(CONNECTOR_KINDS, kind);

/** What each connector kind does, for Settings. */
export const CONNECTOR_KINDS: Record<AgentConnector['kind'], { label: string; desc: string }> = {
  'claude-code': { label: 'Claude Code (in the app)', desc: 'One Claude Code session per pull request, run by the app; the conversation shows in the Agent panel and opens in Claude Desktop.' },
  'claude-terminal': {
    label: 'Claude Code (in a terminal)',
    desc: 'A live Claude Code session in your terminal that the app pushes requests into (channels, a research preview). Replies stay in the terminal.',
  },
  command: { label: 'Command', desc: 'Any command line, run in the worktree with the PR_* variables, PR_PROMPT (the request) and PR_REQUEST_FILE (it as JSON). Its output is the reply.' },
};

/** "/ask …" or "/claude …" typed in the composer: an ask, with the prefix (and quotes around the rest) removed. */
export function askPrefix(text: string): string | null {
  const m = /^\s*\/(ask|claude)\b\s*/i.exec(text);
  return m ? text.slice(m[0].length).replace(/^"(.*)"$/s, '$1') : null;
}

/** What the app adds to a line ask: the lines, and the review threads on them. */
export interface LineContext {
  code: string | null;
  threads: { author: string; body: string }[];
}

/**
 * A short label for a request, for the Agent panel and ask cards. `fileName`: only the file's name, not its folders,
 * for headers where a long path would push the line number out of sight (the full label goes in the tooltip).
 */
export function requestLabel(request: AgentRequest, { fileName = false } = {}): string {
  if (request.kind === 'review') return 'Review the pull request';
  if (request.kind === 'lines' && request.target) {
    const t = request.target;
    const lines = t.startLine === t.endLine ? `${t.endLine}` : `${t.startLine}–${t.endLine}`;
    const path = fileName ? (t.path.split('/').at(-1) ?? t.path) : t.path;
    return `${path}:${lines}${t.side === 'LEFT' ? ' (old)' : ''}`;
  }
  return 'Request';
}

/**
 * What to do with a request about the code, said the same way every time: a question gets an answer and nothing else;
 * only a request for a comment or a change becomes a review comment. `where` names the lines for add_draft.
 */
function answerOrComment(where: string | null): string {
  return [
    'How to respond: decide from the request above whether it asks a question or asks for a review comment.',
    '- A question, or a request to check, investigate or explain something: answer it in your reply only. Do not add a review comment, even if you find a problem: describe it in the answer, and the user can ask for a comment.',
    `- A request for a comment, or for a change to the code or its wording (rephrase, rename, fix, suggest…): add exactly one review comment with the pr-review tool add_draft${where ? ` (${where})` : ''}, and say in your reply what it says.`,
  ].join('\n');
}

/**
 * The prompt an agent gets for `request`. Plain words, no leading "/" (which Claude Desktop links disarm), and the
 * same rules every time: review comments go to PR Review as drafts, nothing to GitHub, and a question is only answered.
 */
export function agentPrompt(snapshot: PrSnapshot, request: AgentRequest, context: LineContext | null = null): string {
  const { key, details, worktree } = snapshot;
  const rules = `Don't post anything to GitHub: review comments go to the user's review as drafts, with the pr-review tool add_draft (pr "${key}").`;
  if (request.kind === 'review') {
    return [
      `Review pull request ${details.url} with the code-review skill. You are working inside PR Review.`,
      `The PR is checked out at ${worktree.path}; use it instead of creating another worktree.`,
      `${rules} Keep the comment text and trailer the skill would post. Finish with the summary.`,
    ].join('\n');
  }
  if (request.kind === 'lines' && request.target) {
    const t = request.target;
    const where = `file ${t.path}, ${t.side === 'LEFT' ? 'old' : 'new'} lines ${t.startLine}–${t.endLine}`;
    const threads = context?.threads ?? [];
    return [
      request.prompt.trim(),
      '',
      `Context: pull request ${details.url} (PR Review key "${key}"), checked out at ${worktree.path}; ${where}:`,
      '```',
      context?.code ?? '(lines unavailable)',
      '```',
      ...(threads.length > 0 ? ['Review comments already on these lines:', ...threads.map((c) => `- ${c.author}: ${c.body.replace(/\s+/g, ' ').trim()}`)] : []),
      '',
      answerOrComment(`path "${t.path}", line ${t.endLine}${t.startLine !== t.endLine ? `, start_line ${t.startLine}` : ''}, side "${t.side}"`),
      rules,
    ].join('\n');
  }
  return [`${request.prompt.trim()}`, '', `Context: pull request ${details.url} (PR Review key "${key}"), checked out at ${worktree.path}.`, '', answerOrComment(null), rules].join('\n');
}
