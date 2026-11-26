import type { ContextMenuItem } from '../../../shared/ipc';

/** The side panel's “Open in” button on Claude: the PR's session in Claude Desktop or Claude Code, once there is one. */
export function claudeMenuItems(hasSession: boolean): ContextMenuItem[] {
  return [
    { id: 'open:desktop', label: 'Open in Claude Desktop', enabled: hasSession },
    { id: 'open:terminal', label: 'Open in Claude Code', enabled: hasSession },
  ];
}
