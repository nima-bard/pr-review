import type { FilterSuggestion, SuggestionKind } from '../../shared/model';
import type { GitHubClient } from './client';

type User = { login: string; name: string | null; avatarUrl: string };
type Label = { name: string; color: string; description: string | null };

const usersQuery = (field: 'mentionableUsers' | 'assignableUsers') => `query($owner: String!, $repo: String!, $q: String) {
  repository(owner: $owner, name: $repo) {
    ${field}(first: 12, query: $q) { nodes { login name avatarUrl } }
  }
}`;

const LABELS = `query($owner: String!, $repo: String!, $q: String) {
  repository(owner: $owner, name: $repo) {
    labels(first: 30, query: $q, orderBy: { field: NAME, direction: ASC }) { nodes { name color description } }
  }
}`;

/**
 * Suggestions for a search filter in a repository, matching `q`: its labels, or people (anyone who can be mentioned
 * there for an author, people who can be assigned for reviewers and assignees).
 */
export async function filterSuggestions(client: GitHubClient, owner: string, repo: string, kind: SuggestionKind, q: string): Promise<FilterSuggestion[]> {
  const vars = { owner, repo, q: q.trim() || null };
  if (kind === 'label') {
    const data = await client.graphql<{ repository: { labels: { nodes: Label[] } } | null }>(LABELS, vars);
    return (data.repository?.labels.nodes ?? []).map((l) => ({ value: l.name, label: l.name, detail: l.description || null, avatarUrl: null, color: `#${l.color}` }));
  }
  const field = kind === 'author' ? 'mentionableUsers' : 'assignableUsers';
  const data = await client.graphql<{ repository: Partial<Record<typeof field, { nodes: User[] }>> | null }>(usersQuery(field), vars);
  return (data.repository?.[field]?.nodes ?? []).map((u) => ({ value: u.login, label: u.login, detail: u.name || null, avatarUrl: u.avatarUrl, color: null }));
}
