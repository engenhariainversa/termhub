import { buildDocsReadScript, buildDocsScanScript, parseDocsRead, parseDocsScan } from '@termhub/machine-ops';
import { memoryCode } from '../chat/embeddings.js';
import { agentRpc, requireAgentVersion } from '../agent/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import type { NewMemoryItem } from '../db/repositories/memory-items.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { isLessonPath, parseLessonFile } from '../lessons/file.js';
import { runOnMachine, shellQuote } from '../terminal/machine-exec.js';
import { chunkMarkdown } from './chunk.js';
import { embedInserted, type MemoryDeps } from './index-items.js';
import { cleanMemoryText, ITEM_TEXT_MAX } from './text.js';

/** First agent release that answers `docs.scan` / `docs.read` (spec 2026-09-26 concierge memory D15). */
export const DOCS_MIN_AGENT_VERSION = '0.8.0';
/** First agent release whose `docPath` accepts `docs/lessons/*.md` (spec 2026-09-27 failure lessons):
 *  an older agent's own `@termhub/agent-protocol` still only knows `docs/superpowers/{specs,plans}`,
 *  so its params parse would fail before dispatch (the same reason `DOCS_MIN_AGENT_VERSION` exists at
 *  all) — lesson paths are only ever sent to an agent at or above this version; `docs.scan` and the
 *  specs/plans `docs.read` stay gated at `DOCS_MIN_AGENT_VERSION` as before. Bumped from 0.8.1 to 0.9.1:
 *  main released agent 0.9.0 first for the `secret.read` RPC (another card), so lessons needed the
 *  next version to land after it. */
export const DOCS_LESSONS_MIN_AGENT_VERSION = '0.9.1';
/** At most this many paths per `docs.read` call (the RPC's own `max(20)`, spec §4). */
export const DOCS_READ_BATCH = 20;

/** A failure's code for the log: its own `code` (an `HttpError`'s, a Prisma one's), else a generic one. */
const failureCode = (err: unknown): string => {
  const code = memoryCode(err);
  return code === 'SUGGEST_FAILED' ? 'DOCS_FAILED' : code;
};

/** Same budgets as the agent RPC catalog gives `docs.scan` / `docs.read` (15 s / 20 s). */
const SCAN_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 20_000;

/**
 * How the docs sweeper reaches a machine's checkout: both calls return the raw stdout of the
 * `@termhub/machine-ops` docs scripts, which `parseDocsScan` / `parseDocsRead` read back. A failure
 * (offline, unreachable, outdated agent, timeout) throws — ideally an `HttpError` with a `code`, which
 * is all the caller ever logs.
 */
export interface DocsExec {
  scan(machine: Machine, cwd: string): Promise<string>;
  read(machine: Machine, cwd: string, paths: string[]): Promise<string>;
  /** Same RPC/script as `read`, for `docs/lessons/*.md` paths only — kept a separate method so an agent
   *  too old for lessons (`DOCS_LESSONS_MIN_AGENT_VERSION`) is only ever asked through here, and so its
   *  failure never touches the specs/plans call (spec 2026-09-27 failure lessons §4). */
  readLessons(machine: Machine, cwd: string, paths: string[]): Promise<string>;
}

async function runDocsScript(machine: Machine, script: string, timeoutMs: number): Promise<string> {
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, timeoutMs);
  if (r.timedOut) throw new HttpError(504, 'A máquina demorou para responder', 'MACHINE_TIMEOUT');
  if (r.code !== 0) throw new HttpError(502, 'Máquina inacessível', 'MACHINE_UNREACHABLE');
  return r.stdout;
}

/**
 * The real `DocsExec`: an `agent` machine has no shell from the server (`runOnMachine` refuses it), so
 * it goes through the `docs.scan` / `docs.read` RPCs — after `requireAgentVersion`, since an agent
 * older than 0.8.0 does not know those methods and *drops* the frame (its `serverMessage` parse fails
 * before dispatch), which would otherwise cost a full RPC timeout per link every pass instead of an
 * immediate `AGENT_OUTDATED`. An offline agent surfaces as `AGENT_OFFLINE` from `agentRpc`. An
 * `ssh`/`local` machine runs the very same script through `runOnMachine`, with the cwd and every path
 * `shellQuote`d — and those paths only ever come from a validated scan (`DOC_PATH_RE`).
 */
