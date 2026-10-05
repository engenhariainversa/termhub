import path from 'node:path';
import { CAPABILITY_FILE_LIST, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import type { FileRecentGroup, TFileRecentItem, TFileRecentResponse } from '@termhub/mobile-api';
import { agentRpc } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import type { Scoped } from '../auth/scope.js';
import type { Repositories } from '../db/repositories/index.js';
import type { CitedText } from '../db/repositories/tabs.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { pathOn, relativeToProject, type AgentView } from './core.js';
import { mdPathsIn } from './md-paths.js';

/**
 * A project's recent Markdown files (spec 2026-10-04 recent Markdown files, TER-953): per linked agent
 * machine, the repository docs folders and the files the project's tabs on it cited, listed by its agent
 * (`file.list`: names, sizes and dates, never a body). Nothing is stored; only counts are logged.
 */

export type ListRpc = (machine: Machine, params: RpcParams<'file.list'>) => Promise<RpcResult<'file.list'>>;

const defaultRpc: ListRpc = (machine, params) => agentRpc(machine, 'file.list', params);

export interface RecentDeps {
  agent?: AgentView;
  rpc?: ListRpc;
}

/** The repository docs folders listed under each project folder, and the group each one shows as (D3). */
export const RECENT_DIRS: ReadonlyArray<readonly [string, Exclude<FileRecentGroup, 'other'>]> = [
  ['docs/superpowers/specs', 'specs'],
  ['docs/superpowers/plans', 'plans'],
  ['docs/lessons', 'lessons'],
  ['docs/legal', 'legal'],
];
/** The lessons folder's own format doc, not a lesson. */
const LESSONS_README = 'docs/lessons/README.md';
/** At most this many cited paths per machine (D4; the RPC takes 100). */
export const MAX_CITED_PATHS = 100;
/** At most this many files in the answer, newest first (D4). */
export const MAX_RECENT_ITEMS = 300;

const isMachinePath = (p: string) => p.startsWith('/') || p.startsWith('~/');

/** The cited paths to send this machine: newest texts first, relative ones under its project folder, distinct. */
export function citedPathsFor(texts: Iterable<string>, cwd: string): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const p of mdPathsIn(text)) {
      const asked = pathOn(p, cwd);
      // `..` can climb out of a `~` folder into a relative path: not one a machine can be asked for.
      if (!asked || !isMachinePath(asked) || asked.length > 4096) continue;
      out.add(asked);
      if (out.size >= MAX_CITED_PATHS) return [...out];
    }
  }
  return [...out];
}

function groupOf(rel: string | null): FileRecentGroup {
  if (!rel) return 'other';
  const dir = path.posix.dirname(rel);
  return RECENT_DIRS.find(([d]) => d === dir)?.[1] ?? 'other';
}

/**
 * The project folder as the machine resolved it, learnt from an entry asked under the folder as written
 * whose resolved path ends the same way (`~/p/docs/a.md` → `/home/u/p/docs/a.md` gives `/home/u/p`).
 * Null when no entry tells, or the folder is already absolute and resolves to itself.
 */
function resolvedRoot(entries: RpcResult<'file.list'>['entries'], cwd: string): string | null {
  for (const e of entries) {
    const rel = relativeToProject(e.asked, cwd);
    if (rel && e.path.endsWith(`/${rel}`)) {
      const root = e.path.slice(0, -(rel.length + 1));
      if (root && root !== path.posix.normalize(cwd).replace(/\/+$/, '')) return root;
    }
  }
  return null;
}

type Skip ='offline' | 'outdated' | 'unsupported';
type Outcome = { items: TFileRecentItem[] } | { skip: Skip };

export async function recentFiles(
  repos: Pick<Repositories, 'tabs'>,
  scoped: Scoped,
  projectId: string,
  deps: RecentDeps = {},
  log?: { warn: (obj: object, msg: string) => void },
): Promise<TFileRecentResponse> {
  const agent = deps.agent ?? agents;
  const rpc = deps.rpc ?? defaultRpc;
  const { machines } = await scoped.projectMachines(projectId);

  const precheck = (machine: Machine): Skip | null => {
    if (machine.type !== 'agent') return 'unsupported';
    if (!agent.isOnline(machine.id)) return 'offline';
    if (!(agent.capabilities(machine.id) ?? []).includes(CAPABILITY_FILE_LIST)) return 'outdated';
    return null;
  };

  // The texts are read only when some machine will be asked.
  const texts: CitedText[] = machines.some(({ machine }) => precheck(machine) === null) ? await repos.tabs.citedTexts(projectId) : [];

  const outcomes = await Promise.all(
    machines.map(async ({ machine, link }): Promise<Outcome> => {
      const skip = precheck(machine);
      if (skip) return { skip };
      const cwd = link.cwd;
      const paths = citedPathsFor(
        texts.filter((t) => t.machineId === machine.id).map((t) => t.text),
        cwd,
      );
      let r: RpcResult<'file.list'>;
      try {
        r = await rpc(machine, { cwd, dirs: RECENT_DIRS.map(([d]) => d), paths, roots: [cwd] });
      } catch (err) {
        // A dropped agent, a timeout or a failure on the machine: the list goes on without it.
        const code = err instanceof HttpError ? err.code : 'error';
        log?.warn({ machine_id: machine.id, code }, 'file recent: machine skipped');
        return { skip: 'offline' };
      }
      const cited = new Set(paths);
      const ref = { id: machine.id, name: machine.name };
      const realRoot = resolvedRoot(r.entries, cwd);
      const items: TFileRecentItem[] = [];
      for (const e of r.entries) {
        // The path as asked keeps the project folder as the link wrote it (`~/…`); the resolved one is the
        // fallback, against the folder as written or as the machine resolved it (a cited `/home/u/p/…`
        // under a `~/p` link).
        const rel = relativeToProject(e.asked, cwd) ?? relativeToProject(e.path, cwd) ?? (realRoot ? relativeToProject(e.path, realRoot) : null);
        if (rel === LESSONS_README) continue;
        items.push({
          machine: ref,
          path: e.path,
          rel_path: rel,
          name: path.posix.basename(e.path),
          size: e.size,
          mtime: new Date(e.mtime_ms).toISOString(),
          too_large: e.too_large,
          group: groupOf(rel),
          cited: cited.has(e.asked),
        });
      }
      return { items };
    }),
  );

  const items: TFileRecentItem[] = [];
  const skipped: TFileRecentResponse['skipped'] = [];
  const seen = new Set<string>();
  outcomes.forEach((o, i) => {
    const { machine } = machines[i];
    if ('skip' in o) {
      skipped.push({ machine: { id: machine.id, name: machine.name }, reason: o.skip });
      return;
    }
    for (const item of o.items) {
      const key = `${machine.id}\0${item.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  });
  items.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
  return { items: items.slice(0, MAX_RECENT_ITEMS), skipped };
}
