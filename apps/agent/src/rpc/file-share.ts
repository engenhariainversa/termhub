import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { FILE_SHARE_EXTENSIONS, FILE_SHARE_MAX_BYTES, type FileShareRefusal, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { expandHome, isSecretPath } from '@termhub/machine-ops';
import { allowedFolders, machinePlaces, vetPath, type AllowedFolders, type FileReadPlaces } from './file-read.js';

type Result = RpcResult<'file.share'>;
const refuse = (status: FileShareRefusal, size?: number): Result => (size === undefined ? { status } : { status, size });

/** One chunk of a file the chat publishes in the conversation (TER-1086). Nothing of its body is logged. */
export function share(params: RpcParams<'file.share'>): Promise<Result> {
  return shareWithin(params, machinePlaces());
}

/** `roots` alone (an agent tab shares from its project folder only), or with the agent's own folders. */
async function foldersFor(params: RpcParams<'file.share'>, places: FileReadPlaces): Promise<AllowedFolders> {
  if (!params.only_roots) return allowedFolders(params.roots, places);
  const lexical = [...new Set(params.roots.map((r) => path.resolve(expandHome(r, places.home))).filter((r) => r !== path.parse(r).root))];
  const real = (await Promise.all(lexical.map((r) => realpath(r).catch(() => null)))).filter((r): r is string => r !== null && r !== '/');
  return { home: places.home, lexical, real };
}

function fsRefusal(e: unknown): Result {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return refuse('missing');
  if (code === 'EACCES' || code === 'EPERM') return refuse('eperm');
  // O_NOFOLLOW on a link swapped in after realpath
  if (code === 'ELOOP') return refuse('outside');
  throw e;
}

export async function shareWithin(params: RpcParams<'file.share'>, places: FileReadPlaces): Promise<Result> {
  // A secret is refused before anything is resolved: not even whether it exists is answered.
  const asked = path.resolve(expandHome(params.path, places.home));
  if (isSecretPath(asked)) return refuse('secret');
  const folders = await foldersFor(params, places);
  let real: string;
  try {
    const v = await vetPath(params.path, folders, FILE_SHARE_EXTENSIONS);
    if (!v.ok) return refuse(v.status);
    real = v.real;
  } catch (e) {
    return fsRefusal(e);
  }
  // The file a link resolves to is checked the same way: a link in ~/out pointing at a key is a key.
  if (isSecretPath(real)) return refuse('secret');

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
    if (st.size > FILE_SHARE_MAX_BYTES) return refuse('too_large', st.size);
    if (params.offset > st.size) return refuse('changed');
    const want = Math.min(params.length, st.size - params.offset);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, params.offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    // Shorter than the stat said: the file shrank while it was read.
    if (got < want) return refuse('changed');
    return { status: 'ok', path: real, size: st.size, mtime_ms: st.mtimeMs, offset: params.offset, content_b64: buf.toString('base64') };
  } finally {
    await fh.close();
  }
}
