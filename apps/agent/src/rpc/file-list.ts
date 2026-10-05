import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { FILE_LIST_EXTENSIONS, FILE_LIST_MAX_ENTRIES, FILE_READ_MAX_BYTES, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { expandHome } from '@termhub/machine-ops';
import { allowedFolders, machinePlaces, vetPath, type AllowedFolders, type FileReadPlaces } from './file-read.js';

type Result = RpcResult<'file.list'>;
type Entry = Result['entries'][number];

/** How many entries are checked at once: enough to keep a big folder fast, few enough to spare the disk. */
const BATCH = 32;

/**
 * The Markdown files of a project (spec 2026-10-04 recent Markdown files, TER-953): names, sizes and dates,
 * never a body. Nothing about the files is logged.
 */
export function list(params: RpcParams<'file.list'>): Promise<Result> {
  return listWithin(params, machinePlaces());
}

export async function listWithin(params: RpcParams<'file.list'>, places: FileReadPlaces): Promise<Result> {
  const folders = await allowedFolders(params.roots, places);

  // Cited paths first, so a file that is both cited and in a listed folder keeps the path the server sent
  // as `asked` (the server tells a cited file by it; the folder shows in the resolved path).
  const candidates: string[] = [...params.paths];
  if (params.cwd !== null) {
    for (const dir of params.dirs) {
      // `~` alone joins to `~/<dir>`, which expandHome turns into the home path.
      const folder = path.join(params.cwd, dir);
      let names: string[];
      try {
        names = await readdir(path.resolve(expandHome(folder, places.home)));
      } catch {
        continue; // a missing (or unreadable) folder lists nothing
      }
      for (const name of names.sort()) candidates.push(path.join(folder, name));
    }
  }

  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const checked = await Promise.all(candidates.slice(i, i + BATCH).map((asked) => entryFor(asked, folders)));
    for (const e of checked) {
      if (e === null || seen.has(e.path)) continue;
      seen.add(e.path);
      entries.push(e);
    }
  }
  entries.sort((a, b) => b.mtime_ms - a.mtime_ms || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries: entries.slice(0, FILE_LIST_MAX_ENTRIES) };
}

/** `file.read`'s checks on one path, then a `stat` (never an `open`, so a FIFO cannot block). Null when refused. */
async function entryFor(asked: string, folders: AllowedFolders): Promise<Entry | null> {
  try {
    const v = await vetPath(asked, folders, FILE_LIST_EXTENSIONS);
    if (!v.ok) return null;
    const st = await stat(v.real);
    if (!st.isFile()) return null;
    return { path: v.real, asked, size: st.size, mtime_ms: Math.max(0, st.mtimeMs), too_large: st.size > FILE_READ_MAX_BYTES };
  } catch {
    return null; // gone, no permission, a link loop: left out
  }
}
