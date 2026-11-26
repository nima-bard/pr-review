import { describe, expect, it } from 'vitest';
import type { ContextMenuItem } from '../../src/shared/ipc';
import { claudeMenuItems } from '../../src/renderer/views/pr/viewMenus';

const item = (items: ContextMenuItem[], id: string) => items.find((i) => i !== 'separator' && i.id === id) as Exclude<ContextMenuItem, 'separator'>;
const ids = (items: ContextMenuItem[]) => items.map((i) => (i === 'separator' ? '-' : i.id));
describe('claudeMenuItems', () => {
  it('opens the session in Claude Desktop or Claude Code, and nothing else', () => {
    const items = claudeMenuItems(true);
    expect(ids(items)).toEqual(['open:desktop', 'open:terminal']);
    expect(item(items, 'open:desktop')).toMatchObject({ label: 'Open in Claude Desktop', enabled: true });
    expect(item(items, 'open:terminal')).toMatchObject({ label: 'Open in Claude Code', enabled: true });
  });

  it('can’t open a session before the first question has started it', () => {
    const items = claudeMenuItems(false);
    expect(item(items, 'open:desktop').enabled).toBe(false);
    expect(item(items, 'open:terminal').enabled).toBe(false);
  });
});
