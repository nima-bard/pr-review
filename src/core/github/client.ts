import type { GhTokenProvider } from './auth';

export interface GitHubEndpoints {
  graphql: string;
  rest: string;
  web: string;
}

export function endpointsFor(host: string): GitHubEndpoints {
  if (host === 'github.com') {
    return { graphql: 'https://api.github.com/graphql', rest: 'https://api.github.com', web: 'https://github.com' };
  }
  return { graphql: `https://${host}/api/graphql`, rest: `https://${host}/api/v3`, web: `https://${host}` };
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export class GitHubSsoError extends GitHubError {
  constructor(readonly authorizeUrl: string) {
    super(`Your organization requires SSO authorization for the GitHub CLI token. Authorize it at ${authorizeUrl}`, 403);
    this.name = 'GitHubSsoError';
  }
}

interface GraphQLEnvelope<T> {
  data?: T;
  errors?: { message: string; type?: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitHubClient {
  constructor(
    private readonly tokens: GhTokenProvider,
    readonly endpoints: GitHubEndpoints,
  ) {}

  private async send(url: string, init: RequestInit, attempt = 0): Promise<Response> {
    const token = await this.tokens.get();
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'pr-review-desktop',
        'x-github-api-version': '2022-11-28',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 401 && attempt === 0) {
      this.tokens.invalidate();
      return this.send(url, init, attempt + 1);
    }
    const sso = res.headers.get('x-github-sso');
    if (res.status === 403 && sso?.startsWith('required; url=')) throw new GitHubSsoError(sso.slice('required; url='.length));
    const retryAfter = res.headers.get('retry-after');
    if ((res.status === 403 || res.status === 429) && retryAfter && attempt < 3) {
      await sleep(Math.min(Number(retryAfter), 60) * 1000);
      return this.send(url, init, attempt + 1);
    }
    return res;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.send(this.endpoints.graphql, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new GitHubError(`GitHub GraphQL request failed: HTTP ${res.status}`, res.status);
    const envelope = (await res.json()) as GraphQLEnvelope<T>;
    if (envelope.errors && envelope.errors.length > 0) {
      throw new GitHubError(`GitHub: ${envelope.errors.map((e) => e.message).join('; ')}`);
    }
    if (!envelope.data) throw new GitHubError('GitHub GraphQL: empty response');
    return envelope.data;
  }

  /** Conditional GET: a 304 does not count against the primary rate limit. */
  async getIfChanged<T>(path: string, etag: string | null): Promise<{ changed: false } | { changed: true; etag: string | null; data: T }> {
    const res = await this.send(`${this.endpoints.rest}${path}`, {
      headers: { accept: 'application/vnd.github+json', ...(etag ? { 'if-none-match': etag } : {}) },
    });
    if (res.status === 304) return { changed: false };
    if (!res.ok) throw new GitHubError(`GET ${path} failed: HTTP ${res.status}`, res.status);
    return { changed: true, etag: res.headers.get('etag'), data: (await res.json()) as T };
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(`${this.endpoints.rest}${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()) as { message?: string }).message ?? '';
      } catch {
        detail = '';
      }
      throw new GitHubError(`${method} ${path} failed: HTTP ${res.status}${detail ? ` (${detail})` : ''}`, res.status);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
}
