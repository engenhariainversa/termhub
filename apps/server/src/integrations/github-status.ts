/**
 * GitHub's public status page (https://www.githubstatus.com/api), read by automatic work to tell an outage
 * from a real failure (TER-1025): a deploy that failed during an Actions incident is run again instead of
 * pausing the project, and a run parked on a GitHub error is resumed only once Git and the API work again.
 * No token, no project data: the request carries nothing of ours.
 */

const STATUS_URL = 'https://www.githubstatus.com/api/v2/components.json';
/** One read serves every caller for this long: the page changes in minutes, the CI sync runs every minute. */
export const GITHUB_STATUS_TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;

/** The GitHub components that are not `operational` right now, by their name on the page ("Actions", "Git Operations"…). */
export interface GithubHealth {
  degraded: string[];
}

/** What a push, a PR or a deploy needs from GitHub. */
export const ACTIONS = 'Actions';
const WRITE_COMPONENTS = ['Git Operations', 'API Requests', 'Pull Requests'];

/** Whether GitHub reports trouble with Actions (a deploy that failed then is not the code's fault). */
export const actionsDegraded = (h: GithubHealth): boolean => h.degraded.includes(ACTIONS);

/** Whether GitHub reports trouble with pushes, the API or pull requests. */
export const writesDegraded = (h: GithubHealth): boolean => h.degraded.some((c) => WRITE_COMPONENTS.includes(c));

/** Reads the status page; null when it could not be read (the callers then go by what they see themselves). */
export type GithubHealthReader = () => Promise<GithubHealth | null>;

export function createGithubHealthReader(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): GithubHealthReader {
  let cached: { at: number; value: GithubHealth | null } | null = null;
  return async () => {
    if (cached && now() - cached.at < GITHUB_STATUS_TTL_MS) return cached.value;
    let value: GithubHealth | null = null;
    try {
      const res = await fetchImpl(STATUS_URL, { headers: { accept: 'application/json', 'user-agent': 'termhub' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { components?: Array<{ name?: unknown; status?: unknown }> };
        const degraded = (body.components ?? []).filter((c) => typeof c.name === 'string' && typeof c.status === 'string' && c.status !== 'operational').map((c) => c.name as string);
        value = { degraded };
      }
    } catch {
      value = null;
    }
    cached = { at: now(), value };
    return value;
  };
}

/** The process's reader, shared by the CI sync, the merge executor and the follower. */
export const githubHealth: GithubHealthReader = createGithubHealthReader();
