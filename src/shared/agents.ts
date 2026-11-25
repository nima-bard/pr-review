import type { AgentConnector, AgentRequest, PrSnapshot } from './model';

/** Settings › Agents presets; Claude Code is the default. */
export const AGENT_PRESETS: Omit<AgentConnector, 'id'>[] = [
  { name: 'Claude', kind: 'claude-code', command: '', model: '' },
  { name: 'Claude Desktop', kind: 'claude-desktop', command: '', model: '' },
  { name: 'Claude in a terminal', kind: 'claude-terminal', command: '', model: '' },
  { name: 'Codex', kind: 'command', command: 'codex exec "$PR_PROMPT"', model: '' },
  { name: 'Gemini', kind: 'command', command: 'gemini -p "$PR_PROMPT"', model: '' },
];

/** What each connector kind does, for Settings. */
export const CONNECTOR_KINDS: Record<AgentConnector['kind'], { label: string; desc: string }> = {
  'claude-code': { label: 'Claude Code (in the app)', desc: 'One Claude Code session per pull request, run by the app; the conversation shows in the Agent panel and opens in Claude Desktop.' },
  'claude-desktop': { label: 'Claude Desktop (hand-off)', desc: 'Opens a new Claude Desktop session with the request filled in; you press Enter there. Drafts come back over MCP.' },
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

/** A short label for a request, for the Agent panel and ask cards. */
export function requestLabel(request: AgentRequest): string {
  if (request.kind === 'review') return 'Review the pull request';
  if (request.kind === 'lines' && request.target) {
    const t = request.target;
    const lines = t.startLine === t.endLine ? `${t.endLine}` : `${t.startLine}–${t.endLine}`;
    return `${t.path}:${lines}${t.side === 'LEFT' ? ' (old)' : ''}`;
  }
  return 'Request';
}

/**
 * The prompt an agent gets for `request`. Plain words, no leading "/" (which Claude Desktop links disarm), and the
 * same rule every time: comments go to PR Review as drafts, nothing to GitHub.
 */
export function agentPrompt(snapshot: PrSnapshot, request: AgentRequest, context: LineContext | null = null): string {
  const { key, details, worktree } = snapshot;
  const rules = `Don't post anything to GitHub: add review comments as drafts with the pr-review tool add_draft (pr "${key}").`;
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
      `If a review comment is warranted, add it with add_draft (path "${t.path}", line ${t.endLine}${t.startLine !== t.endLine ? `, start_line ${t.startLine}` : ''}, side "${t.side}"). Otherwise answer briefly why not.`,
      rules,
    ].join('\n');
  }
  return `${request.prompt.trim()}\n\nContext: pull request ${details.url} (PR Review key "${key}"), checked out at ${worktree.path}. ${rules}`;
}