/** `docs.read` over the agent RPC, version-gated by `minVersion` — `DOCS_MIN_AGENT_VERSION` for
 *  specs/plans, `DOCS_LESSONS_MIN_AGENT_VERSION` for lessons (see `DocsExec.readLessons`). */
async function agentRead(machine: Machine, cwd: string, paths: string[], minVersion: string): Promise<string> {
  requireAgentVersion(machine, minVersion);
  return (await agentRpc(machine, 'docs.read', { cwd, paths })).stdout;
}

export const machineDocsExec: DocsExec = {
  async scan(machine, cwd) {
    if (machine.type === 'agent') {
      requireAgentVersion(machine, DOCS_MIN_AGENT_VERSION);
      return (await agentRpc(machine, 'docs.scan', { cwd })).stdout;
    }
    return runDocsScript(machine, buildDocsScanScript(shellQuote(cwd)), SCAN_TIMEOUT_MS);
  },
  async read(machine, cwd, paths) {
    if (machine.type === 'agent') return agentRead(machine, cwd, paths, DOCS_MIN_AGENT_VERSION);
    return runDocsScript(machine, buildDocsReadScript(shellQuote(cwd), paths.map(shellQuote)), READ_TIMEOUT_MS);
  },
  async readLessons(machine, cwd, paths) {
    if (machine.type === 'agent') return agentRead(machine, cwd, paths, DOCS_LESSONS_MIN_AGENT_VERSION);
    return runDocsScript(machine, buildDocsReadScript(shellQuote(cwd), paths.map(shellQuote)), READ_TIMEOUT_MS);
  },
};

/**
 * Whether this machine's `docs.scan` can list `docs/lessons` at all (final review fix): the scan
 * script ships inside the agent, so an agent below `DOCS_LESSONS_MIN_AGENT_VERSION` scans only
 * specs/plans — its empty lessons listing means "not looked at", never "deleted". An `ssh`/`local`
 * machine runs the server's own, current script and always can.
 */
function scanListsLessons(machine: Machine): boolean {
  if (machine.type !== 'agent') return true;
  try {
    requireAgentVersion(machine, DOCS_LESSONS_MIN_AGENT_VERSION);
    return true;
  } catch {
    return false;
  }
}

/** One project ↔ machine link as the docs pass sees it: `owner_id` is the project's owner. */
export interface DocsLink {
  id: string;
  project_id: string;
  owner_id: string;
  cwd: string;
  machine: Machine;
}

/** Reads every path in `paths` in batches of ≤ `DOCS_READ_BATCH`, through `read` (either
 *  `exec.read` for specs/plans or `exec.readLessons` for lessons — see `indexDocsForLink`). `docs.read`
 *  returns a *prefix* of what it was asked for (it stops before the file that would cross its byte
 *  budget) and silently skips a file that vanished or grew past the size limit since the scan: so
 *  after each call the queue resumes right after the last path that came back — a path skipped before
 *  it is dropped (it will be looked at again on the next pass) — and a call that returns none of its
 *  batch drops that whole batch. Every call removes at least one path, so this always ends. Throws on
 *  the first failed call; nothing is written by then. */
async function readAll(read: (paths: string[]) => Promise<string>, paths: string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  let queue = paths;
  while (queue.length > 0) {
    const batch = queue.slice(0, DOCS_READ_BATCH);
    const got = parseDocsRead(await read(batch));
    let last = -1;
    batch.forEach((p, i) => {
      const text = got.get(p);
      if (text === undefined) return;
      texts.set(p, text);
      last = i;
    });
    queue = queue.slice(last === -1 ? batch.length : last + 1);
  }
  return texts;
}

