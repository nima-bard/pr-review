// The default for all repositories, and on a repository page that repository's own choice (stored once changed).
const auto = document.getElementById('auto');
const repoBox = document.getElementById('repo');
const open = document.getElementById('open');
const button = document.getElementById('button');

Promise.all([chrome.storage.sync.get({ auto: true, repos: {}, button: true }), chrome.tabs.query({ active: true, currentWindow: true })]).then(([prefs, [tab]]) => {
  auto.checked = prefs.auto;
  auto.addEventListener('change', () => chrome.storage.sync.set({ auto: auto.checked }));
  button.checked = prefs.button;
  button.addEventListener('change', () => chrome.storage.sync.set({ button: button.checked }));

  const m = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/.exec(tab?.url ?? '');
  if (m) {
    const repo = `${m[1]}/${m[2]}`.toLowerCase();
    document.getElementById('repo-row').hidden = false;
    document.getElementById('repo-name').textContent = repo;
    document.getElementById('auto-label').textContent = 'Other repositories';
    repoBox.checked = prefs.repos[repo] ?? prefs.auto;
    repoBox.addEventListener('change', async () => {
      const { repos } = await chrome.storage.sync.get({ repos: {} });
      await chrome.storage.sync.set({ repos: { ...repos, [repo]: repoBox.checked } });
    });
  }

  if (tab?.id !== undefined && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(tab.url ?? '')) {
    open.disabled = false;
    open.addEventListener('click', () => {
      chrome.tabs.sendMessage(tab.id, 'open').catch(() => {});
      window.close();
    });
  }
});
