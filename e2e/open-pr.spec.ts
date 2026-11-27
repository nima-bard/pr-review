import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api } from '../src/shared/ipc';
import { appendSession } from '../test/helpers/claudeSession';

const L =(...ls: string[]) => `${ls.join('\n')}\n`;
const BASE_FILE = L('export function total(items: number[]): number {', '  let sum = 0;', '  for (const i of items) {', '    sum += i;', '  }', '  return sum;', '}');
const V1_FILE = BASE_FILE.replace('  return sum;', '  return sum * 0.9;');
const V2_FILE = L('// Applies the loyalty discount.', '// See pricing.md.') + V1_FILE.replace('    sum += i;', '    sum += Math.max(i, 0);');

interface Fixture {
  root: string;
  base: string;
  v1: string;
  v2: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'prr-e2e-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const bare = join(root, 'remote.git');
  const clones = join(root, 'source');
  const work = join(clones, 'demo');
  mkdirSync(work, { recursive: true });
  git(root, 'init', '-q', '--bare', bare);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(work, 'src'));
  const commit = (content: string, msg: string) => {
    writeFileSync(join(work, 'src/calc.ts'), content);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', msg);
    return git(work, 'rev-parse', 'HEAD');
  };
  const base = commit(BASE_FILE, 'base');
  git(work, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  git(work, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/demo.git');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  const v1 = commit(V1_FILE, 'discount');
  const v2 = commit(V2_FILE, 'clamp negatives');
  git(work, 'push', '-q', 'origin', `${v2}:refs/pull/1/head`);
  git(work, 'checkout', '-q', 'main');
  git(work, 'branch', '-q', '-D', 'feature');
  return { root, base, v1, v2 };
}

function mockGitHub(fx: Fixture, received: { query: string; vars: Record<string, unknown> }[]): Server {
  const comment = (id: string, body: string, original: string, hunk: string) => ({
    id,
    databaseId: 1,
    url: `https://github.com/acme/demo/pull/1#discussion_${id}`,
    body,
    bodyHTML: `<p>${body}</p>`,
    diffHunk: hunk,
    createdAt: '2026-11-01T10:00:00Z',
    state: 'SUBMITTED',
    viewerDidAuthor: false,
    author: { login: 'mira', avatarUrl: '' },
    originalCommit: { oid: original },
    commit: { oid: fx.v2 },
  });
  const threads = [
    {
      id: 'T_outdated',
      isOutdated: true,
      isResolved: false,
      viewerCanReply: true,
      viewerCanResolve: true,
      viewerCanUnresolve: false,
      path: 'src/calc.ts',
      diffSide: 'RIGHT',
      subjectType: 'LINE',
      line: null,
      startLine: null,
      originalLine: 4,
      originalStartLine: null,
      comments: { nodes: [comment('C1', 'Can items be negative here?', fx.v1, '@@ -1,6 +1,6 @@\n export function total(items: number[]): number {\n   let sum = 0;\n   for (const i of items) {\n     sum += i;')] },
    },
  ];
  const data = (q: string): unknown => {
    if (q.includes('viewer {') && !q.includes('pullRequest')) return { viewer: { login: 'reviewer' } };
    if (q.includes('search(')) return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
    if (q.includes('reviewThreads(')) return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } };
    if (q.includes('viewerViewedState')) return { repository: { pullRequest: { files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ path: 'src/calc.ts', viewerViewedState: 'UNVIEWED' }] } } } };
    if (q.includes('pending: reviews')) return { repository: { pullRequest: { pending: { nodes: [] }, last: { nodes: [] } } } };
    if (q.includes('timelineItems')) return { repository: { pullRequest: { comments: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } };
    if (q.includes('addPullRequestReview(')) return { addPullRequestReview: { pullRequestReview: { id: 'R1' } } };
    if (q.includes('addPullRequestReviewThread(')) return { addPullRequestReviewThread: { thread: { id: 'T_new' } } };
    if (q.includes('submitPullRequestReview(')) return { submitPullRequestReview: { pullRequestReview: { id: 'R1', state: 'COMMENTED' } } };
    if (q.includes('headRefOid')) {
      return {
        repository: {
          pullRequest: {
            id: 'PR_1', number: 1, title: 'Apply loyalty discount', url: 'https://github.com/acme/demo/pull/1', state: 'OPEN', isDraft: false,
            createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-02T09:00:00Z', body: 'Implements AB#4711.', bodyHTML: '<p>Implements AB#4711.</p>',
            author: { login: 'jonas', avatarUrl: '' }, baseRefName: 'main', baseRefOid: fx.base, headRefName: 'feature', headRefOid: fx.v2,
            headRepositoryOwner: { login: 'acme' }, isCrossRepository: false, maintainerCanModify: false, viewerDidAuthor: false,
            reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', additions: 4, deletions: 2, changedFiles: 1,
            commits: { totalCount: 2 }, labels: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, reviewRequests: { nodes: [] },
            closingIssuesReferences: { nodes: [] }, lastCommit: { nodes: [{ commit: { statusCheckRollup: null } }] },
          },
        },
      };
    }
    return {};
  };
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(304).end();
        return;
      }
      const body = JSON.parse(raw || '{}') as { query: string; variables: Record<string, unknown> };
      received.push({ query: body.query, vars: body.variables });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: data(body.query) }));
    });
  });
}

