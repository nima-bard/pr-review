import type { RevealTarget } from '../../shared/model';
import { api } from '../api';
import { activate, useTabs } from './tabs';
import { focusFile, openAtLine, openFileTab, updateUi } from './ui';

/** Brings `target` into view in PR `key`'s view: a file (its diff, or its tab at a line), a thread, a draft or a search. */
export function revealTarget(key: string, target: RevealTarget): void {
  switch (target.kind) {
    case 'file':
      if (target.line !== null) openAtLine(key, target.path, target.line, target.changed, false);
      else if (target.changed) focusFile(key, target.path);
      else openFileTab(key, target.path, false, true);
      return;
    case 'thread':
      focusFile(key, target.path, target.threadId);
      return;
    case 'draft':
      focusFile(key, target.path, null, `draft-${target.draftId}`);
      return;
    case 'search':
      updateUi(key, { view: 'files', showTree: true, sidebar: 'search', search: target.query, searchDetails: target.query.include !== '' || target.query.exclude !== '' });
  }
}

/** Shows what an agent asks to (the show_in_app and search_code tools): switches to the PR's tab in this window, if it has one. */
export function startRevealEvents(): () => void {
  return api.onPrEvent((event) => {
    if (event.type !== 'reveal') return;
    const tab = useTabs.getState().tabs.find((t) => t.kind === 'pr' && t.key === event.key);
    if (!tab) return;
    activate(tab.id);
    revealTarget(event.key, event.target);
  });
}
