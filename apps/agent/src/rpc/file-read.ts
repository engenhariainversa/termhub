import { constants } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FILE_READ_EXTENSIONS, FILE_READ_MAX_BYTES, type FileReadRefusal, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { expandHome } from '@termhub/machine-ops';
import { agentHome } from '../config.js';

/** Extra allowed folders, one absolute (or `~/…`) path per line, `#` for comments. Optional; only the
 *  machine's owner can write it, so the server can never widen what the agent reads. */
export const FILE_ROOTS_FILE = 'file-read-roots';

type Result = RpcResult<'file.read'>;
const refuse = (status: FileReadRefusal, size?: number): Result => (size === undefined ? { status } : { status, size });

/** The folders the owner listed in `~/.termhub/file-read-roots`; none when the file is missing. */
export async function configuredRoots(): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(agentHome(), FILE_ROOTS_FILE), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Lexical form of every allowed folder: absolute, normalized, never `/` (a root of `/` would allow everything). */
function lexicalRoots(given: string[], home: string, tmp: string[]): string[] {
  const all = [...given, home, ...tmp];
  const out = new Set<string>();
  for (const r of all) {
    const p = expandHome(r, home);
    if (!path.isAbsolute(p)) continue;
    const n = path.resolve(p);
    if (n !== path.parse(n).root) out.add(n);
  }
  return [...out];
}

/**
 * Where `file` sits against the folders: `ok` when some folder holds it with no dot segment below
 * that folder, `hidden` when the only folders holding it see a dot segment, else `outside`.
 */
export function placeIn(file: string, roots: string[]): 'ok' | 'hidden' | 'outside' {
  let hidden = false;
  for (const root of roots) {
    const rel = path.relative(root, file);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) hidden = true;
    else return 'ok';
  }
  return hidden ? 'hidden' : 'outside';
}

/** Whether `p` ends in one of `extensions` (lowercase compare). */
export const allowedType = (p: string, extensions: readonly string[] = FILE_READ_EXTENSIONS) => extensions.includes(path.extname(p).toLowerCase());

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

function fsRefusal(e: unknown): Result {
  const code = errno(e);
  if (code === 'ENOENT' || code === 'ENOTDIR') return refuse('missing');
  if (code === 'EACCES' || code === 'EPERM') return refuse('eperm');
  // O_NOFOLLOW on a link swapped in after realpath
  if (code === 'ELOOP') return refuse('outside');
  throw e;
}

/** Where the agent always allows reading: the user's home and the temp dirs agents write reports to. */
export interface FileReadPlaces {
  home: string;
  tmp: string[];
}

/** Every allowed folder, as written and resolved (links followed; a folder that does not exist drops out). */
export interface AllowedFolders {
  home: string;
  lexical: string[];
  real: string[];
}

/** The folders a path may sit in: `given` (the project folders the server sent), the owner's
 *  `~/.termhub/file-read-roots`, home and the temp dirs. */
export async function allowedFolders(given: string[], places: FileReadPlaces): Promise<AllowedFolders> {
  const lexical = lexicalRoots([...given, ...(await configuredRoots())], places.home, places.tmp);
  const real = (await Promise.all(lexical.map((r) => realpath(r).catch(() => null)))).filter((r): r is string => r !== null && r !== '/');
  return { home: places.home, lexical, real };
}

export type Vetted = { ok: true; asked: string; real: string } | { ok: false; status: 'outside' | 'hidden' | 'type' };

/**
 * Checks 1 and 2 of `file.read`, shared with `file.list`: the path as written (`~/` expanded) and the file it
 * resolves to (links followed) must each sit under a folder with no dot segment below it and end in one of
 * `extensions`. Throws the `realpath` error (missing file, no permission) to the caller. Never opens the file.
 */
export async function vetPath(p: string, folders: AllowedFolders, extensions: readonly string[]): Promise<Vetted> {
  const asked = path.resolve(expandHome(p, folders.home));
  // 1. The path as written: under a folder, no dot segment, an allowed extension.
  const lexical = placeIn(asked, folders.lexical);
  if (lexical !== 'ok') return { ok: false, status: lexical };
  if (!allowedType(asked, extensions)) return { ok: false, status: 'type' };
  // 2. The file it resolves to, links followed: the same three checks against the folders' real paths,
  //    so a link inside the project that points at ~/.ssh or /etc is refused.
  const real = await realpath(asked);
  const resolved = placeIn(real, folders.real);
  if (resolved !== 'ok') return { ok: false, status: resolved };
  if (!allowedType(real, extensions)) return { ok: false, status: 'type' };
  return { ok: true, asked, real };
}

/** A text file the person asked to preview (spec 2026-10-04 file preview). Nothing of its body is logged. */
export function read(params: RpcParams<'file.read'>): Promise<Result> {
  return readWithin(params, machinePlaces());
}

/** This machine's home and temp dirs. */
export const machinePlaces = (): FileReadPlaces => ({ home: os.homedir(), tmp: [os.tmpdir(), '/tmp'] });

export async function readWithin(params: RpcParams<'file.read'>, places: FileReadPlaces): Promise<Result> {
  const folders = await allowedFolders(params.roots, places);
  let real: string;
  try {
    const v = await vetPath(params.path, folders, FILE_READ_EXTENSIONS);
    if (!v.ok) return refuse(v.status);
    real = v.real;
  } catch (e) {
    return fsRefusal(e);
  }

  // 3. A regular file, checked before opening (a FIFO would block the open) and again on the handle.
  try {
    if (!(await stat(real)).isFile()) return refuse('not_file');
  } catch (e) {
    return fsRefusal(e);
  }
  let fh;
  try {
    fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return fsRefusal(e);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return refuse('not_file');
    if (st.size > FILE_READ_MAX_BYTES) return refuse('too_large', st.size);
    // One byte past the limit tells a file that grew since the stat.
    const buf = Buffer.alloc(FILE_READ_MAX_BYTES + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got > FILE_READ_MAX_BYTES) return refuse('too_large', got);
    const body = buf.subarray(0, got);
    if (body.includes(0)) return refuse('binary');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return refuse('binary');
    }
    return { status: 'ok', path: real, size: got, mtime_ms: st.mtimeMs, content_b64: body.toString('base64') };
  } finally {
    await fh.close();
  }
}
