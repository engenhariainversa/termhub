/** What a checkout's `origin` URL names (spec 2026-10-07 multi-repo R4). */
export interface OriginRepo {
  /** `owner/repo` on GitHub; `<host>/<path>` elsewhere */
  full_name: string;
  github: boolean;
}

const SEGMENT_RE = /^[\w.-]+$/;
// GitHub itself, plus the ssh host aliases people keep for a second account (`github.com-work`, `github-work`):
// those only exist in an ssh config, so they have no dot of their own.
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);
const isGithubHost = (host: string, scp: boolean) => GITHUB_HOSTS.has(host) || (scp && /^github(\.com)?-[\w-]+$/.test(host));

/** host and path of a URL (`https://`, `ssh://`, `git://`) or of the scp form (`git@host:path`); null for a local path. */
function split(url: string): { host: string; path: string; scp: boolean } | null {
  const u = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
  if (u) return { host: u[1]!.toLowerCase(), path: u[2]!, scp: false };
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(url);
  if (scp) return { host: scp[1]!.toLowerCase(), path: scp[2]!, scp: true };
  return null;
}

/**
 * The repository an `origin` URL points at: `owner/repo` for GitHub (https, ssh, scp and ssh host
 * aliases), `<host>/<path>` for any other host, so it is never mistaken for a GitHub repository of the same
 * name. A local path, an empty or malformed URL → null (the caller names the checkout by its folder).
 * Credentials in the URL are never part of the result.
 */
export function repoOfOrigin(origin: string | null | undefined): OriginRepo | null {
  const url = origin?.trim();
  if (!url) return null;
  const parts = split(url);
  if (!parts) return null;
  const segments = parts.path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.length === 0 || !segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')) return null;
  if (isGithubHost(parts.host, parts.scp)) {
    return segments.length === 2 ? { full_name: `${segments[0]}/${segments[1]}`, github: true } : null;
  }
  if (!SEGMENT_RE.test(parts.host)) return null;
  return { full_name: [parts.host, ...segments].join('/'), github: false };
}
