import { useEffect } from 'react';
import { api } from './api';
import { TabBar } from './components/TabBar';
import { refreshInbox } from './state/inbox';
import { startDockTabs } from './state/dockTabs';
import { startRevealEvents } from './state/reveal';
import { checkSoon, startSessionEvents, useSessions } from './state/sessions';
import { loadQuickActions, prActions, runQuickAction } from './state/quickActions';
import { loadClaudeSettings, useClaudeSettings } from './state/claude';
import { loadAppSettings } from './state/settings';
import { activate, activateIndex, closePrTabs, closeTab, newTab, openPr, openPrLink, openSettings, popOutKey, restoreTabs, useTabs } from './state/tabs';
import { getPrUi, openFind, setPrefs, showSearch, stepFind, updateUi, usePrefs } from './state/ui';
import { NewTab } from './views/newtab/NewTab';
import { SettingsView } from './views/newtab/SettingsView';
import { PrView } from './views/pr/PrView';
import { togglePanel, toggleSidePanel } from './views/pr/SidePanel';
import { showSetup, useSetup } from './state/setup';
import { startUpdateChecks } from './state/updates';
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
    const stopEvents = startSessionEvents(closePrTabs);
    const stopReveals = startRevealEvents();
    const stopDock = startDockTabs();
    const stopActivate = api.onActivateTab(activate);
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
    void loadQuickActions();
    void loadClaudeSettings();
    void refreshInbox();
    const inboxTimer = setInterval(() => void refreshInbox(true, true), 3 * 60_000);
    const stopUpdates = popOutKey ? () => undefined : startUpdateChecks();
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
        if (action === 'layout-split' || action === 'layout-unified') updateUi(tab.key, { layout: action === 'layout-split' ? 'split' : 'unified' });
        if (action === 'toggle-comments') togglePanel(tab.key);
        if (action === 'find-in-files') showSearch(tab.key, selectedCode());
        if (action === 'find') openFind(tab.key, selectedCode());
        if (action === 'find-next') stepFind(tab.key, 1);
        if (action === 'find-previous') stepFind(tab.key, -1);
        if (action === 'toggle-claude' && useClaudeSettings.getState().enabled) toggleSidePanel(tab.key, 'claude');
        if (action === 'show-files') updateUi(tab.key, { view: 'files', showTree: true, sidebar: 'files' });
      }
    });
    const onKey = (e: KeyboardEvent) => {
      // ⌥⌘1–9: the open PR's quick actions, in their order in Settings.
      if (e.metaKey && e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const { tabs, activeId } = useTabs.getState();
        const tab = tabs.find((t) => t.id === activeId);
        const snapshot = tab?.kind === 'pr' ? useSessions.getState().snapshots[tab.key] : undefined;
        const action = snapshot ? prActions(snapshot)[Number(e.code.slice(5)) - 1] : undefined;
        if (snapshot && action) {
          e.preventDefault();
          void runQuickAction(snapshot.key, action.id);
        }
        return;
      }
      if (e.metaKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        activateIndex(Number(e.key) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      stopEvents();
      stopDock();
      stopActivate();
      stopReveals();
      stopMenu();
      stopOpen();
      clearInterval(inboxTimer);
      stopUpdates();
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
            {tab.kind === 'settings' && <SettingsView />}
            {tab.kind === 'pr' && <PrView prKey={tab.key} active={tab.id === activeId} />}
          </div>
        ))}
      </div>
    </div>
  );
}
