import type { ContextMenuItem } from './ipc';
import type { AgentRequest, ClaudeApp, ClaudeEffort, ClaudeModel, ClaudeModelChoice, ClaudeView, LineTarget, PrSnapshot } from './model';

/** The Claude apps a pull request's session opens in, by name. */
export const CLAUDE_APPS: Record<ClaudeApp, { name: string }> = {
  desktop: { name: 'Claude Desktop' },
  terminal: { name: 'Claude Code' },
};

/**
 * The name of a PR's Claude Code session, as Claude Desktop lists it: "PR #12 · fix(login): retry once on a timeout…". The
 * same every time, so the PR has one recognisable session. Null without a number.
 */
export function sessionTitle(number: string | undefined, title: string | undefined): string | null {
  if (!number) return null;
  const name = `PR #${number}${title?.trim() ? ` · ${title.trim()}` : ''}`;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

/** Claude Code's effort levels by name, as its /effort shows them. */
export const EFFORT_NAMES: Record<ClaudeEffort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** The models to choose from: Claude Code's default (the empty model) first, and a saved model the list lacks kept. */
export function modelChoices(models: readonly ClaudeModel[], saved: string): ClaudeModel[] {
  return [
    ...(models.some((m) => m.value === '') ? [] : [{ value: '', name: 'Claude Code’s default', description: '', efforts: [] }]),
    ...models,
    ...(saved && !models.some((m) => m.value === saved) ? [{ value: saved, name: saved, description: 'Saved earlier', efforts: [] }] : []),
  ];
}

/**
 * The model and effort in use, short, for the conversation's picker as Claude Desktop shows it: "Opus 5.5" and
 * "Extra". Claude Code's default model is named by what it is when Claude Code says ("Opus 5.5 · Best for…").
 */
export function modelLabel(models: readonly ClaudeModel[], c: ClaudeModelChoice): { model: string; effort: string | null } {
  const model = modelChoices(models, c.model).find((m) => m.value === c.model);
  const defaultIs = c.model === '' && model?.description.includes(' · ') ? model.description.split(' · ')[0]! : null;
  const name = c.model === '' ? (defaultIs ?? 'Default') : (model?.name ?? c.model);
  const effort = c.effort && model?.efforts.includes(c.effort) ? (c.effort === 'xhigh' ? 'Extra' : EFFORT_NAMES[c.effort]) : null;
  return { model: name, effort };
}

/**
 * The conversation's model menu: the models, the chosen one's effort levels (none for a model without them), and going
 * back to Settings › Claude's default (`fromSettings` says whether the conversation uses it now).
 */
export function modelMenuItems(models: readonly ClaudeModel[], c: ClaudeModelChoice, fromSettings: boolean): ContextMenuItem[] {
  const choices = modelChoices(models, c.model);
  const efforts = choices.find((m) => m.value === c.model)?.efforts ?? [];
  return [
    { id: 'heading:model', label: 'Model', enabled: false },
    ...choices.map((m) => ({ id: `model:${m.value}`, label: m.name, checked: m.value === c.model })),
    'separator',
    { id: 'heading:effort', label: efforts.length > 0 ? 'Effort' : 'Effort (not for this model)', enabled: false },
    { id: 'effort:', label: 'The model’s default', checked: !efforts.includes(c.effort as ClaudeEffort), enabled: efforts.length > 0 },
    ...efforts.map((e) => ({ id: `effort:${e}`, label: EFFORT_NAMES[e], checked: c.effort === e })),
    'separator',
    { id: 'default', label: 'The default from Settings › Claude', checked: fromSettings, enabled: !fromSettings },
  ];
}

/**
 * What a choice in that menu makes: a model and effort, "default" (Settings › Claude's), or null for none. A model
 * without the chosen effort level goes back to its default effort.
 */
export function modelChoice(models: readonly ClaudeModel[], c: ClaudeModelChoice, choice: string | null): ClaudeModelChoice | 'default' | null {
  if (choice === 'default') return 'default';
  if (choice?.startsWith('model:')) {
    const model = modelChoices(models, c.model).find((m) => m.value === choice.slice('model:'.length));
    if (!model) return null;
    return { model: model.value, effort: c.effort && model.efforts.includes(c.effort) ? c.effort : '' };
  }
  const effort = choice?.startsWith('effort:') ? choice.slice('effort:'.length) : null;
  if (effort === '' || (effort !== null && effort in EFFORT_NAMES)) return { model: c.model, effort: effort as ClaudeEffort | '' };
  return null;
}

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
 * A short label for a request, for the conversation and ask markers. `fileName`: only the file's name, not its folders,
 * for headers where a long path would push the line number out of sight (the full label goes in the tooltip).
 */
export function requestLabel(request: AgentRequest, { fileName = false } = {}): string {
  if (request.kind === 'lines' && request.target) {
    const t = request.target;
    const lines = t.startLine === t.endLine ? `${t.endLine}` : `${t.startLine}–${t.endLine}`;
    const path = fileName ? (t.path.split('/').at(-1) ?? t.path) : t.path;
    return `${path}:${lines}${t.side === 'LEFT' ? ' (old)' : ''}`;
  }
  return 'Request';
}

/** A question, as the diff's markers and the conversation show it: in the session, or still on its way to it. */
export interface Ask {
  id: string;
  request: AgentRequest;
  status: 'waiting' | 'sent' | 'failed' | 'answering' | 'answered' | 'stopped';
}

/**
 * Every question of a PR's Claude view, oldest first. One in the session is answered once Claude's turn ended; the
 * last one is being answered while someone is answering in the session; any other was stopped before the end.
 */
export function asks(view: ClaudeView): Ask[] {
  const last = view.exchanges.at(-1)?.id;
  return [
    ...view.exchanges.map((e): Ask => ({ id: e.id, request: e.request, status: e.done ? 'answered' : e.id === last && view.busy ? 'answering' : 'stopped' })),
    ...view.pending.map((p): Ask => ({ id: p.id, request: p.request, status: p.state })),
  ];
}

/** Where your words end in a prompt PR Review sends, and the context and rules it adds begin. */
const CONTEXT = '--- PR Review context ---';

/**
 * The first line of every prompt PR Review sends: what it is about. The app reads it back from the session (see
 * `readPrompt`), which is how a question keeps its Go to line and its marker without the app keeping a copy.
 */
export function promptHeader(request: AgentRequest): string {
  if (request.kind === 'lines' && request.target) {
    const t = request.target;
    return `PR Review · ${t.path}, ${t.side === 'LEFT' ? 'old' : 'new'} lines ${t.startLine}–${t.endLine}`;
  }
  return 'PR Review · request';
}

const HEADER = /^PR Review · (?:(request)|(.+), (new|old) lines (\d+)–(\d+))$/;

/** The request a prompt in the session came from, when PR Review sent it (its header); null for one typed elsewhere. */
export function readPrompt(text: string): AgentRequest | null {
  const [first = '', ...rest] = text.split('\n');
  const m = HEADER.exec(first.trim());
  if (!m) return null;
  const body = rest.join('\n');
  const end = body.indexOf(CONTEXT);
  const prompt = (end >= 0 ? body.slice(0, end) : body).trim();
  if (m[1]) return { kind: 'prompt', prompt, target: null };
  return { kind: 'lines', prompt, target: { path: m[2]!, side: m[3] === 'old' ? 'LEFT' : 'RIGHT', startLine: Number(m[4]), endLine: Number(m[5]) } };
}

/**
 * How the app's Claude works with PR Review, given once as its system prompt (`--append-system-prompt`) for each run on
 * the pull request's session, instead of in every prompt: the prompts in the session stay short, and so does Claude
 * Desktop's view of it. A question gets an answer and nothing else; a request to do something in PR Review uses its
 * tools; only a request for a comment or a change becomes a review comment.
 */
export function claudeSystemPrompt(snapshot: PrSnapshot): string {
  const { key, details, worktree } = snapshot;
  return [
    `You are working inside PR Review, the macOS app where the user reviews GitHub pull request ${details.url} (PR Review key "${key}"). It is checked out at ${worktree.path}, your working directory: use it instead of creating another worktree.`,
    `Prompts from PR Review start with a header: "PR Review · request", or "PR Review · <path>, new|old lines A–B" for a question about those lines. After the user's words, "${CONTEXT}" gives the lines' code, the review comments on them and where a comment on them goes.`,
    'How to respond: decide from each request whether it asks a question, asks you to do something in PR Review, or asks for a review comment.',
    '- A question, or a request to check, investigate or explain something: answer it in your reply only. Do not add a review comment, even if you find a problem: describe it in the answer, and the user can ask for a comment.',
    '- A request to do something in PR Review (mark files as viewed, show or find a file, a line, a comment or where something is): do it with the pr-review tools (set_viewed, show_in_app, search_code with show), then say in one line what you did. get_pr lists the files, which are viewed, and the review threads.',
    `- A request for a comment, or for a change to the code or its wording (rephrase, rename, fix, suggest…): add exactly one review comment with the pr-review tool add_draft (pr "${key}"; for lines, where their context says), and say in your reply what it says.`,
    'If your answer leads to one follow-up you could do in PR Review (a review comment, marking files as viewed, showing something), don’t ask about it in words: end with the pr-review tool offer_choices, a short question and its choices (e.g. "Yes, leave a comment", with the prompt to send you, and "No"), then stop.',
    'When a request needs reading across many files, have a subagent do the search and keep only what it found, so this conversation stays short. Keep answers short: the user reads them in a side panel.',
    'Never post anything to GitHub: review comments go to the user’s review as drafts, with add_draft, and the user submits them.',
  ].join('\n');
}

/** What a line question adds after your words: the lines' code, the review comments on them, and where a comment goes. */
function linesContext(t: LineTarget, context: LineContext | null): string {
  const threads = context?.threads ?? [];
  return [
    `${t.path}, ${t.side === 'LEFT' ? 'old' : 'new'} lines ${t.startLine}–${t.endLine}:`,
    '```',
    context?.code ?? '(lines unavailable)',
    '```',
    ...(threads.length > 0 ? ['Review comments already on these lines:', ...threads.map((c) => `- ${c.author}: ${c.body.replace(/\s+/g, ' ').trim()}`)] : []),
    `A comment on these lines goes there: add_draft (path "${t.path}", line ${t.endLine}${t.startLine !== t.endLine ? `, start_line ${t.startLine}` : ''}, side "${t.side}").`,
  ].join('\n');
}

/**
 * The prompt Claude gets for `request`: the header (what it's about), your words, and for lines their context. The
 * rules are in the system prompt (`claudeSystemPrompt`). Plain words, no leading "/" (which Claude Desktop links disarm).
 */
export function claudePrompt(request: AgentRequest, context: LineContext | null = null): string {
  const words = request.prompt.trim();
  const lines = request.kind === 'lines' && request.target ? linesContext(request.target, context) : null;
  return [promptHeader(request), '', words, ...(lines ? ['', CONTEXT, lines] : [])].join('\n');
}
