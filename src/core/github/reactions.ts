import type { Reaction, ReactionContent } from '../../shared/model';
import type { GitHubClient } from './client';
import { ADD_REACTION, REMOVE_REACTION, type ReactionGroupNode } from './queries';

export const REACTION_ORDER: readonly ReactionContent[] = ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'];

/** GitHub returns all eight groups; keep the ones someone used, in GitHub's order. */
export function toReactions(groups: readonly ReactionGroupNode[] | null | undefined): Reaction[] {
  return (groups ?? [])
    .filter((g): g is ReactionGroupNode & { content: ReactionContent } => REACTION_ORDER.includes(g.content as ReactionContent) && g.reactors.totalCount > 0)
    .map((g) => ({ content: g.content, count: g.reactors.totalCount, viewerHasReacted: g.viewerHasReacted }))
    .sort((a, b) => REACTION_ORDER.indexOf(a.content) - REACTION_ORDER.indexOf(b.content));
}

/** The reactions after the viewer toggles one, as GitHub will report them on the next refresh. */
export function toggleReaction(reactions: readonly Reaction[], content: ReactionContent, add: boolean): Reaction[] {
  const current = reactions.find((r) => r.content === content);
  if (add && current?.viewerHasReacted) return [...reactions];
  if (!add && !current?.viewerHasReacted) return [...reactions];
  const others = reactions.filter((r) => r.content !== content);
  const count = (current?.count ?? 0) + (add ? 1 : -1);
  const next = count > 0 ? [...others, { content, count, viewerHasReacted: add }] : others;
  return next.sort((a, b) => REACTION_ORDER.indexOf(a.content) - REACTION_ORDER.indexOf(b.content));
}

export async function setReaction(client: GitHubClient, subjectId: string, content: ReactionContent, add: boolean): Promise<void> {
  await client.graphql(add ? ADD_REACTION : REMOVE_REACTION, { subjectId, content });
}
