import { useEffect } from 'react';
import { api } from './api';
import { TabBar } from './components/TabBar';
import { refreshInbox } from './state/inbox';
import { checkSoon, startSessionEvents } from './state/sessions';
import { loadAppSettings } from './state/settings';
import { activateIndex, closeTab, newTab, openPr, openPrLink, openSettings, popOutKey, restoreTabs, useTabs } from './state/tabs';
import { getPrUi, setPrefs, showSearch, updateUi, usePrefs } from './state/ui';
import { NewTab } from './views/newtab/NewTab';
import { SettingsView } from './views/newtab/SettingsView';
import { PrView } from './views/pr/PrView';
import { showSetup, useSetup } from './state/setup';
import { SetupWizard } from './views/setup/SetupWizard';

/** Code selected in the page or in a code view (Pierre draws code in a shadow DOM), if it's one short line: ⌘⇧F searches for it. */
function selectedCode(): string | undefined {
  const roots: (Document | ShadowRoot | null)[] = [document, ...[...document.querySelectorAll('diffs-container')].map((el) => el.shadowRoot)];
  for (const root of roots) {
    const text = (root as { getSelection?: () => Selection | null } | null)?.getSelection?.()?.toString().trim();
    if (text && !text.includes('\n') && text.length <= 200) return text;
  }
  return undefined;
}

export function App() {
  const setup = useSetup((s) => s.show);
  useEffect(() => {
    if (popOutKey) showSetup(false);
    else void api.getSettings().then((s) => showSetup(!s.setupDone));
  }, []);
  const { tabs, activeId } = useTabs();

  useEffect(() => {
    const stopEvents = startSessionEvents();
    void loadAppSettings();
    const onFocus = () => {
      void loadAppSettings();
      // Coming back to the app: check the PR on screen for changes now rather than at the next 45s tick.
      const { tabs, activeId } = useTabs.getState();
      const tab = tabs.find((t) => t.id === activeId);
      if (tab?.kind === 'pr' && !tab.dormant) checkSoon(tab.key);
    };
    window.addEventListener('focus', onFocus);
    const restored = restoreTabs();
    void refreshInbox();
    const inboxTimer = setInterval(() => void refreshInbox(true, true), 3 * 60_000);
    const first = useTabs.getState().tabs[0];
    if (popOutKey && first?.kind === 'pr') void openPr(popOutKey, first.id);
    // PR links from the browser extension or prreview:// links. The ones that came before the page listened (like
    // the link that launched the app) are collected after the restored tabs, so the link's tab ends up in front.
    const stopOpen = api.onOpenPr(openPrLink);
    void restored
      .catch(() => undefined)
      .then(() => api.takePendingLinks())
      .then((links) => links.forEach(openPrLink));
    const stopMenu = api.onMenu((action) => {
      const { tabs: current, activeId: active } = useTabs.getState();
      const tab = current.find((t) => t.id === active);
      if (action === 'new-tab') newTab();
      else if (action === 'close-tab') closeTab(active);
      else if (action === 'settings') openSettings();
      else if (action === 'toggle-word-wrap') setPrefs({ wordWrap: !usePrefs.getState().wordWrap });
      else if (tab?.kind === 'pr') {
        if (action === 'refresh') void api.refreshPr(tab.key);
        if (action === 'toggle-tree') updateUi(tab.key, { showTree: !getPrUi(tab.key).showTree });
        if (action === 'toggle-conversations') updateUi(tab.key, { showPanel: !getPrUi(tab.key).showPanel });
        if (action === 'find-in-files') showSearch(tab.key, selectedCode());
        if (action === 'show-files') updateUi(tab.key, { view: 'files', showTree: true, sidebar: 'files' });
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        activateIndex(Number(e.key) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      stopEvents();
      stopMenu();
      stopOpen();
      clearInterval(inboxTimer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // First run on this machine (or "Run setup again" in Settings).
  if (setup) return <SetupWizard />;

  return (
    <div className="h-full flex flex-col">
      <TabBar />
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div key={tab.id} className="absolute inset-0" style={{ display: tab.id === activeId ? 'block' : 'none' }}>
            {tab.kind === 'new' && <NewTab tabId={tab.id} />}
            {tab.kind === 'settings' && (
              <div className="h-full overflow-y-auto">
                <div className="max-w-[1180px] mx-auto px-6 pt-6 pb-12">
                  <h1 className="text-[18px] font-semibold text-strong mb-5">Settings</h1>
                  <SettingsView />
                </div>
              </div>
            )}
            {tab.kind === 'pr' && <PrView prKey={tab.key} active={tab.id === activeId} />}
          </div>
        ))}
      </div>
    </div>
  );
}
