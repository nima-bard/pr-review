export interface RemoteInfo {
  host: string;
  owner: string;
  repo: string;
}

const SSH_SCP = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)(?::\d+)?[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/;
const HTTP = /^https?:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/;

export function parseRemote(url: string): RemoteInfo | undefined {
  const match = HTTP.exec(url) ?? SSH_SCP.exec(url);
  if (!match) return undefined;
  const [, host, owner, repo] = match;
  if (!host || !owner || !repo || repo.includes('/')) return undefined;
  return { host: host.toLowerCase(), owner, repo };
}

/** Parses `git config --get-regexp '^remote\..*\.url$'`: the configured URLs, before any insteadOf rewriting. */
export function parseRemoteConfig(out: string): { name: string; info: RemoteInfo }[] {
  const result: { name: string; info: RemoteInfo }[] = [];
  for (const line of out.split('\n')) {
    const m = /^remote\.(.+)\.url\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const info = parseRemote(m[2]!);
    if (info && !result.some((r) => r.name === m[1])) result.push({ name: m[1]!, info });
  }
  return result;
}

export function parseRemotes(remoteV: string): { name: string; info: RemoteInfo }[] {
  const seen = new Set<string>();
  const result: { name: string; info: RemoteInfo }[] = [];
  for (const line of remoteV.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (!m) continue;
    const info = parseRemote(m[2]!);
    if (!info || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    result.push({ name: m[1]!, info });
  }
  return result;
}
