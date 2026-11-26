import { describe, expect, it } from 'vitest';
import type { ContextMenuItem } from '../../src/shared/ipc';
import { claudeMenuItems, viewMenuItems } from '../../src/renderer/views/pr/viewMenus';

const item = (items: ContextMenuItem[], id: string) => items.find((i) => i !== 'separator' && i.id === id) as Exclude<ContextMenuItem, 'separator'>;
const ids = (items: ContextMenuItem[]) => items.map((i) => (i === 'separator' ? '-' : i.id));
const state = { layout: 'split' as const, wordWrap: false, showTree: true };

describe('viewMenuItems', () => {
  it('checks the chosen layout and the settings that are on', () => {
    const items = viewMenuItems(state);
    expect(item(items, 'layout:split').checked).toBe(true);
    expect(item(items, 'layout:unified').checked).toBe(false);
    expect(item(items, 'wrap').checked).toBe(false);
    expect(item(items, 'tree').checked).toBe(true);
  });

  it('leaves the side panel to its own buttons, Comments and Claude', () => {
    expect(ids(viewMenuItems(state))).toEqual(['heading:layout', 'layout:split', 'layout:unified', '-', 'wrap', 'tree']);
  });

  it('has headings that can not be chosen', () => {
    expect(item(viewMenuItems(state), 'heading:layout').enabled).toBe(false);
  });
});

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
