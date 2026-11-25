import { describe, expect, it } from 'vitest';
import type { ContextMenuItem } from '../../src/shared/ipc';
import { agentMenuItems, viewMenuItems } from '../../src/renderer/views/pr/viewMenus';

const item = (items: ContextMenuItem[], id: string) => items.find((i) => i !== 'separator' && i.id === id) as Exclude<ContextMenuItem, 'separator'>;
const state = { layout: 'split' as const, wordWrap: false, showTree: true, showPanel: false, openThreads: 3 };

describe('viewMenuItems', () => {
  it('checks the chosen layout and the settings that are on', () => {
    const items = viewMenuItems(state);
    expect(item(items, 'layout:split').checked).toBe(true);
    expect(item(items, 'layout:unified').checked).toBe(false);
    expect(item(items, 'wrap').checked).toBe(false);
    expect(item(items, 'tree').checked).toBe(true);
    expect(item(items, 'conversations').checked).toBe(false);
  });

  it('shows the open threads next to Conversations, as the toolbar button did', () => {
    expect(item(viewMenuItems(state), 'conversations').label).toBe('Conversations (3 open)');
    expect(item(viewMenuItems({ ...state, openThreads: 0 }), 'conversations').label).toBe('Conversations');
  });

  it('has headings that can not be chosen', () => {
    expect(item(viewMenuItems(state), 'heading:layout').enabled).toBe(false);
  });
});

describe('agentMenuItems', () => {
  it('offers a review with the agent and its conversation, checked while the panel is open', () => {
    const items = agentMenuItems('Claude', true);
    expect(item(items, 'review').label).toBe('Review with Claude');
    expect(item(items, 'panel').checked).toBe(true);
  });
});
