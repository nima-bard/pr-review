import type { ContextMenuItem } from '../../../shared/ipc';

/** What the Files view's ⚙ menu shows as chosen. */
export interface ViewMenuState {
  layout: 'split' | 'unified';
  wordWrap: boolean;
  showTree: boolean;
  showPanel: boolean;
  /** Unresolved threads, shown next to Conversations as the toolbar button used to. */
  openThreads: number;
}

/**
 * The Files view's ⚙ menu, like github.com's diff settings: the layout, word wrap and which side panels show, in one
 * place instead of a row of toolbar buttons. Headings are disabled items; ids say what to change.
 */
export function viewMenuItems(s: ViewMenuState): ContextMenuItem[] {
  return [
    { id: 'heading:layout', label: 'Layout', enabled: false },
    { id: 'layout:split', label: 'Split', checked: s.layout === 'split' },
    { id: 'layout:unified', label: 'Unified', checked: s.layout === 'unified' },
    'separator',
    { id: 'wrap', label: 'Word Wrap', checked: s.wordWrap, accelerator: 'Alt+Z' },
    'separator',
    { id: 'heading:panels', label: 'Panels', enabled: false },
    { id: 'tree', label: 'File Tree', checked: s.showTree, accelerator: 'CmdOrCtrl+B' },
    { id: 'conversations', label: s.openThreads > 0 ? `Conversations (${s.openThreads} open)` : 'Conversations', checked: s.showPanel, accelerator: 'CmdOrCtrl+Shift+C' },
  ];
}

/** The agent's menu: run a review, and show or hide its conversation. */
export function agentMenuItems(agentName: string, panelOpen: boolean): ContextMenuItem[] {
  return [
    { id: 'review', label: `Review with ${agentName}` },
    'separator',
    { id: 'panel', label: 'Show Conversation', checked: panelOpen, accelerator: 'CmdOrCtrl+Shift+A' },
  ];
}
