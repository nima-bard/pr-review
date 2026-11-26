import type { ContextMenuItem } from '../../../shared/ipc';

/** What the Files view's ⚙ menu shows as chosen. */
export interface ViewMenuState {
  layout: 'split' | 'unified';
  wordWrap: boolean;
  showTree: boolean;
}

/**
 * The Files view's ⚙ menu, like github.com's diff settings: the layout, word wrap and the file tree, in one place
 * instead of a row of toolbar buttons. Headings are disabled items; ids say what to change. (The side panel has its own
 * buttons, Comments and Claude.)
 */
export function viewMenuItems(s: ViewMenuState): ContextMenuItem[] {
  return [
    { id: 'heading:layout', label: 'Layout', enabled: false },
    { id: 'layout:split', label: 'Split', checked: s.layout === 'split' },
    { id: 'layout:unified', label: 'Unified', checked: s.layout === 'unified' },
    'separator',
    { id: 'wrap', label: 'Word Wrap', checked: s.wordWrap, accelerator: 'Alt+Z' },
    { id: 'tree', label: 'File Tree', checked: s.showTree, accelerator: 'CmdOrCtrl+B' },
  ];
}

/** The Claude button's arrow: open the PR's session in Claude Desktop or Claude Code, once there is one. */
export function claudeMenuItems(hasSession: boolean): ContextMenuItem[] {
  return [
    { id: 'open:desktop', label: 'Open in Claude Desktop', enabled: hasSession },
    { id: 'open:terminal', label: 'Open in Claude Code', enabled: hasSession },
  ];
}
