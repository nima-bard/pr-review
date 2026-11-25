import { create } from 'zustand';
import type { InboxSection } from '../../shared/model';
import { api, errorText } from '../api';

interface InboxState {
  sections: InboxSection[];
  loading: boolean;
  error: string | null;
  loadedAt: number;
  /** Sections the user expanded with "Load more", and the one currently loading. */
  expanded: Set<InboxSection['id']>;
  loadingMore: InboxSection['id'] | null;
}

export const useInbox = create<InboxState>(() => ({ sections: [], loading: false, error: null, loadedAt: 0, expanded: new Set(), loadingMore: null }));

/**
 * `background`: the periodic refresh, which leaves sections you expanded with "Load more" as they are rather than
 * collapsing them back to the first page. A manual refresh reloads everything.
 */
export async function refreshInbox(force = false, background = false): Promise<void> {
  const s = useInbox.getState();
  if (s.loading || (!force && Date.now() - s.loadedAt < 60_000)) return;
  useInbox.setState({ loading: true });
  try {
    const fresh = await api.inbox();
    useInbox.setState((cur) => {
      const keep = background ? cur.expanded : new Set<InboxSection['id']>();
      const sections = fresh.map((sec) => (keep.has(sec.id) ? (cur.sections.find((x) => x.id === sec.id) ?? sec) : sec));
      return { sections, loading: false, error: null, loadedAt: Date.now(), expanded: keep };
    });
  } catch (err) {
    useInbox.setState({ loading: false, error: errorText(err), loadedAt: Date.now() });
  }
}

/** Appends the next page of a section's search. */
export async function loadMore(id: InboxSection['id']): Promise<void> {
  const section = useInbox.getState().sections.find((x) => x.id === id);
  if (!section?.hasNextPage || !section.endCursor || useInbox.getState().loadingMore) return;
  useInbox.setState({ loadingMore: id });
  try {
    const page = await api.search(section.query, section.endCursor);
    useInbox.setState((cur) => ({
      loadingMore: null,
      expanded: new Set([...cur.expanded, id]),
      sections: cur.sections.map((x) => {
        if (x.id !== id) return x;
        const known = new Set(x.items.map((i) => i.key));
        return { ...x, items: [...x.items, ...page.items.filter((i) => !known.has(i.key))], endCursor: page.endCursor, hasNextPage: page.hasNextPage, total: page.total };
      }),
    }));
  } catch (err) {
    useInbox.setState({ loadingMore: null, error: errorText(err) });
  }
}

export function useWaitingCount(): number {
  return useInbox((s) => s.sections.find((x) => x.id === 'review-requested')?.total ?? 0);
}
