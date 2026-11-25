import { describe, expect, it } from 'vitest';
import { moveToSlot } from '../../src/renderer/state/reorder';

describe('moveToSlot', () => {
  const tabs = ['a', 'b', 'c', 'd'];

  it('moves a tab forwards, before the tab at the slot', () => {
    expect(moveToSlot(tabs, 0, 2)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('moves a tab to the end', () => {
    expect(moveToSlot(tabs, 1, 4)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('moves a tab backwards', () => {
    expect(moveToSlot(tabs, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveToSlot(tabs, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('leaves the order alone for the slots on either side of the tab itself', () => {
    expect(moveToSlot(tabs, 1, 1)).toEqual(tabs);
    expect(moveToSlot(tabs, 1, 2)).toEqual(tabs);
  });
});
