import type { Draft } from './model';

/** Your own drafts, and agent suggestions you accepted: what Submit sends. */
export const isSubmittable = (d: Draft): boolean => d.origin === undefined || d.origin.acceptedAt !== null;

/** Agent suggestions you haven't accepted yet: Submit leaves them out and keeps them. */
export const isSuggestion = (d: Draft): boolean => !isSubmittable(d);

/** Suggestions you haven't accepted, grouped by the agent request that added them, in the order they came. */
export function suggestionGroups(drafts: readonly Draft[]): { turnId: string | null; agent: string; drafts: Draft[] }[] {
  const groups: { turnId: string | null; agent: string; drafts: Draft[] }[] = [];
  for (const d of drafts) {
    if (!d.origin || d.origin.acceptedAt !== null) continue;
    const { turnId, agent } = d.origin;
    const group = groups.find((g) => g.turnId === turnId && g.agent === agent);
    if (group) group.drafts.push(d);
    else groups.push({ turnId, agent, drafts: [d] });
  }
  return groups;
}
