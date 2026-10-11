import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TRANSCRIPT_LINE_MAX_BYTES, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { expandHome, isClaudeTranscriptPath } from '@termhub/machine-ops';
import { RpcFailure } from '../exec.js';

/** The most of the file one call reads; a line longer than this is skipped. */
const WINDOW = 4 * 1024 * 1024;
const ARRAY_MAX = 200;
const NL = 0x0a;

/** Truncates every long string and long array, whatever the shape (spec 2026-10-01 tab chat §4.2):
 *  the agent never learns the transcript's format, so a change in it needs no agent release. */
export function shrink(value: unknown, maxString: number): unknown {
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}…[+${value.length - maxString}]` : value;
  if (Array.isArray(value)) return value.slice(0, ARRAY_MAX).map((v) => shrink(v, maxString));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, maxString)]));
  return value;
}

/** One file line to what travels: null when it is not a JSON object of an asked type. */
export function shrinkLine(raw: string, types: string[], maxString: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.type !== 'string' || !types.includes(o.type)) return null;
  const out = JSON.stringify(shrink(o, maxString));
  if (Buffer.byteLength(out) <= TRANSCRIPT_LINE_MAX_BYTES) return out;
  return JSON.stringify({
    type: o.type,
    uuid: typeof o.uuid === 'string' ? o.uuid : undefined,
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : undefined,
    termhub_dropped: true,
  });
}

/** The transcript to read: the path given, or the newest `<root>/projects/*\/<sid>.jsonl` when Claude
 *  Code moved it (lesson claude-transcript-moves-when-worktree-removed). null: nowhere. */
async function locate(given: string, sessionId: string): Promise<string | null> {
  const candidates = [given];
  const projects = path.dirname(path.dirname(given));
  try {
    for (const slug of await readdir(projects)) {
      const candidate = path.join(projects, slug, `${sessionId}.jsonl`);
      if (candidate !== given) candidates.push(candidate);
    }
  } catch {
    // no projects dir: only the given path is tried
  }
  let best: { real: string; mtime: number } | null = null;
  for (const [i, candidate] of candidates.entries()) {
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    // A link is fine only when what it points at is itself a transcript of this session (an account swap).
    if (!isClaudeTranscriptPath(real, sessionId)) {
      if (i === 0) throw new RpcFailure('invalid', 'not a transcript path');
      continue;
    }
    let s;
    try {
      s = await stat(real);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    if (i === 0) return real;
    if (!best || s.mtimeMs > best.mtime) best = { real, mtime: s.mtimeMs };
  }
  return best?.real ?? null;
}

/** Lines of a Claude Code transcript by byte range. Nothing of a line is ever logged. */
export async function read(params: RpcParams<'transcript.read'>): Promise<RpcResult<'transcript.read'>> {
  const given = expandHome(params.transcript_path, os.homedir());
  if (!isClaudeTranscriptPath(given, params.session_id)) throw new RpcFailure('invalid', 'not a transcript path');
  const file = await locate(given, params.session_id);
  if (!file) return { status: 'missing', lines: [], start: 0, end: 0, size: 0 };

  const fh = await open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const keep = (raw: Buffer) => shrinkLine(raw.toString('utf8'), params.types, params.max_string);

    if (params.direction === 'forward') {
      const from = Math.min(params.offset ?? 0, size);
      const buf = Buffer.alloc(Math.min(WINDOW, size - from));
      await readFully(fh, buf, from);
      const lines: string[] = [];
      let used = 0;
      let pos = 0;
      for (;;) {
        const nl = buf.indexOf(NL, pos);
        if (nl === -1) break;
        const line = keep(buf.subarray(pos, nl));
        if (line !== null) {
          const bytes = Buffer.byteLength(line);
          if (lines.length > 0 && used + bytes > params.max_bytes) break;
          lines.push(line);
          used += bytes;
        }
        pos = nl + 1;
      }
      // A window with no newline at all is one line longer than the window: skip to its end.
      if (pos === 0 && buf.length === WINDOW) return { status: 'ok', lines: [], start: from, end: await endOfLine(fh, from + WINDOW, size), size };
      return { status: 'ok', lines, start: from, end: from + pos, size };
    }

    const to = Math.min(params.offset ?? size, size);
    const from = Math.max(0, to - WINDOW);
    const buf = Buffer.alloc(to - from);
    await readFully(fh, buf, from);
    // A window that does not start the file starts inside a line: that line belongs to an earlier page.
    const firstNl = buf.indexOf(NL);
    const first = from === 0 ? 0 : firstNl + 1;
    // The bytes after the last newline are a line still being written: not part of this page.
    const end = Math.max(first, buf.lastIndexOf(NL) + 1);
    if (from > 0 && (firstNl === -1 || end === first)) {
      // No whole line in the window: the line that ends here is longer than the window. Skip it, so
      // the next page starts before it instead of asking for this same window again.
      const begin = await startOfLine(fh, from);
      return { status: 'ok', lines: [], start: begin, end: firstNl === -1 ? begin : from + end, size };
    }
    const lines: string[] = [];
    let used = 0;
    let start = end;
    while (start > first) {
      const prev = buf.lastIndexOf(NL, start - 2);
      const begin = Math.max(first, prev + 1);
      const line = keep(buf.subarray(begin, start - 1));
      if (line !== null) {
        const bytes = Buffer.byteLength(line);
        if (lines.length > 0 && used + bytes > params.max_bytes) break;
        lines.unshift(line);
        used += bytes;
      }
      start = begin;
    }
    return { status: 'ok', lines, start: from + start, end: from + end, size };
  } finally {
    await fh.close();
  }
}

async function readFully(fh: FileHandle, buf: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < buf.length) {
    const { bytesRead } = await fh.read(buf, done, buf.length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
}

/** The byte after the newline that ends the line running through `from`; when there is none yet, the
 *  start of the window (`from - WINDOW`): the line is still being written, so cover nothing and retry later. */
async function endOfLine(fh: FileHandle, from: number, size: number): Promise<number> {
  const buf = Buffer.alloc(64 * 1024);
  for (let at = from; at < size; at += buf.length) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, at);
    if (bytesRead === 0) break;
    const nl = buf.subarray(0, bytesRead).indexOf(NL);
    if (nl !== -1) return at + nl + 1;
  }
  return from - WINDOW;
}

/** The first byte of the line running through `before - 1`: the byte after the newline before it, or 0. */
async function startOfLine(fh: FileHandle, before: number): Promise<number> {
  const buf = Buffer.alloc(64 * 1024);
  for (let to = before; to > 0; to -= buf.length) {
    const at = Math.max(0, to - buf.length);
    const { bytesRead } = await fh.read(buf, 0, to - at, at);
    const nl = buf.subarray(0, bytesRead).lastIndexOf(NL);
    if (nl !== -1) return at + nl + 1;
  }
  return 0;
}
