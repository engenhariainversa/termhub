import { buildAiMemoryPagesScript, parseAiMemoryPages } from '@termhub/machine-ops';
import { memoryCode } from '../chat/embeddings.js';
import { agentRpc, requireAgentVersion } from '../agent/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import type { NewMemoryItem } from '../db/repositories/memory-items.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { splitFrontMatter } from '../lessons/file.js';
import { containsSecret } from '../lessons/secrets.js';
import { runOnMachine, shellQuote } from '../terminal/machine-exec.js';
import { chunkMarkdown, type Chunk } from './chunk.js';
import type { DocsLink } from './docs.js';
import { embedInserted, type MemoryDeps } from './index-items.js';
import { cleanMemoryText, ITEM_TEXT_MAX } from './text.js';

/**
 * Deliberate ai-memory pages as unverified lessons (TER-1021, spike TER-1008,
 * `docs/spikes/2026-10-07-ai-memory-spike.md`). A project that opted in (`projects.ai_memory_lessons`)
 * has, on every docs pass, each of its checkouts asked for the `_rules/`, `gotchas/` and `decisions/`
 * pages of its ai-memory project — what an agent or a person wrote there on purpose. They become
 * `lesson` items, trust `derived`, never verified until the person verifies them on the Memória
 * screen. Sessions, observations and handoffs (which hold tool and terminal output) are never read:
 * the machine-side script only walks those three directories, `parseAiMemoryPages` drops any other
 * path, and `parseAiMemoryPage` drops a page that carries session provenance.
 */

/** First agent release that answers `aimemory.pages`. */
export const AI_MEMORY_MIN_AGENT_VERSION = '0.22.0';

/** The `source_id` of an ai-memory lesson: `<link id>:ai-memory/<path in the wiki>`. Under the link
 *  id like a file lesson, so `deleteDocsNotInLinks` drops it with its link. */
export const aiMemorySourcePrefix = (linkId: string): string => `${linkId}:ai-memory/`;

export type AiMemoryKind = 'rule' | 'gotcha' | 'decision';

const FAMILY_KIND: Record<string, AiMemoryKind> = { _rules: 'rule', gotchas: 'gotcha', decisions: 'decision' };
const KINDS = new Set<string>(['rule', 'gotcha', 'decision']);
const TITLE_MAX = 300;

export interface ParsedAiMemoryPage {
  kind: AiMemoryKind;
  title: string;
  chunks: Chunk[];
}

/**
 * One page's lesson, or null when it must not be imported:
 * - its front matter `kind` is set to anything but `rule`/`gotcha`/`decision` (no `kind`: the
 *   directory decides);
 * - it carries session provenance (`session_id`) or was consolidated from sessions
 *   (`consolidated: true`) — that text came from captured tool/terminal output, not from a deliberate
 *   write;
 * - it has no body, or its title or body looks like a token or private key (`containsSecret`).
 * Title: front matter `title`, else the body's first `# ` heading, else the file name.
 */
export function parseAiMemoryPage(path: string, md: string): ParsedAiMemoryPage | null {
  const segments = path.split('/');
  const familyKind = FAMILY_KIND[segments[segments.length - 2] ?? ''];
  if (!familyKind) return null;
  const { frontMatter: fm, body } = splitFrontMatter(md);
  const rawKind = typeof fm.kind === 'string' ? fm.kind.trim().toLowerCase() : '';
  if (rawKind !== '' && !KINDS.has(rawKind)) return null;
  if (fm.session_id !== undefined) return null;
  if (typeof fm.consolidated === 'string' && fm.consolidated.trim().toLowerCase() === 'true') return null;
  if (body.trim() === '') return null;

  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const fileName = (segments[segments.length - 1] ?? path).replace(/\.md$/, '');
  const rawTitle = typeof fm.title === 'string' && fm.title.trim() !== '' ? fm.title.trim() : (heading ?? fileName);
  const title = cleanMemoryText(rawTitle).slice(0, TITLE_MAX);
  if (containsSecret([title, body])) return null;
  const chunks = chunkMarkdown(path, body).filter((c) => c.text.trim() !== '');
  if (chunks.length === 0) return null;
  return { kind: (rawKind || familyKind) as AiMemoryKind, title, chunks };
}

/** How the sweeper reaches a checkout's ai-memory pages: the raw stdout of the machine-ops script. */
export interface AiMemoryExec {
  pages(machine: Machine, cwd: string): Promise<string>;
}

const PAGES_TIMEOUT_MS = 20_000;

/** The real one: the `aimemory.pages` RPC on an agent machine (version-gated, like `docs.scan`), the
 *  same script through `runOnMachine` on an ssh/local one, the cwd `shellQuote`d. */