/**
 * Indexes one link's `docs/superpowers/{specs,plans}/*.md` and `docs/lessons/*.md` into `memory_items`
 * (spec 2026-09-26 concierge memory D15, §4; lessons: spec 2026-09-27 failure lessons §4): `docs.scan`
 * lists every such file's sha256 in one call; a file whose sha differs from the `source_hash` its
 * chunk 0 already carries (or that has no item yet) is read and re-chunked. A specs/plans file is
 * upserted as `kind: 'doc'`, trust `derived`, chunked by `chunkMarkdown`; a `docs/lessons/*.md` file
 * (`isLessonPath`, never `docs/lessons/README.md` — the scan itself never lists it) is upserted as
 * `kind: 'lesson'`, trust `derived`, `parseLessonFile`'s chunks and meta. Both share `source_id`
 * `${link.id}:${path}`, every chunk carrying the file's sha, through `replaceSourceChunks`, which trims
 * the chunks past the new count and upserts in one transaction, so a crash never leaves a stale tail
 * behind a fresh chunk 0. An unchanged file is never read. A stored file that the scan no longer lists
 * has all its items deleted. So does one the scan reports **over `DOCS_MAX_BYTES`** (sha `null`): it
 * still exists, but its content can no longer be read or verified, so its old chunks would be stale
 * text nobody can refresh.
 *
 * The two kinds are read in **separate** `docs.read` calls (`exec.read` for specs/plans, kept exactly
 * as TER-95 left it; `exec.readLessons` for lessons, version-gated at `DOCS_LESSONS_MIN_AGENT_VERSION`
 * instead of `DOCS_MIN_AGENT_VERSION`) so a failure reading one never touches the other: an agent old
 * enough for specs/plans but not yet for lessons still gets its specs/plans re-indexed every pass,
 * with its lesson chunks simply left untouched (never deleted) until it updates — including by the
 * "gone" pass: such an agent's scan never lists `docs/lessons` (`scanListsLessons`), so its lessons
 * are not deleted for being absent from it.
 *
 * A file that chunks to nothing (empty or whitespace only) ends up with no items at all, so it has no
 * stored hash and is simply read again on the next pass — cheap, and rare.
 *
 * A failure to reach the checkout at the scan step — offline agent (`AGENT_OFFLINE`), agent older than
 * 0.8.0 (`AGENT_OUTDATED`), unreachable ssh, a timeout, a missing cwd (`DOCS_NOTFOUND`), no sha256 tool
 * on the machine (`DOCS_NOHASH`) — returns `{ read: 0, removed: 0 }` with a single `{ linkId, code }`
 * log and **writes and deletes nothing at all**: a machine that is merely off must never wipe what was
 * indexed from it. So does a scan that succeeds with no file at all while the link has docs or lessons
 * stored (`DOCS_EMPTY`, see below). A failure reading just one of the two batches is logged the same
 * way but only skips writing/deleting *that* batch's kind — the other still runs to completion.
 * Repository failures propagate to the caller (the sweeper logs them per link). Logs never carry a
 * path, a title or text — the link id, counts and codes only. `deps.exec` defaults to
 * `machineDocsExec`. Returns how many files were (re-)indexed and how many files' items were removed,
 * across both kinds.
 */
