// Hands GitHub pull requests to the PR Review app through its prreview:// link. Chrome asks "Open PR Review?" the
// first time; with "Always allow" ticked it goes straight through.
//
// The pull request page always loads in the browser too, so cancelling Chrome's prompt simply leaves you on it:
// Chrome doesn't tell a page whether the app opened, so the page itself is the fallback.

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;

/**
 * `auto`: open pull requests in the app, the default for every repository; `repos`: per-repository choices
 * ("owner/repo" → on or off); `button`: show the "Open in PR Review" button on pull request pages.
 */
const DEFAULTS = { auto: true, repos: {}, button: true };

/**
 * False once the extension has been reloaded or updated. Chrome keeps this copy of the script running in pages that
 * were already open, but its chrome.* calls then throw "Extension context invalidated", so it stops doing anything
 * (the page gets the new copy when it next loads).
 */
function alive() {
  try {
    return chrome.runtime?.id !== undefined;
  } catch {
    return false;
  }
}
const BUTTON_ID = 'pr-review-open-button';
let prefs = { ...DEFAULTS };
const settingsLoaded = chrome.storage.sync.get(DEFAULTS).then((stored) => {
  prefs = stored;
  ensureButton();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.auto) prefs.auto = changes.auto.newValue;
  if (changes.repos) prefs.repos = changes.repos.newValue ?? {};
  if (changes.button) {
    prefs.button = changes.button.newValue ?? true;
    ensureButton();
  }
});

/** "owner/repo#n" for a github.com pull request URL, else null. */
function prKey(url) {
  if (url.origin !== 'https://github.com') return null;
  const m = PR_PATH.exec(url.pathname);
  return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : null;
}

const repoOf = (pr) => pr.split('#')[0];

/** Whether this pull request's repository opens in the app: its own choice, else the default. */
const wanted = (pr) => prefs.repos[repoOf(pr)] ?? prefs.auto;

/** PR Review marks the links it opens in the browser itself ("View on GitHub"): those stay on GitHub. */
const stays = (url) => url.searchParams.get('pr_review') === 'stay';

function handOff(url) {
  location.href = `prreview://open?pr=${encodeURIComponent(url.href)}`;
}

// A pull request page loaded: from a link in Slack or Mail, a new tab, the address bar. Not on reload or
// back/forward, which is coming back to GitHub on purpose.
(async () => {
  const here = new URL(location.href);
  const pr = prKey(here);
  const nav = performance.getEntriesByType('navigation')[0];
  if (!pr || stays(here) || (nav && nav.type !== 'navigate')) return;
  await settingsLoaded;
  if (!wanted(pr)) return;
  // Only once the page is there: navigating anywhere (even to the app's link) while it loads cuts the loading off,
  // and then there would be no page left to fall back to when the prompt is cancelled.
  await whenSettled();
  if (prKey(new URL(location.href)) !== pr) return;
  handOff(here);
  showNotice(repoOf(pr), history.length <= 1 ? 'close' : 'back');
})();

// A pull request reached by clicking around github.com: GitHub switches pages without loading them, so follow its
// in-page navigations. Only new ones ("push"), not back/forward or reloads, and not moving within the same pull
// request (its tabs, files, comments).
/**
 * Resolves shortly after the page has loaded: once it has drawn for a moment without changes, or 0.6s after `load`
 * regardless. GitHub keeps drawing the pull request with scripts right after `load`, but a signed-in page never goes
 * fully quiet (live updates, polling), so the wait is short and capped. Network activity doesn't count, for that reason.
 */
function whenSettled({ quiet = 150, max = 600 } = {}) {
  return new Promise((resolve) => {
    const begin = () => {
      const start = performance.now();
      let last = start;
      const dom = new MutationObserver(() => (last = performance.now()));
      dom.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      const check = () => {
        const now = performance.now();
        if (now - last >= quiet || now - start >= max) {
          dom.disconnect();
          resolve();
        } else setTimeout(check, 50);
      };
      setTimeout(check, 50);
    };
    if (document.readyState === 'complete') begin();
    else addEventListener('load', begin, { once: true });
  });
}

// GitHub changes the URL first and draws the pull request after: hand off once its header is there.
let pendingPr = null;

self.navigation?.addEventListener('currententrychange', (e) => {
  if (e.navigationType !== 'push' || !alive()) return;
  const here = new URL(location.href);
  const pr = prKey(here);
  const before = e.from?.url ? prKey(new URL(e.from.url)) : null;
  if (!pr || pr === before || stays(here) || !wanted(pr)) return;
  pendingPr = { pr, since: Date.now() };
  handOffWhenShown();
});

/**
 * The visible title of pull request `number` (with its "#number"), if drawn. Visible only: GitHub keeps a hidden copy
 * of the header that sticks to the top once you scroll, and the previous page's title can linger for a moment.
 */
function visibleTitle(number) {
  return [...document.querySelectorAll('[data-component="PH_Title"], .gh-header-title, h1')].find(
    (h) => h.offsetParent !== null && (h.textContent ?? '').includes(`#${number}`),
  );
}

/**
 * Hands the pending pull request off as soon as its header is drawn (GitHub draws that first; the page has long
 * loaded, so this is nearly instant), or after 1.5s regardless, if it's still the page shown.
 */