export const machineAiMemoryExec: AiMemoryExec = {
  async pages(machine, cwd) {
    if (machine.type === 'agent') {
      requireAgentVersion(machine, AI_MEMORY_MIN_AGENT_VERSION);
      return (await agentRpc(machine, 'aimemory.pages', { cwd })).stdout;
    }
    const script = buildAiMemoryPagesScript(shellQuote(cwd));
    const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, PAGES_TIMEOUT_MS);
    if (r.timedOut) throw new HttpError(504, 'A máquina demorou para responder', 'MACHINE_TIMEOUT');
    if (r.code !== 0) throw new HttpError(502, 'Máquina inacessível', 'MACHINE_UNREACHABLE');
    return r.stdout;
  },
};

/**
 * Imports one link's deliberate ai-memory pages (see the module comment). A page whose sha256 equals
 * the `source_hash` already stored is left alone; a new or changed one replaces its chunks (a changed
 * page drops its verification and a hidden one comes back, both keyed on `source_hash`); a stored page
 * that is no longer listed, or that `parseAiMemoryPage` now refuses, is deleted. Any failure to reach
 * the machine, or an `ERR:` from the script (no ai-memory wiki on that machine, a missing checkout),
 * writes and deletes nothing. Logs carry the link id, counts and codes only, never a path or text.
 */
export async function indexAiMemoryForLink(
  repos: Pick<Repositories, 'memoryItems'>,
  link: DocsLink,
  deps: MemoryDeps & { exec?: AiMemoryExec },
): Promise<{ read: number; removed: number }> {
  const exec = deps.exec ?? machineAiMemoryExec;
  const skip = (code: string) => {
    deps.log.info({ linkId: link.id, code }, 'ai-memory lessons skipped for a link');
    return { read: 0, removed: 0 };
  };

  let result: ReturnType<typeof parseAiMemoryPages>;
  try {
    result = parseAiMemoryPages(await exec.pages(link.machine, link.cwd));
  } catch (err) {
    const code = memoryCode(err);
    return skip(code === 'SUGGEST_FAILED' ? 'AIMEM_FAILED' : code);
  }
  if (result.err !== null) return skip(`AIMEM_${result.err.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 20)}`);

  const prefix = aiMemorySourcePrefix(link.id);
  const known = await repos.memoryItems.listSourceHashes('lesson', prefix);
  const keep = new Set<string>();
  const now = new Date();
  let read = 0;
  for (const page of result.pages) {
    const sourceId = prefix + page.path;
    const parsed = parseAiMemoryPage(page.path, page.text);
    if (!parsed) continue;
    keep.add(sourceId);
    if (known.get(sourceId) === page.sha256) continue;
    const items: NewMemoryItem[] = parsed.chunks.map((c, i) => ({
      owner_id: link.owner_id,
      project_id: link.project_id,
      kind: 'lesson',
      source_id: sourceId,
      chunk_index: i,
      title: parsed.title,
      text: cleanMemoryText(c.text).slice(0, ITEM_TEXT_MAX),
      trust: 'derived',
      source_at: now,
      source_hash: page.sha256,
      meta: {
        evidence: 'observed',
        card: null,
        pr: null,
        tags: [parsed.kind],
        agent: null,
        tab_id: null,
        origin: 'ai-memory',
        path: page.path.slice(0, 300),
        machine_id: link.machine.id,
        machine_name: link.machine.name.slice(0, 300),
        ai_memory_kind: parsed.kind,
      },
    }));
    const inserted = await repos.memoryItems.replaceSourceChunks('lesson', sourceId, items);
    if (deps.embedder) void embedInserted(repos, deps.embedder, inserted, deps.log);
    read++;
  }

  const gone = [...known.keys()].filter((sourceId) => !keep.has(sourceId));
  if (gone.length > 0) await repos.memoryItems.deleteBySource('lesson', gone);
  return { read, removed: gone.length };
}

/** The project turned the option off (or never had it): its ai-memory lessons from this link go. */
export async function removeAiMemoryLessonsForLink(repos: Pick<Repositories, 'memoryItems'>, linkId: string): Promise<number> {
  const known = await repos.memoryItems.listSourceHashes('lesson', aiMemorySourcePrefix(linkId));
  if (known.size === 0) return 0;
  return repos.memoryItems.deleteBySource('lesson', [...known.keys()]);
}

/**
 * Right after the person turns the option on (the projects PATCH): imports every link of the project
 * at once instead of waiting up to 30 minutes for the next docs pass. Best effort — never throws; a
 * failure is logged like the sweeper's and the next pass tries again.
 */
export async function importAiMemoryForProject(
  repos: Pick<Repositories, 'memoryItems' | 'projectMachines'>,
  projectId: string,
  deps: MemoryDeps & { exec?: AiMemoryExec },
): Promise<void> {
  try {
    const links = (await repos.projectMachines.listAllWithOwner()).filter((l) => l.project_id === projectId);
    for (const link of links) await indexAiMemoryForLink(repos, link, deps);
  } catch (err) {
    deps.log.warn({ projectId, code: memoryCode(err) }, 'ai-memory lessons failed for a project');
  }
}
