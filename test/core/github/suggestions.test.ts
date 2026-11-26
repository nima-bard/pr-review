import { describe, expect, it } from 'vitest';
import type { GitHubClient } from '../../../src/core/github/client';
import { filterSuggestions } from '../../../src/core/github/suggestions';

function fakeClient(repository: unknown) {
  const calls: { query: string; vars: Record<string, unknown> }[] = [];
  const client = {
    async graphql<T>(query: string, vars: Record<string, unknown> = {}): Promise<T> {
      calls.push({ query, vars });
      return { repository } as T;
    },
  } as unknown as GitHubClient;
  return { client, calls };
}

describe('filterSuggestions', () => {
  it('suggests labels with their colour and description', async () => {
    const { client, calls } = fakeClient({ labels: { nodes: [{ name: 'needs review', color: 'd73a4a', description: '' }] } });
    expect(await filterSuggestions(client, 'acme', 'demo', 'label', ' need ')).toEqual([
      { value: 'needs review', label: 'needs review', detail: null, avatarUrl: null, color: '#d73a4a' },
    ]);
    expect(calls[0]!.vars).toEqual({ owner: 'acme', repo: 'demo', q: 'need' });
  });

  it('asks for anyone who can be mentioned for an author, and assignable people for reviewers', async () => {
    const people = { nodes: [{ login: 'octo', name: 'Octo Cat', avatarUrl: 'https://a/octo' }] };
    const author = fakeClient({ mentionableUsers: people });
    expect(await filterSuggestions(author.client, 'acme', 'demo', 'author', '')).toEqual([
      { value: 'octo', label: 'octo', detail: 'Octo Cat', avatarUrl: 'https://a/octo', color: null },
    ]);
    expect(author.calls[0]!.query).toContain('mentionableUsers');
    expect(author.calls[0]!.vars.q).toBeNull();

    const reviewer = fakeClient({ assignableUsers: people });
    expect(await filterSuggestions(reviewer.client, 'acme', 'demo', 'reviewer', 'oc')).toHaveLength(1);
    expect(reviewer.calls[0]!.query).toContain('assignableUsers');
  });

  it('is empty for a repository it can’t see', async () => {
    expect(await filterSuggestions(fakeClient(null).client, 'acme', 'gone', 'assignee', '')).toEqual([]);
  });
});