/**
 * A stand-in for `claude -p --input-format stream-json`: it takes prompts on stdin one after another, writes them and its
 * answers into the session file under CLAUDE_CONFIG_DIR (as Claude Code does, for the app to read back through the
 * Agent SDK), adds a draft through the PR Review MCP server named in --mcp-config where a prompt says add_draft goes
 * (for the pull request its --append-system-prompt names), and prints stream-json. It exits when stdin ends.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const server = JSON.parse(at('--mcp-config')).mcpServers['pr-review'];
const sid = args.includes('--session-id') ? at('--session-id') : at('--resume');
// The app gives the rules and the pull request once, in the system prompt; the prompts carry only the request.
const system = at('--append-system-prompt');
const cwd = realpathSync(process.cwd());
const folder = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
const file = join(folder, sid + '.jsonl');
mkdirSync(folder, { recursive: true });
let parent = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').trim().split('\\n').pop()).uuid : null;
const record = (type, message) => {
  const uuid = randomUUID();
  const line = { type, uuid, parentUuid: parent, sessionId: sid, cwd, timestamp: new Date().toISOString(), isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', version: '2.1.0', message };
  appendFileSync(file, JSON.stringify(line) + '\\n');
  parent = uuid;
};
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const headers = { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const call = (id, method, params) => fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then((r) => r.text());
const toolText = (sse) => JSON.parse(sse.split('\\n').find((l) => l.startsWith('data: ')).slice(6)).result.content[0].text;
async function answer(prompt) {
  out({ type: 'system', subtype: 'init', session_id: sid });
  record('user', { role: 'user', content: prompt });
  // Asked whether the list is complete, it answers and offers a comment as buttons (offer_choices).
  if (/Is the list complete\\?/.test(prompt)) {
    const offer = { question: 'Leave a comment about it?', choices: [{ label: 'Yes, leave a comment', prompt: 'Yes, write that comment.' }, { label: 'No', prompt: null }] };
    record('assistant', { role: 'assistant', content: [{ type: 'text', text: 'No: two processors are missing.' }, { type: 'tool_use', id: 't2', name: 'mcp__pr-review__offer_choices', input: offer }], stop_reason: 'tool_use' });
    record('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'Shown as buttons.' }] }] });
    record('assistant', { role: 'assistant', content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'offered', session_id: sid });
    return;
  }
  const where = /add_draft \\(path "([^"]+)", line (\\d+)/.exec(prompt);
  if (where) {
    const input = { pr: /pr "([^"]+)"/.exec(system)[1], path: where[1], line: Number(where[2]), body: 'Negative items lower the total: clamp them.' };
    record('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__pr-review__add_draft', input }], stop_reason: 'tool_use' });
    await call(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
    const text = toolText(await call(1, 'tools/call', { name: 'add_draft', arguments: input }));
    record('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text }] }] });
  }
  const reply = where ? 'Yes, negative items would lower the total. I added a comment.' : 'Noted.';
  record('assistant', { role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid });
}
let queue = Promise.resolve();
createInterface({ input: process.stdin })
  .on('line', (line) => {
    queue = queue.then(() => answer(JSON.parse(line).message.content[0].text));
  })
  .on('close', () => queue.then(() => process.exit(0)));
`;

const MCP_TOKEN = 'e2e-mcp-token';
let mcpPort = 0;

let fx: Fixture;
let server: Server;
let app: ElectronApplication;
let win: Page;
const received: { query: string; vars: Record<string, unknown> }[] = [];

test.beforeAll(async () => {
  fx = makeFixture();
  server = mockGitHub(fx, received);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const userData = join(fx.root, 'userdata');
  mkdirSync(join(userData, 'pr-review'), { recursive: true });
  mcpPort = 48_000 + Math.floor(Math.random() * 1000);
  writeFileSync(
    join(userData, 'pr-review', 'state.json'),
    JSON.stringify({
      settings: { scanRoots: [join(fx.root, 'source')], worktreeRoot: null, editorCommand: 'true', placeThreshold: 0.7, guessThreshold: 0.5, aiEnabled: false, aiModel: 'haiku', mcpPort, claude: { enabled: true, model: '' } },
      repos: [],
      openTabs: [],
      ownedWorktrees: [],
    }),
  );
  const fakeClaude = join(fx.root, 'fake-claude.mjs');
  writeFileSync(fakeClaude, FAKE_CLAUDE);
  chmodSync(fakeClaude, 0o755);
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, PR_REVIEW_USER_DATA: userData, PR_REVIEW_API: `http://127.0.0.1:${port}`, PR_REVIEW_TOKEN: 'test-token', PR_REVIEW_MCP_TOKEN: MCP_TOKEN, PR_REVIEW_CLAUDE: fakeClaude, CLAUDE_CONFIG_DIR: join(fx.root, 'claude') },
  });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  server?.close();
  rmSync(fx.root, { recursive: true, force: true });
});

test('opens a PR into a worktree, re-anchors an outdated thread and submits a review', async () => {
  await win.getByPlaceholder('https://github.com/owner/repo/pull/123').fill('acme/demo#1');
  await win.keyboard.press('Enter');
  await expect(win.getByRole('heading', { name: 'Apply loyalty discount' })).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('footer').getByText('demo.worktrees/pr-1')).toBeVisible();

  // PRs open on the Overview, which lists the review threads; the thread is then checked in the diff.
  const threads = win.getByRole('region', { name: 'Review threads' });
  await expect(threads).toContainText('Can items be negative here?', { timeout: 20_000 });
  await win.getByRole('navigation', { name: 'Overview, files and commits' }).getByRole('button', { name: 'Files', exact: true }).click();

  const card = win.locator('[id="thread-T_outdated"]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Line 6');
  await expect(card).toContainText(/Outdated · (Re-anchored|Best guess)/);
  await expect(card).toContainText('Can items be negative here?');

  await win.evaluate(() =>
    (globalThis as unknown as { api: Api }).api.saveDraft('github.com/acme/demo#1', {
      id: 'd1',
      path: 'src/calc.ts',
      subject: 'line',
      side: 'RIGHT',
      line: 8,
      body: 'Discount should come from config.',
      headOid: '',
      createdAt: new Date().toISOString(),
    }),
  );
  await win.getByRole('button', { name: /Submit review/ }).first().click();
  await expect(win.getByRole('dialog', { name: 'Submit your review' })).toBeVisible();
  await win.getByLabel('Summary').fill('Two small things.');
  await win.getByRole('dialog').getByRole('button', { name: 'Submit review' }).click();
  await expect(win.getByRole('dialog', { name: 'Submit your review' })).toBeHidden({ timeout: 20_000 });

  const thread = received.find((r) => r.query.includes('addPullRequestReviewThread('));
  expect(thread?.vars).toMatchObject({ reviewId: 'R1', path: 'src/calc.ts', line: 8, side: 'RIGHT', body: 'Discount should come from config.' });
  const submit = received.find((r) => r.query.includes('submitPullRequestReview('));
  expect(submit?.vars).toMatchObject({ reviewId: 'R1', event: 'COMMENT', body: 'Two small things.' });
});

test('an agent adds a draft over MCP: it is in your review right away and goes out when you submit', async () => {
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}`, 'X-PR-Review-Agent': 'Codex' } } }),
  );
  const res = (await client.callTool({ name: 'add_draft', arguments: { pr: 'acme/demo#1', path: 'src/calc.ts', line: 8, body: 'Read the rate from config.' } })) as { isError?: boolean };
  expect(res.isError).toBeFalsy();
  const outside = (await client.callTool({ name: 'add_draft', arguments: { pr: 'acme/demo#1', path: 'src/calc.ts', line: 40, body: 'x' } })) as { isError?: boolean; content: { text: string }[] };
  expect(outside.isError).toBe(true);
  expect(outside.content[0]?.text).toContain('Commentable lines');
  await client.close();

  await expect(win.getByText('Draft · from Codex', { exact: true })).toBeVisible({ timeout: 20_000 });
  await win.getByRole('button', { name: /Submit review/ }).first().click();
  const dialog = win.getByRole('dialog', { name: 'Submit your review' });
  await expect(dialog).toContainText('Local draft · from Codex');
  const before = received.length;
  await dialog.getByRole('button', { name: /^Submit review/ }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  const posted = received.slice(before).find((r) => r.query.includes('addPullRequestReviewThread('));
  expect(posted?.vars).toMatchObject({ path: 'src/calc.ts', line: 8, body: 'Read the rate from config.' });
  await expect(win.getByText('Draft · from Codex', { exact: true })).toBeHidden();
});

test('asking Claude about a line: the line gets a marker, the answer is in the side panel, its comment a draft', async () => {
  await win.evaluate(() =>
    (globalThis as unknown as { api: Api }).api.askClaude('github.com/acme/demo#1', {
      kind: 'lines',
      prompt: 'Can a negative item break this?',
      target: { path: 'src/calc.ts', side: 'RIGHT', startLine: 6, endLine: 6 },
    }),
  );
  const marker = win.locator('[id^="ask-"]');
  await expect(marker.getByText('Asked Claude:')).toBeVisible({ timeout: 20_000 });
  await expect(marker.getByText('Answered', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText('Draft · from Claude', { exact: true })).toBeVisible();
  // The answer isn't shown in the diff, only in the side panel, where Claude takes the comments' place.
  const answer = 'Yes, negative items would lower the total. I added a comment.';
  const panel = win.getByRole('region', { name: 'Claude' });
  const comments = win.getByRole('region', { name: 'Comments' });
  // Beside the files, the right panel starts on the comments.
  await expect(comments).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(win.getByText(answer)).toBeHidden();
  await win.getByRole('button', { name: 'Show in conversation' }).click();
  await expect(panel.getByText(answer)).toBeVisible();
  await expect(panel.getByText('1 comment added to your review:')).toBeVisible();
  await expect(comments).toHaveCount(0);

  // Removing the marker takes it off the line, and is saved, so a refresh doesn't bring it back.
  await win.getByRole('navigation', { name: 'Side panels' }).getByRole('button', { name: /^Comments/ }).click();
  await expect(comments).toBeVisible();
  // The panel's card says why its border is yellow: the comment's new line is a best guess.
  await expect(comments.getByText('Best guess', { exact: true })).toBeVisible();
  await expect(comments.locator('[title^="Outdated: written on an older version"]')).toBeVisible();
  await win.getByRole('button', { name: 'Hide this marker' }).click();
  await expect(win.getByText('Asked Claude:')).toHaveCount(0);
  // Kept beside the worktree (its git folder), not as a copy of the conversation.
  const view = await win.evaluate(() => (globalThis as unknown as { api: Api }).api.claudeView('github.com/acme/demo#1'));
  expect(view?.hiddenMarkers).toEqual([view?.exchanges[0]?.id]);
  expect(view?.exchanges[0]).toMatchObject({ asked: 'app', request: { kind: 'lines', prompt: 'Can a negative item break this?' }, done: true });

  // A question typed in Claude Desktop into the same session shows here too: the session is the conversation.
  const worktree = realpathSync(join(fx.root, 'source', 'demo.worktrees', 'pr-1'));
  appendSession(join(fx.root, 'claude'), worktree, view!.sessionId!, [
    { type: 'user', message: { role: 'user', content: 'Typed in Claude Desktop' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Seen from Desktop.' }], stop_reason: 'end_turn' } },
  ]);
  await expect
    .poll(async () => (await win.evaluate(() => (globalThis as unknown as { api: Api }).api.claudeView('github.com/acme/demo#1')))?.exchanges.map((e) => [e.asked, e.reply]), { timeout: 15_000 })
    .toEqual([
      ['app', 'Yes, negative items would lower the total. I added a comment.'],
      ['elsewhere', 'Seen from Desktop.'],
    ]);
});

test('Claude offers a follow-up as buttons under its answer, and a choice sends its prompt back', async () => {
  const key = 'github.com/acme/demo#1';
  await win.evaluate(
    (k) => (globalThis as unknown as { api: Api }).api.askClaude(k, { kind: 'lines', prompt: 'Is the list complete?', target: { path: 'src/calc.ts', side: 'RIGHT', startLine: 3, endLine: 3 } }),
    key,
  );
  // The strip of icons on the right shows the comments or Claude in the panel beside it; the one showing hides it again.
  const bar = win.getByRole('navigation', { name: 'Side panels' });
  const side = win.getByRole('complementary', { name: 'Side panel' });
  const claude = bar.getByRole('button', { name: 'Claude', exact: true });
  if ((await claude.getAttribute('aria-pressed')) !== 'true') await claude.click();
  await expect(claude).toHaveAttribute('aria-pressed', 'true');
  const panel = win.getByRole('region', { name: 'Claude' });
  await expect(panel.getByText('Leave a comment about it?')).toBeVisible({ timeout: 20_000 });
  await panel.getByRole('button', { name: 'Yes, leave a comment' }).click();
  // Answered by asking: the buttons go, and the choice's prompt is the next question, about the same lines.
  await expect(panel.getByRole('button', { name: 'Yes, leave a comment' })).toHaveCount(0);
  await expect
    .poll(async () => (await win.evaluate((k) => (globalThis as unknown as { api: Api }).api.claudeView(k), key))?.exchanges.at(-1), { timeout: 15_000 })
    .toMatchObject({ request: { kind: 'lines', prompt: 'Yes, write that comment.', target: { startLine: 3 } }, done: true });
  // The question typed in Claude Desktop earlier is still part of the conversation: the app's Claude started again from
  // the session as it was, rather than writing on from what it had seen.
  const asked = (await win.evaluate((k) => (globalThis as unknown as { api: Api }).api.claudeView(k), key))?.exchanges.map((e) => e.asked);
  expect(asked).toEqual(['app', 'elsewhere', 'app', 'app']);

  // Typing in the box and pressing Enter asks too, as in Claude Desktop.
  const box = panel.getByRole('textbox', { name: 'Ask Claude' });
  await box.fill('Thanks');
  await box.press('Enter');
  await expect(panel.getByText('Noted.')).toBeVisible({ timeout: 15_000 });
  await expect(box).toHaveValue('');
  // The conversation's own model and effort show under the box, and going back shows Settings' default again.
  const model = panel.getByRole('button', { name: 'Model', exact: true });
  await win.evaluate((k) => (globalThis as unknown as { api: Api }).api.chooseClaudeModel(k, { model: 'claude-haiku-5-5', effort: 'low' }), key);
  await expect(model).toHaveText('Haiku 5.5');
  await expect(panel.getByRole('button', { name: 'Effort', exact: true })).toHaveText('Low');
  await win.evaluate((k) => (globalThis as unknown as { api: Api }).api.chooseClaudeModel(k, null), key);
  await expect(model).not.toHaveText('Haiku 5.5');
  const comments = bar.getByRole('button', { name: /^Comments/ });
  await comments.click();
  await expect(win.getByRole('region', { name: 'Comments' })).toBeVisible();
  await expect(claude).toHaveAttribute('aria-pressed', 'false');
  await expect(comments).toHaveAttribute('aria-pressed', 'true');
  // Pressing the icon that's showing hides the panel; pressing it again brings it back.
  await comments.click();
  await expect(side).toHaveCount(0);
  await expect(comments).toHaveAttribute('aria-pressed', 'false');
  await comments.click();
  await expect(win.getByRole('region', { name: 'Comments' })).toBeVisible();
});

test('Ask Claude on a review thread: the thread shows over the box, can be removed, and goes with the question', async () => {
  const key = 'github.com/acme/demo#1';
  const card = win.locator('[id="thread-T_outdated"]');
  await card.getByRole('button', { name: 'Ask Claude' }).click();
  const panel = win.getByRole('region', { name: 'Claude' });
  const box = panel.getByRole('textbox', { name: 'Ask Claude' });
  await expect(box).toBeFocused();
  await expect(panel.getByText('Can items be negative here?')).toBeVisible();
  // × asks about nothing in particular; Ask Claude brings the thread back.
  await panel.getByRole('button', { name: 'Don’t ask about this thread' }).click();
  await expect(panel.getByText('Can items be negative here?')).toHaveCount(0);
  await card.getByRole('button', { name: 'Ask Claude' }).click();
  await box.fill('Is this addressed?');
  await box.press('Enter');
  await expect(panel.getByText('Can items be negative here?')).toHaveCount(0);
  await expect
    .poll(async () => (await win.evaluate((k) => (globalThis as unknown as { api: Api }).api.claudeView(k), key))?.exchanges.at(-1), { timeout: 15_000 })
    .toMatchObject({ request: { kind: 'thread', prompt: 'Is this addressed?', thread: { id: 'T_outdated', path: 'src/calc.ts' } }, done: true });
  await expect(panel.getByRole('button', { name: /Thread on calc\.ts/ })).toBeVisible();
  await win.getByRole('navigation', { name: 'Side panels' }).getByRole('button', { name: /^Comments/ }).click();
});

test('an agent acts in the app over MCP: marks a file viewed, shows a thread and opens a search', async () => {
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: { pr: 'acme/demo#1', ...args } })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError, res.content[0]?.text).toBeFalsy();
  };

  await call('set_viewed', { paths: ['src/calc.ts'] });
  await expect(win.getByRole('checkbox', { name: 'Mark src/calc.ts as viewed' })).toBeChecked({ timeout: 20_000 });
  expect(received.find((r) => r.query.includes('markFileAsViewed('))?.vars).toMatchObject({ prId: 'PR_1', path: 'src/calc.ts' });

  await win.getByRole('button', { name: /^Overview/ }).click();
  await call('show_in_app', { thread_id: 'T_outdated' });
  await expect(win.locator('[id="thread-T_outdated"]')).toBeInViewport({ timeout: 20_000 });

  await call('search_code', { query: 'loyalty', show: true });
  await expect(win.getByRole('textbox', { name: 'Search', exact: true })).toHaveValue('loyalty');
  await client.close();
});

test('the Claude box asks about what you have selected or open in the diff', async () => {
  const key = 'github.com/acme/demo#1';
  const claudeIcon = win.getByRole('navigation', { name: 'Side panels' }).getByRole('button', { name: 'Claude', exact: true });
  if ((await claudeIcon.getAttribute('aria-pressed')) !== 'true') await claudeIcon.click();
  const panel = win.getByRole('region', { name: 'Claude' });
  const box = panel.getByRole('textbox', { name: 'Ask Claude' });

  // The box fits its text at the width it has: measured while squeezed narrow (as when the panel opens), it grows tall,
  // and once it has its width back it shrinks again by itself.
  type Styled = { parentElement: { style: { width: string } } | null };
  await box.evaluate((el: Styled) => void (el.parentElement!.style.width = '80px'));
  await box.fill('x');
  await box.fill('');
  expect((await box.boundingBox())!.height).toBeGreaterThan(80);
  await box.evaluate((el: Styled) => void (el.parentElement!.style.width = ''));
  await expect.poll(async () => (await box.boundingBox())!.height).toBeLessThan(80);

  // Selecting lines 3–5 (dragging down the line numbers) puts them over the box, and the question goes with them.
  const file = win.locator('section[aria-label="src/calc.ts"]');
  await file.locator('[data-additions] [data-column-number="3"]').first().scrollIntoViewIfNeeded();
  const from = await file.locator('[data-additions] [data-column-number="3"]').first().boundingBox();
  const to = await file.locator('[data-additions] [data-column-number="5"]').first().boundingBox();
  await win.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await win.mouse.down();
  await win.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 6 });
  await win.mouse.up();
  // Under the box: what the question is about, with × to drop it. (The question's own label in the conversation, once
  // sent, also reads calc.ts:3–5, so the chip is found by its title.)
  const lines = panel.locator('[title^="Your next question is about line"]');
  await expect(lines).toBeVisible();
  await expect(lines).toContainText('calc.ts:3–5');
  await expect(lines.getByRole('button', { name: 'Don’t ask about these lines' })).toBeVisible();
  await expect(box).toHaveAttribute('placeholder', 'Ask Claude about these lines…');
  await box.fill('Why a loop here?');
  await box.press('Enter');
  const lastRequest = () => win.evaluate((k) => (globalThis as unknown as { api: Api }).api.claudeView(k), key).then((v) => v?.exchanges.at(-1)?.request);
  await expect.poll(lastRequest, { timeout: 15_000 }).toMatchObject({ kind: 'lines', prompt: 'Why a loop here?', target: { path: 'src/calc.ts', side: 'RIGHT', startLine: 3, endLine: 5 } });
  // Sent: the box is about the pull request again.
  await expect(lines).toHaveCount(0);
  await expect(panel.getByText('About the whole pull request')).toBeVisible();

  // An ordinary text selection in the code counts too; going to the box to ask keeps it, clicking in the code drops it.
  // A line's text (its first token), not its box, which starts in the line-number gutter; scrolled into the window first.
  const code = async (n: number) => {
    const token = file.locator(`[data-additions] [data-line="${n}"] span`).first();
    await token.scrollIntoViewIfNeeded();
    return (await token.boundingBox())!;
  };
  const dragOverCode = async (a: number, b: number) => {
    // An earlier search scrolled the code sideways: back to the lines' start, so their text is where its boxes say.
    await file.evaluate((s) => s.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-code]').forEach((c: { scrollLeft: number }) => (c.scrollLeft = 0)));
    const [x, y] = [await code(a), await code(b)];
    await win.mouse.move(x.x + 2, x.y + x.height / 2);
    await win.mouse.down();
    await win.mouse.move(y.x + y.width - 2, y.y + y.height / 2, { steps: 6 });
    await win.mouse.up();
  };
  await dragOverCode(3, 5);
  await expect(lines).toBeVisible();
  await box.click();
  await expect(lines).toBeVisible();
  await box.fill('And this?');
  await box.press('Enter');
  await expect.poll(lastRequest, { timeout: 15_000 }).toMatchObject({ kind: 'lines', prompt: 'And this?', target: { path: 'src/calc.ts', side: 'RIGHT', startLine: 3, endLine: 5 } });
  // Clicking a blank margin (right of the file, on no text) drops it, as clicking other code does.
  await dragOverCode(3, 5);
  await expect(lines).toBeVisible();
  const section = (await file.boundingBox())!;
  const five = await code(5);
  await win.mouse.click(section.x + section.width + 6, five.y + five.height / 2);
  await expect(lines).toHaveCount(0);
  await dragOverCode(3, 5);
  await expect(lines).toBeVisible();
  const seven = await code(7);
  await win.mouse.click(seven.x + 30, seven.y + seven.height / 2);
  await expect(lines).toHaveCount(0);

  // Part of one line (a word) goes along as what was selected, under the box and in the question.
  await file.evaluate((s) => s.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-code]').forEach((c: { scrollLeft: number }) => (c.scrollLeft = 0)));
  // A double-click picks the word, as anywhere else (mid-line, away from the line numbers, which pick whole lines).
  await file.locator('[data-additions] [data-line="3"]').getByText('total', { exact: true }).dblclick();
  const wordChip = panel.locator('[title^="Your next question is about “"]');
  await expect(wordChip).toContainText('calc.ts:3:17–21');
  const picked = (await wordChip.locator('code').innerText()).trim();
  expect(picked).toBe('total');
  await expect(box).toHaveAttribute('placeholder', 'Ask Claude about the selection…');
  await box.fill('What is this?');
  await box.press('Enter');
  // Where it is too: "total" is columns 17–21 of `export function total(…`, in the question and its label.
  await expect.poll(lastRequest, { timeout: 15_000 }).toMatchObject({ kind: 'lines', prompt: 'What is this?', target: { startLine: 3, endLine: 3 }, selection: { text: 'total', from: 17, to: 21 } });
  await expect(panel.getByRole('button', { name: 'calc.ts:3:17–21 · total' })).toBeVisible();

  // Clicking into a review thread selects it: highlighted, and the one the box asks about. Clicking elsewhere in the code
  // deselects it; × asks about nothing.
  const thread = win.locator('[id="thread-T_outdated"]');
  await thread.getByText('Can items be negative here?').click();
  await expect(box).toHaveAttribute('placeholder', 'Ask Claude about this conversation…');
  await expect(thread).toHaveClass(/border-accent/);
  await win.mouse.click(section.x + section.width + 6, seven.y + seven.height / 2);
  await expect(box).toHaveAttribute('placeholder', 'Ask Claude about this pull request…');
  await expect(thread).not.toHaveClass(/border-accent/);
  await thread.getByText('Can items be negative here?').click();
  await panel.getByRole('button', { name: 'Don’t ask about this thread' }).click();
  await expect(box).toHaveAttribute('placeholder', 'Ask Claude about this pull request…');
  await expect(thread).not.toHaveClass(/border-accent/);
});

test('with a file open in its own tab, the Claude box asks about that file', async () => {
  const key = 'github.com/acme/demo#1';
  const panel = win.getByRole('region', { name: 'Claude' });
  const box = panel.getByRole('textbox', { name: 'Ask Claude' });
  const fileChip = panel.locator('[title^="Your next question is about src/calc.ts"]');
  const lastRequest = () => win.evaluate((k) => (globalThis as unknown as { api: Api }).api.claudeView(k), key).then((v) => v?.exchanges.at(-1)?.request);

  // ⌘-click in the file tree opens the file in its own tab.
  const filesIcon = win.getByRole('navigation', { name: 'Overview, files and commits' }).getByRole('button', { name: 'Files' });
  if ((await filesIcon.getAttribute('aria-pressed')) !== 'true') await filesIcon.click();
  await win.locator('[data-sidebar]').getByText('calc.ts', { exact: true }).first().click({ modifiers: ['Meta'] });
  const fileTab = win.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { name: /calc\.ts/ });
  await expect(fileTab).toHaveAttribute('aria-selected', 'true');
  await expect(fileChip).toBeVisible();
  await expect(box).toHaveAttribute('placeholder', 'Ask Claude about this file…');
  await box.fill('What does this do?');
  await box.press('Enter');
  await expect.poll(lastRequest, { timeout: 15_000 }).toMatchObject({ kind: 'file', prompt: 'What does this do?', file: { path: 'src/calc.ts' } });
  // Still the file you're looking at, so it stays for the next question.
  await expect(fileChip).toBeVisible();

  // × asks about the pull request until you go to another tab and back.
  await fileChip.getByRole('button', { name: 'Don’t ask about this file' }).click();
  await expect(box).toHaveAttribute('placeholder', 'Ask Claude about this pull request…');
  await win.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { name: /All changes/ }).click();
  await expect(fileChip).toHaveCount(0);
  await fileTab.click();
  await expect(fileChip).toBeVisible();
  await win.getByRole('button', { name: 'Close src/calc.ts' }).click();
  await expect(fileChip).toHaveCount(0);
});

test('Settings › General lists the repositories found, each with its clone', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('menu', 'settings'));
  const found = win.getByRole('region', { name: 'Repositories found' });
  await expect(found).toContainText('Found 1 repository', { timeout: 10_000 });
  await expect(found).toContainText('acme/demo');
  await expect(found).toContainText(join(fx.root, 'source', 'demo'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('menu', 'close-tab'));
  await expect(found).toHaveCount(0);
});

test('the commits take the place of the files, from their icon on the left', async () => {
  const key = 'github.com/acme/demo#1';
  const strip = win.getByRole('navigation', { name: 'Overview, files and commits' });
  const commits = strip.getByRole('button', { name: 'Commits' });
  const tree = win.locator('[data-sidebar]');
  const changesAfter = win.getByRole('button', { name: 'Changes after this' });

  // The views are chosen in the strip on the left: the header has no switch.
  await expect(win.getByRole('group', { name: 'PR views' })).toHaveCount(0);
  // No count on its icon, for now.
  await expect(commits).toHaveAccessibleName('Commits');
  await expect(commits).toHaveText('');
  await commits.click();
  await expect(commits).toHaveAttribute('aria-pressed', 'true');
  await expect(changesAfter.first()).toBeVisible();
  await expect(tree).toHaveCount(0);
  // Nothing beside the commits: no comments, no Claude, no details.
  await expect(win.getByRole('navigation', { name: 'Side panels' })).toHaveCount(0);
  await expect(win.getByRole('complementary', { name: 'Side panel' })).toHaveCount(0);
  // Pressed again, back to the files.
  await commits.click();
  await expect(tree).toBeVisible();
  await expect(changesAfter).toHaveCount(0);

  // "Changes after this" shows the files again, compared from that commit.
  await commits.click();
  await changesAfter.first().click();
  await expect(commits).toHaveAttribute('aria-pressed', 'false');
  await expect(tree).toBeVisible();
  await expect(win.getByRole('button', { name: /Changes\s*Since [0-9a-f]{7}/ })).toBeVisible({ timeout: 20_000 });
  await win.evaluate((k) => (globalThis as unknown as { api: Api }).api.setCompare(k, null, 'All changes'), key);
  await expect(win.getByRole('button', { name: /Changes\s*All changes/ })).toBeVisible({ timeout: 20_000 });
});

test('the Overview has its details beside it, the files their comments and Claude; Settings at the bottom left', async () => {
  const left = win.getByRole('navigation', { name: 'Overview, files and commits' });
  const right = win.getByRole('navigation', { name: 'Side panels' });
  const tree = win.locator('[data-sidebar]');
  const details = win.getByRole('region', { name: 'Details' });
  const comments = win.getByRole('region', { name: 'Comments' });

  // The Overview takes the place of the files, with its buttons in the header and the details beside it.
  const overview = left.getByRole('button', { name: 'Overview' });
  if ((await overview.getAttribute('aria-pressed')) !== 'true') await overview.click();
  await expect(overview).toHaveAttribute('aria-pressed', 'true');
  await expect(win.getByRole('region', { name: 'Review threads' })).toBeVisible();
  await expect(tree).toHaveCount(0);
  await expect(win.getByRole('button', { name: 'Actions', exact: true })).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Reviewers' })).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Checks' })).toBeVisible();
  // Only the details' icon on the right; it hides and shows them.
  await expect(right.getByRole('button')).toHaveCount(1);
  const info = right.getByRole('button', { name: /^Details/ });
  await info.click();
  await expect(details).toHaveCount(0);
  await info.click();
  await expect(details).toBeVisible();

  // Pressed again, the Overview goes back to the files: the comments and Claude beside them, not the details.
  await overview.click();
  await expect(tree).toBeVisible();
  await expect(details).toHaveCount(0);
  await expect(right.getByRole('button', { name: /^Details/ })).toHaveCount(0);
  await expect(right.getByRole('button', { name: /^Comments/ })).toBeVisible();
  await expect(win.getByRole('button', { name: 'Actions', exact: true })).toHaveCount(0);

  // Settings at the foot of the left strip, no longer in the tab bar.
  await expect(left.getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(win.locator('div.drag').getByRole('button', { name: 'Settings' })).toHaveCount(0);
});

test('a window reopened from the Dock shows the pull request that was open', async () => {
  // macOS keeps the app (and the pull request's session) running when the last window closes; elsewhere it quits.
  test.skip(process.platform !== 'darwin', 'Closing the last window quits the app outside macOS.');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.windows().length).toBe(0);
  const reopened = app.waitForEvent('window');
  await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'));
  win = await reopened;
  // The restored tab opens a session that already exists, so no new snapshot event comes: the page has to ask for it.
  await expect(win.getByRole('heading', { name: 'Apply loyalty discount' })).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText('Opening pull request…')).toBeHidden();
});