export async function indexDocsForLink(
  repos: Pick<Repositories, 'memoryItems'>,
  link: DocsLink,
  deps: MemoryDeps & { exec?: DocsExec },
): Promise<{ read: number; removed: number }> {
  const exec = deps.exec ?? machineDocsExec;
  const skip = (code: string) => {
    deps.log.info({ linkId: link.id, code }, 'memory docs skipped for a link');
    return { read: 0, removed: 0 };
  };

  let scan: ReturnType<typeof parseDocsScan>;
  try {
    scan = parseDocsScan(await exec.scan(link.machine, link.cwd));
  } catch (err) {
    return skip(failureCode(err));
  }
  if (scan.err !== null) return skip(`DOCS_${scan.err.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 20)}`);

  const prefix = `${link.id}:`;
  const [known, linkLessons] = await Promise.all([repos.memoryItems.listSourceHashes('doc', prefix), repos.memoryItems.listSourceHashes('lesson', prefix)]);
  // Only `docs/lessons/*.md` lessons are this pass's: the link's ai-memory lessons (TER-1021) share its
  // prefix but belong to `indexAiMemoryForLink`, and must never be "gone" from a docs scan.
  const knownLessons = new Map([...linkLessons].filter(([sourceId]) => sourceId.startsWith(`${prefix}docs/`)));
  // A scan that succeeds but lists nothing while this link has docs/lessons stored is far more likely a
  // transient state (an unmounted disk, a branch switch mid-checkout) than every spec being deleted at
  // once: keep everything this pass (fix round 1 ruling). A non-empty scan deletes gone files as usual.
  if (scan.entries.length === 0 && (known.size > 0 || knownLessons.size > 0)) return skip('DOCS_EMPTY');

  const readable = new Map<string, string>(); // path → sha, only files that can still be read
  for (const e of scan.entries) if (e.sha256 !== null) readable.set(e.path, e.sha256);
  const readableDocs = new Map([...readable].filter(([path]) => !isLessonPath(path)));
  const readableLessons = new Map([...readable].filter(([path]) => isLessonPath(path)));
  const changed = [...readableDocs].filter(([path, sha]) => known.get(prefix + path) !== sha).map(([path]) => path);
  const changedLessons = [...readableLessons].filter(([path, sha]) => knownLessons.get(prefix + path) !== sha).map(([path]) => path);

  let texts = new Map<string, string>();
  let docsFailed = false;
  if (changed.length > 0) {
    try {
      texts = await readAll((batch) => exec.read(link.machine, link.cwd, batch), changed);
    } catch (err) {
      deps.log.info({ linkId: link.id, code: failureCode(err) }, 'memory docs skipped for a link');
      docsFailed = true;
    }
  }

  let lessonTexts = new Map<string, string>();
  let lessonsFailed = false;
  if (changedLessons.length > 0) {
    try {
      lessonTexts = await readAll((batch) => exec.readLessons(link.machine, link.cwd, batch), changedLessons);
    } catch (err) {
      deps.log.info({ linkId: link.id, code: failureCode(err) }, 'memory docs skipped for a link');
      lessonsFailed = true;
    }
  }

  const now = new Date();
  for (const [path, text] of texts) {
    const sourceId = prefix + path;
    const chunks = chunkMarkdown(path, text);
    const items: NewMemoryItem[] = chunks.map((c, i) => ({
      // The project's owner at listing time. `ProjectsRepository` has no owner transfer today; if one is
      // ever added, doc items must be re-owned there too — an unchanged file (same hash) is never
      // re-upserted here, so its chunks would keep the old owner.
      owner_id: link.owner_id,
      project_id: link.project_id,
      kind: 'doc',
      source_id: sourceId,
      chunk_index: i,
      title: cleanMemoryText(c.title),
      text: cleanMemoryText(c.text).slice(0, ITEM_TEXT_MAX),
      trust: 'derived',
      source_at: now,
      source_hash: readableDocs.get(path)!,
    }));
    const inserted = await repos.memoryItems.replaceSourceChunks('doc', sourceId, items);
    if (deps.embedder) void embedInserted(repos, deps.embedder, inserted, deps.log);
  }

  for (const [path, text] of lessonTexts) {
    const sourceId = prefix + path;
    const parsed = parseLessonFile(path, text);
    const items: NewMemoryItem[] = parsed.chunks.map((c, i) => ({
      owner_id: link.owner_id,
      project_id: link.project_id,
      kind: 'lesson',
      source_id: sourceId,
      chunk_index: i,
      // Every chunk of a lesson file shares its one title (the symptom, or the path when there is
      // none) — unlike a doc, where each chunk's own heading is the title.
      title: cleanMemoryText(parsed.title),
      text: cleanMemoryText(c.text).slice(0, ITEM_TEXT_MAX),
      trust: 'derived',
      source_at: now,
      source_hash: readableLessons.get(path)!,
      meta: parsed.meta,
    }));
    const inserted = await repos.memoryItems.replaceSourceChunks('lesson', sourceId, items);
    if (deps.embedder) void embedInserted(repos, deps.embedder, inserted, deps.log);
  }

  let removed = 0;
  if (!docsFailed) {
    const gone = [...known.keys()].filter((sourceId) => !readableDocs.has(sourceId.slice(prefix.length)));
    if (gone.length > 0) {
      await repos.memoryItems.deleteBySource('doc', gone);
      removed += gone.length;
    }
  }
  // An agent too old to list lessons (a downgrade, or one that never updated) must not wipe them.
  if (!lessonsFailed && scanListsLessons(link.machine)) {
    const goneLessons = [...knownLessons.keys()].filter((sourceId) => !readableLessons.has(sourceId.slice(prefix.length)));
    if (goneLessons.length > 0) {
      await repos.memoryItems.deleteBySource('lesson', goneLessons);
      removed += goneLessons.length;
    }
  }

  return { read: texts.size + lessonTexts.size, removed };
}
