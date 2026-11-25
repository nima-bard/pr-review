import { describe, expect, it } from 'vitest';
import { parsePrInput } from '../../src/shared/prInput';
import { triage } from '../../src/shared/triage';
import { parseRemote, parseRemoteConfig, parseRemotes } from '../../src/core/repos/remote';
import { appendVersion, mergeVersions, sampleSteps } from '../../src/core/git/versions';
import { mergeMappings } from '../../src/core/repos/registry';

describe('parsePrInput', () => {
  it('parses URLs (with suffixes), owner/repo#N and GHES hosts', () => {
    expect(parsePrInput('https://github.com/octo-org/octo-repo/pull/2712/files')).toEqual({ host: 'github.com', owner: 'octo-org', repo: 'octo-repo', number: 2712 });
    expect(parsePrInput(' acme/storefront#482 ')).toEqual({ host: 'github.com', owner: 'acme', repo: 'storefront', number: 482 });
    expect(parsePrInput('ghe.corp.example/team/app#3')).toEqual({ host: 'ghe.corp.example', owner: 'team', repo: 'app', number: 3 });
    expect(parsePrInput('not a pr')).toBeNull();
  });
});

describe('triage', () => {
  const c = (createdAt: string, viewerDidAuthor: boolean, body = 'x') => ({ createdAt, viewerDidAuthor, body });
  const claude = 'Two fromDb modules have no caller left.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';
  it('buckets threads', () => {
    expect(triage({ isResolved: true, comments: [c('2026-01-01', false)], anchor: {}, viewerIsAuthor: true })).toBe('resolved');
    expect(triage({ isResolved: false, comments: [c('2026-01-01', false)], anchor: {}, viewerIsAuthor: true })).toBe('needs-reply');
    expect(triage({ isResolved: false, comments: [c('2026-01-01', false), c('2026-01-02', true)], anchor: {}, viewerIsAuthor: true })).toBe('waiting');
    expect(triage({ isResolved: false, comments: [c('2026-01-01', false)], anchor: { changedAt: 'x', changedAtTime: '2026-01-03' }, viewerIsAuthor: true })).toBe('likely-addressed');
    expect(triage({ isResolved: false, comments: [c('2026-01-05', false)], anchor: { changedAt: 'x', changedAtTime: '2026-01-03' }, viewerIsAuthor: true })).toBe('needs-reply');
    expect(triage({ isResolved: false, comments: [c('2026-01-01', false)], anchor: { locallyModified: true }, viewerIsAuthor: true })).toBe('likely-addressed');
  });

  it('treats Claude-generated comments from the PR author\'s own account as feedback for them', () => {
    expect(triage({ isResolved: false, comments: [c('2026-01-01', true, claude)], anchor: {}, viewerIsAuthor: true })).toBe('needs-reply');
    expect(triage({ isResolved: false, comments: [c('2026-01-01', true, claude), c('2026-01-02', true, 'Fixed in abc123')], anchor: {}, viewerIsAuthor: true })).toBe('waiting');
    // As a reviewer, a Claude-generated comment you posted is still your side of the thread.
    expect(triage({ isResolved: false, comments: [c('2026-01-01', true, claude)], anchor: {}, viewerIsAuthor: false })).toBe('waiting');
  });
});

describe('remotes', () => {
  it('parses ssh, scp, https (with credentials) and GHES remotes', () => {
    expect(parseRemote('git@github.com:octo-org/octo-repo.git')).toEqual({ host: 'github.com', owner: 'octo-org', repo: 'octo-repo' });
    expect(parseRemote('https://github.com/octo-org/octo-repo.git')).toEqual({ host: 'github.com', owner: 'octo-org', repo: 'octo-repo' });
    expect(parseRemote('https://user@ghe.corp/x/y')).toEqual({ host: 'ghe.corp', owner: 'x', repo: 'y' });
    expect(parseRemote('ssh://git@github.com:22/a/b.git')).toEqual({ host: 'github.com', owner: 'a', repo: 'b' });
    expect(parseRemote('/local/path')).toBeUndefined();
  });

  it('parses `git remote -v` once per remote', () => {
    const out = 'origin\thttps://github.com/a/b.git (fetch)\norigin\thttps://github.com/a/b.git (push)\nupstream\tgit@github.com:c/b.git (fetch)\n';
    expect(parseRemotes(out).map((r) => r.name)).toEqual(['origin', 'upstream']);
  });

  it('parses configured remote URLs (before insteadOf rewriting)', () => {
    const out = 'remote.origin.url https://github.com/a/b.git\nremote.my.fork.url git@github.com:me/b.git\n';
    expect(parseRemoteConfig(out)).toEqual([
      { name: 'origin', info: { host: 'github.com', owner: 'a', repo: 'b' } },
      { name: 'my.fork', info: { host: 'github.com', owner: 'me', repo: 'b' } },
    ]);
  });

  it('manual mappings win over scanned ones', () => {
    const merged = mergeMappings([{ slug: 'a/b', path: '/manual', source: 'manual' }], [{ slug: 'a/b', path: '/scan', source: 'scan' }, { slug: 'c/d', path: '/cd', source: 'scan' }]);
    expect(merged).toEqual([
      { slug: 'a/b', path: '/manual', source: 'manual' },
      { slug: 'c/d', path: '/cd', source: 'scan' },
    ]);
  });
});

describe('versions', () => {
  it('appends new heads once and merges timeline heads chronologically', () => {
    const v = appendVersion(appendVersion([], 'a', 'app', false, '2026-01-02'), 'a', 'app', false);
    expect(v).toHaveLength(1);
    const merged = mergeVersions(v, [{ sha: 'z', at: '2026-01-01', forcePush: true }]);
    expect(merged.map((x) => [x.n, x.sha])).toEqual([
      [1, 'z'],
      [2, 'a'],
    ]);
  });

  it('samples long chains but always ends at head', () => {
    const revs = Array.from({ length: 200 }, (_, i) => `c${i}`);
    const s = sampleSteps(revs, 60);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.at(-1)).toBe('c199');
  });
});
