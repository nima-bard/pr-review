import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api } from '../src/shared/ipc';

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
  writeFileSync(
    join(userData, 'pr-review', 'state.json'),
    JSON.stringify({ settings: { scanRoots: [join(fx.root, 'source')], worktreeRoot: null, editorCommand: 'true', placeThreshold: 0.7, guessThreshold: 0.5, aiEnabled: false, aiModel: 'haiku' }, repos: [], openTabs: [], ownedWorktrees: [] }),
  );
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, PR_REVIEW_USER_DATA: userData, PR_REVIEW_API: `http://127.0.0.1:${port}`, PR_REVIEW_TOKEN: 'test-token' },
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
  await win.getByRole('button', { name: /^Files/ }).click();

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
