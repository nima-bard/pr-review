import type { DiffSide } from '../../shared/model';

/** Where a comment editor is open; \`draftId\`/\`body\` when it edits an existing draft. */
export interface ComposerTarget {
  path: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  draftId?: string;
  body?: string;
}

/**
 * While a comment editor is open, its text is also kept in localStorage, so switching views, collapsing the file or a
 * restart doesn't lose it. It is never sent: only "Add review comment" turns it into a draft.
 */
export const unsentKey = (prKey: string, t: ComposerTarget) => `composer:${prKey}:${t.draftId ?? `${t.path}:${t.side}:${t.startLine}-${t.endLine}`}`;

export function readUnsent(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeUnsent(key: string, value: string | null): void {
  try {
    if (value === null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Only the safety copy is lost; the editor still has the text.
  }
}

/** Whether the editor at \`target\` holds text that isn't in the review (or a draft edit that isn't saved). */
export function hasUnsavedText(prKey: string, target: ComposerTarget): boolean {
  const text = readUnsent(unsentKey(prKey, target));
  return text !== null && text.trim() !== '' && text !== (target.body ?? '');
}
