import type { PrSnapshot } from '../../../shared/model';
import { Octicon } from '../../components/octicons';
import { Icon } from '../../components/ui';
import { useClaudeSettings } from '../../state/claude';
import { useClaudeView } from '../../state/sessions';
import { getPrUi, showSidePanel, updateUi, usePrUi, type PrUi, type SidePanelTab } from '../../state/ui';
import { ClaudeConversation } from './ClaudeConversation';
import { ConversationsPanel } from './ConversationsPanel';

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

/** The Comments and Claude buttons (⇧⌘C, ⇧⌘A): show the side panel on `tab`, or close it when it already shows `tab`. */
export function toggleSidePanel(key: string, tab: SidePanelTab): void {
  if (shows(getPrUi(key), useClaudeSettings.getState().enabled, tab)) updateUi(key, { showPanel: false });
  else showSidePanel(key, tab);
}

/** Whether Claude is answering or has a question on its way, for a spinner on its button. */
export function useClaudeWorking(key: string): boolean {
  const view = useClaudeView(key);
  return view !== undefined && (view.busy !== null || view.pending.some((p) => p.state !== 'failed'));
}

/**
 * The Files view's one side panel: the review comments, or the conversation with Claude when Claude is on. The header
 * buttons choose which; both stay mounted, so switching keeps your place and what you were typing.
 */
export function SidePanel({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const ui = usePrUi(key);
  const claudeOn = useClaudeSettings((s) => s.enabled);
  const tab = shownTab(ui, claudeOn);
  return (
    <aside aria-label="Side panel" className="h-full flex flex-col bg-side">
      <div className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 border-b border-line">
        {tab === 'claude' ? <Icon name="comment" size={14} className="text-muted" /> : <Octicon name="comment-discussion" className="text-muted" />}
        <h2 className="text-[13.5px] font-semibold text-strong">{tab === 'claude' ? 'Claude' : 'Comments'}</h2>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Close the side panel"
          title={tab === 'claude' ? 'Close (⇧⌘A)' : 'Close (⇧⌘C)'}
          onClick={() => updateUi(key, { showPanel: false })}
          className="grid place-items-center w-7 h-7 rounded-md text-muted hover:text-fg hover:bg-raised cursor-pointer"
        >
          <Octicon name="x" />
        </button>
      </div>
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
