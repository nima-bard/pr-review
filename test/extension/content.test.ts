import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const code = readFileSync(join(import.meta.dirname, '../../browser-extension/content.js'), 'utf8');

/** Runs the content script on a page at `href`, with Chrome's APIs stubbed; returns the prreview:// links it opened. */
async function load(href: string, { navType = 'navigate', auto = true, repos = {} as Record<string, boolean>, historyLength = 1, invalidated = false } = {}) {
  const handedOff: string[] = [];
  const navListeners: ((e: unknown) => void)[] = [];
  let current = href;
  let clock = 0;
  const context: Record<string, unknown> = {
    URL,
    encodeURIComponent,
    // Timers run at once; the stand-in page has its pull request header drawn (the hand-off waits for it).
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    location: {
      get href() {
        return current;
      },
      set href(value: string) {
        if (value.startsWith('prreview:')) handedOff.push(value);
        else current = value;
      },
    },
    history: { length: historyLength, back() {} },
    // A clock that moves on with every reading, so waiting for the page to go quiet ends at once.
    performance: { getEntriesByType: () => [{ type: navType }], now: () => (clock += 100) },
    PerformanceObserver: class {
      observe() {}
      disconnect() {}
    },
    // The page shows the title of the pull request it's on (the hand-off after a navigation waits for it).
    document: {
      readyState: 'complete',
      body: null,
      documentElement: {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (selector: string) => (selector.includes('h1') ? [{ offsetParent: {}, textContent: `A title #${/\/pull\/(\d+)/.exec(current)?.[1] ?? ''}` }] : []),
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 0,
    addEventListener() {},
    navigation: { addEventListener: (_type: string, fn: (e: unknown) => void) => navListeners.push(fn) },
    chrome: {
      storage: { sync: { get: async (defaults: object) => ({ ...defaults, auto, repos, button: false }) }, onChanged: { addListener() {} } },
      // After a reload, Chrome drops the old copy's extension id (and its chrome.* calls throw).
      runtime: { id: invalidated ? undefined : 'test', onMessage: { addListener() {} }, sendMessage() {} },
    },
  };
  context.self = context;
  vm.runInNewContext(code, context);
  await new Promise((resolve) => setImmediate(resolve));
  /** GitHub moving to another page without loading it (a clicked link: "push"; back/forward: "traverse"). */
  const navigate = async (to: string, navigationType = 'push') => {
    const from = current;
    current = to;
    for (const fn of navListeners) fn({ navigationType, from: { url: from } });
    // The hand-off waits for the page to settle, which resolves on a later tick.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { handedOff, navigate };
}

const PR = 'https://github.com/o/r/pull/12';

describe('browser extension: pages opened directly', () => {
  it('hands a pull request page to the app', async () => {
    expect((await load(`${PR}/files`)).handedOff).toEqual([`prreview://open?pr=${encodeURIComponent(`${PR}/files`)}`]);
  });

  it('leaves pages alone on reload or back/forward, when turned off, when the app sent them, and when not a pull request', async () => {
    expect((await load(PR, { navType: 'reload' })).handedOff).toEqual([]);
    expect((await load(PR, { navType: 'back_forward' })).handedOff).toEqual([]);
    expect((await load(PR, { auto: false })).handedOff).toEqual([]);
    expect((await load(`${PR}?pr_review=stay`)).handedOff).toEqual([]);
    expect((await load('https://github.com/o/r/issues/3')).handedOff).toEqual([]);
    expect((await load('https://github.com/o/r/pulls')).handedOff).toEqual([]);
  });
});

describe('browser extension: per-repository choices', () => {
  it("follows a repository's own choice over the default", async () => {
    expect((await load(PR, { repos: { 'o/r': false } })).handedOff).toEqual([]);
    expect((await load(PR, { auto: false, repos: { 'o/r': true } })).handedOff).toHaveLength(1);
    expect((await load('https://github.com/other/repo/pull/1', { repos: { 'o/r': false } })).handedOff).toHaveLength(1);
  });

  it('applies to pages reached by clicking around too', async () => {
    const page = await load('https://github.com/o/r/pulls', { repos: { 'x/y': false } });
    await page.navigate('https://github.com/x/y/pull/7');
    await page.navigate('https://github.com/O/R/pull/7');
    expect(page.handedOff).toEqual([`prreview://open?pr=${encodeURIComponent('https://github.com/O/R/pull/7')}`]);
  });
});

describe('browser extension: after the extension is reloaded', () => {
  it('the old copy of the script still running in an open page stops instead of throwing', async () => {
    const page = await load('https://github.com/o/r/pulls', { invalidated: true });
    await page.navigate('https://github.com/o/r/pull/7');
    expect(page.handedOff).toEqual([]);
  });
});

describe('browser extension: pages reached by clicking around github.com', () => {
  it('sends a newly opened pull request to the app; the page itself stays, as the fallback', async () => {
    const page = await load('https://github.com/o/r/pulls');
    await page.navigate('https://github.com/o/r/pull/7');
    expect(page.handedOff).toEqual([`prreview://open?pr=${encodeURIComponent('https://github.com/o/r/pull/7')}`]);
  });

  it('stays on GitHub within the same pull request, on back/forward and reloads, and for links the app sent', async () => {
    const page = await load(`${PR}?pr_review=stay`);
    await page.navigate(`${PR}/files`);
    await page.navigate('https://github.com/o/r/pull/7', 'traverse');
    await page.navigate('https://github.com/o/r/pull/8', 'replace');
    await page.navigate('https://github.com/o/r/pull/9?pr_review=stay');
    await page.navigate('https://github.com/o/r/issues/3');
    expect(page.handedOff).toEqual([]);
  });
});
