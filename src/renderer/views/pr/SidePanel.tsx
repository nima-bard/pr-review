import type { PrSnapshot } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Icon, PanelTitle } from '../../components/ui';
import { useClaudeSettings } from '../../state/claude';
import { setSessionError, useClaudeView } from '../../state/sessions';
import { getPrUi, showSidePanel, updateUi, usePrUi, type PrUi, type SidePanelTab } from '../../state/ui';
import { ClaudeConversation } from './ClaudeConversation';
import { ConversationsPanel } from './ConversationsPanel';
import { claudeMenuItems } from './viewMenus';

/** What the side panel shows: Claude only while Claude is on in Settings. */
function shownTab(ui: PrUi, claudeOn: boolean): SidePanelTab {
  return claudeOn ? ui.panelTab : 'comments';
}

function shows(ui: PrUi, claudeOn: boolean, tab: SidePanelTab): boolean {
  return ui.view === 'files' && ui.showPanel && shownTab(ui, claudeOn) === tab;
}

/** Whether the side panel is on screen showing `tab`, for the button that opens it. */
export function useSidePanelShows(key: string, tab: SidePanelTab): boolean {
  const ui = usePrUi(key);
  const claudeOn = useClaudeSettings((s) => s.enabled);
  return shows(ui, claudeOn, tab);
}

/** ⇧⌘A: show the side panel on `tab`, or close it when it already shows `tab`. */
export function toggleSidePanel(key: string, tab: SidePanelTab): void {
  if (shows(getPrUi(key), useClaudeSettings.getState().enabled, tab)) updateUi(key, { showPanel: false });
  else showSidePanel(key, tab);
}

/** Whether the side panel is on screen, whichever it shows. */
function isOpen(ui: PrUi): boolean {
  return ui.view === 'files' && ui.showPanel;
}

/** ⇧⌘C: show the side panel as you left it, comments or Claude, or hide it. Opens the Files view if needed. */
export function togglePanel(key: string): void {
  if (isOpen(getPrUi(key))) updateUi(key, { showPanel: false });
  else updateUi(key, { view: 'files', showPanel: true });
}

/** Whether Claude is answering or has a question on its way, for a spinner on its button. */
export function useClaudeWorking(key: string): boolean {
  const view = useClaudeView(key);
  return view !== undefined && (view.busy !== null || view.pending.some((p) => p.state !== 'failed'));
}

/** A small spinner for Claude while it's answering. */
export function ClaudeSpinner() {
  return <span className="inline-block w-3 h-3 rounded-full border-2 border-line-2 border-t-accent animate-spin flex-none" aria-hidden="true" />;
}

/** Opens the pull request's Claude session in Claude Desktop or Claude Code, once there is one. */
function OpenInClaude({ prKey }: { prKey: string }) {
  const hasSession = Boolean(useClaudeView(prKey)?.sessionId);
  const open = async () => {
    const choice = await api.contextMenu(claudeMenuItems(hasSession));
    if (choice === 'open:desktop' || choice === 'open:terminal') await api.openClaudeIn(prKey, choice === 'open:desktop' ? 'desktop' : 'terminal').catch((err: unknown) => setSessionError(prKey, errorText(err)));
  };
  return (
    <button
      type="button"
      aria-label="Open in Claude Desktop or Claude Code"
      aria-haspopup="menu"
      title={hasSession ? 'Open this pull request’s session in Claude Desktop or Claude Code' : 'Ask Claude something first: the session starts with the first question'}
      onClick={() => void open()}
      className="grid place-items-center w-7 h-7 rounded-md text-muted hover:text-fg hover:bg-raised cursor-pointer"
    >
      <Icon name="external" size={13} />
    </button>
  );
}

/**
 * The Files view's right-hand panel: the review comments, or the conversation with Claude when Claude is on, chosen in
 * the strip of icons beside it. Both stay mounted, so switching keeps your place and what you were typing.
 */
export function SidePanel({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const ui = usePrUi(key);
  const claudeOn = useClaudeSettings((s) => s.enabled);
  const tab = shownTab(ui, claudeOn);
  return (
    // data-side-panel: clicks in here (the Claude box) keep a text selection's context, see useTextSelectionContext.
    <aside aria-label="Side panel" data-side-panel className="h-full flex flex-col bg-side">
      <PanelTitle title={tab === 'claude' ? 'Claude' : 'Comments'}>{claudeOn && tab === 'claude' && <OpenInClaude prKey={key} />}</PanelTitle>
      <section aria-label="Comments" hidden={tab !== 'comments'} className="flex-1 min-h-0 flex flex-col">
        <ConversationsPanel snapshot={snapshot} />
      </section>
      {claudeOn && (
        <section aria-label="Claude" hidden={tab !== 'claude'} className="flex-1 min-h-0 flex flex-col">
          <ClaudeConversation snapshot={snapshot} shown={tab === 'claude'} />
        </section>
      )}
    </aside>
  );
}