function handOffWhenShown() {
  if (!pendingPr) return;
  if (prKey(new URL(location.href)) !== pendingPr.pr) {
    pendingPr = null;
    return;
  }
  if (!visibleTitle(pendingPr.pr.split('#')[1]) && Date.now() - pendingPr.since < 1500) {
    setTimeout(handOffWhenShown, 50);
    return;
  }
  const { pr } = pendingPr;
  pendingPr = null;
  handOff(new URL(location.href));
  showNotice(repoOf(pr), 'back');
}

// An "Open in PR Review" button in the pull request's header, next to GitHub's own buttons (it works whether automatic
// opening is on or not; the toolbar popup can turn it off). GitHub re-renders the header as you move around, so it is
// put back whenever it goes missing.

function ensureButton() {
  if (!alive()) return;
  const pr = prKey(new URL(location.href));
  const existing = document.getElementById(BUTTON_ID);
  const visible = (el) => !!el && el.offsetParent !== null;
  if (existing && prefs.button && existing.dataset.pr === pr && visible(existing)) return;
  existing?.remove();
  if (!pr || !prefs.button) return;
  // Among the header's buttons (the action area is only shown when signed in), or else next to the title. Only
  // visible ones: GitHub keeps a hidden copy of the header that sticks to the top once you scroll.
  const actions = [...document.querySelectorAll('[data-component="PH_Actions"], .gh-header-actions')].find(visible);
  const title = visibleTitle(pr.split('#')[1]);
  if (!actions && !title) return;
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.dataset.pr = pr;
  button.title = 'Open this pull request in the PR Review app';
  button.style.cssText =
    'display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:6px;cursor:pointer;white-space:nowrap;flex:none;' +
    'font:500 14px/1 var(--fontStack-sansSerif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);' +
    'color:var(--button-default-fgColor-rest,#25292e);background:var(--button-default-bgColor-rest,#f6f8fa);' +
    'border:1px solid var(--button-default-borderColor-rest,#d1d9e0);box-shadow:var(--shadow-resting-small,none)';
  button.onmouseenter = () => (button.style.background = 'var(--button-default-bgColor-hover,#eff2f5)');
  button.onmouseleave = () => (button.style.background = 'var(--button-default-bgColor-rest,#f6f8fa)');
  const icon = document.createElement('img');
  icon.src = chrome.runtime.getURL('icon32.png');
  icon.alt = '';
  icon.width = icon.height = 16;
  icon.style.cssText = 'border-radius:4px';
  button.append(icon, 'Open in PR Review');
  button.onclick = () => handOff(new URL(location.href));
  if (actions) actions.prepend(button);
  else {
    button.style.marginLeft = '12px';
    button.style.alignSelf = 'center';
    title.parentElement.append(button);
  }
}

let buttonQueued = false;
const headerWatch = new MutationObserver(() => {
  if (!alive()) {
    headerWatch.disconnect();
    return;
  }
  if (buttonQueued) return;
  buttonQueued = true;
  requestAnimationFrame(() => {
    buttonQueued = false;
    ensureButton();
  });
});
headerWatch.observe(document.documentElement, { childList: true, subtree: true });

// The toolbar button's "Open this pull request in PR Review", for when automatic opening is off or was skipped.
chrome.runtime.onMessage.addListener((message) => {
  if (message === 'open' && prKey(new URL(location.href))) handOff(new URL(location.href));
});

/**
 * A small note on the pull request page: go back (or close a tab opened just for this link), or stop opening this
 * repository in the app. It can't know whether the app opened, so it says the PR was sent there.
 */
function showNotice(repo, leave) {
  const show = () => {
    document.getElementById('pr-review-notice')?.remove();
    const box = document.createElement('div');
    box.id = 'pr-review-notice';
    box.setAttribute('role', 'status');
    box.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;' +
      'background:#151b23;color:#f0f6fc;border:1px solid #3d444d;box-shadow:0 8px 24px rgba(0,0,0,.4);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    const button = (label, title, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (title) b.title = title;
      b.style.cssText = 'padding:4px 10px;border-radius:6px;border:1px solid #3d444d;background:#212830;color:#f0f6fc;font:inherit;cursor:pointer';
      b.onclick = onClick;
      return b;
    };
    const text = document.createElement('span');
    text.textContent = 'Sent to PR Review';
    const away =
      leave === 'close'
        ? button('Close tab', 'This tab was opened just for the link', () => chrome.runtime.sendMessage('close-tab'))
        : button('Back', 'Back to the page you came from', () => history.back());
    const notHere = button('Not for this repo', `Keep ${repo} pull requests on GitHub (change it with the extension's toolbar button)`, async () => {
      const { repos } = await chrome.storage.sync.get({ repos: {} });
      await chrome.storage.sync.set({ repos: { ...repos, [repo]: false } });
      text.textContent = `${repo} stays on GitHub from now on`;
      notHere.remove();
    });
    const dismiss = document.createElement('button');
    dismiss.textContent = '×';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.style.cssText = 'border:0;background:none;color:#9198a1;font:18px/1 inherit;cursor:pointer';
    dismiss.onclick = () => box.remove();
    box.append(text, away, notHere, dismiss);
    document.body.append(box);
    setTimeout(() => box.remove(), 10000);
  };
  if (document.body) show();
  else addEventListener('DOMContentLoaded', show, { once: true });
}
