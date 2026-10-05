import path from 'node:path';
import { CAPABILITY_FILE_READ, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import type { TFilePreviewQuery, TFilePreviewResponse } from '@termhub/mobile-api';
import { agentRpc, FILE_READ_OUTDATED_MESSAGE } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import type { Scoped } from '../auth/scope.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError, badRequest } from '../lib/errors.js';

/**
 * A text file previewed from a path an answer named (spec 2026-10-04 file preview §4). Which machine holds
 * it is not in the answer, so the candidates are tried in order and the first that has the file wins
 * (D9). The body is relayed and never stored or logged.
 */

export type AgentView = Pick<typeof agents, 'isOnline' | 'capabilities'>;
export type FileRpc = (machine: Machine, params: RpcParams<'file.read'>) => Promise<RpcResult<'file.read'>>;

const defaultRpc: FileRpc = (machine, params) => agentRpc(machine, 'file.read', params);

export interface Candidate {
  machine: Machine;
  /** the project folder on this machine; null outside a project */
  cwd: string | null;
}

export interface PreviewDeps {
  agent?: AgentView;
  rpc?: FileRpc;
}

const isMachinePath = (p: string) => p.startsWith('/') || p.startsWith('~/');

/** The path to ask this machine for: as written when absolute or `~/…`, else under its project folder. */
export function pathOn(asked: string, cwd: string | null): string | null {
  if (isMachinePath(asked)) return asked;
  if (!cwd) return null;
  return path.posix.join(cwd, asked);
}

/** The file relative to the project folder, when it is inside it; null otherwise. Lexical: what was asked. */
export function relativeToProject(asked: string, cwd: string | null): string | null {
  if (!cwd) return null;
  const full = path.posix.normalize(pathOn(asked, cwd)!);
  const root = path.posix.normalize(cwd).replace(/\/+$/, '');
  if (!full.startsWith(`${root}/`)) return null;
  const rel = full.slice(root.length + 1);
  return rel === '' || rel.split('/').includes('..') ? null : rel;
}

/** `https://github.com/<owner/repo>/blob/<branch>/<path>`, each segment encoded; null without both. */
export function githubUrl(fullName: string | null | undefined, branch: string | null | undefined, rel: string | null): string | null {
  if (!fullName || !rel) return null;
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${enc(fullName)}/blob/${enc(branch || 'main')}/${enc(rel)}`;
}

/** Which machines to ask, from the query's context (D9). */
export async function candidatesFor(
  scoped: Scoped,
  repos: Pick<Repositories, 'machines'>,
  q: TFilePreviewQuery,
): Promise<{ projectId: string | null; candidates: Candidate[] }> {
  if (q.tab_id) {
    const { tab, machine, cwd } = await scoped.tab(q.tab_id);
    return { projectId: tab.project_id, candidates: [{ machine, cwd }] };
  }
  if (q.project_id) {
    if (q.machine_id) {
      const { machine, link } = await scoped.projectMachine(q.project_id, q.machine_id);
      return { projectId: q.project_id, candidates: [{ machine, cwd: link.cwd }] };
    }
    const { machines } = await scoped.projectMachines(q.project_id);
    return { projectId: q.project_id, candidates: machines.map(({ machine, link }) => ({ machine, cwd: link.cwd })) };
  }
  if (q.machine_id) return { projectId: null, candidates: [{ machine: await scoped.machine(q.machine_id), cwd: null }] };
  const all = await repos.machines.list(scoped.scope.ownerId);
  return { projectId: null, candidates: all.filter((m) => m.type === 'agent').map((machine) => ({ machine, cwd: null })) };
}

/**
 * Asks each candidate in turn. The first body wins. Without one, the most useful answer: a refusal that
 * says why (anything but `missing`), then an old agent that may well have the file (409), then `missing`,
 * then every agent offline (503).
 */
export async function previewFile(
  repos: Pick<Repositories, 'machines' | 'projectSetup'>,
  scoped: Scoped,
  q: TFilePreviewQuery,
  deps: PreviewDeps = {},
): Promise<{ response: TFilePreviewResponse; machineId: string | null }> {
  const agent = deps.agent ?? agents;
  const rpc = deps.rpc ?? defaultRpc;
  const { projectId, candidates } = await candidatesFor(scoped, repos, q);
  if (candidates.length === 0) throw new HttpError(400, 'Nenhuma máquina com o agente do termhub para ler este arquivo', 'NO_MACHINE');
  if (!isMachinePath(q.path) && candidates.every((c) => !c.cwd)) throw badRequest('Caminho relativo: abra o arquivo a partir de um projeto');

  let refusal: { status: string; machine: Machine; size?: number } | null = null;
  let missing: Machine | null = null;
  let outdated = false;
  let offline = 0;
  let unsupported = 0;
  let failure: unknown = null;
  for (const { machine, cwd } of candidates) {
    const asked = pathOn(q.path, cwd);
    if (!asked) continue;
    if (machine.type !== 'agent') {
      unsupported++;
      continue;
    }
    if (!agent.isOnline(machine.id)) {
      offline++;
      continue;
    }
    if (!(agent.capabilities(machine.id) ?? []).includes(CAPABILITY_FILE_READ)) {
      outdated = true;
      continue;
    }
    let r: RpcResult<'file.read'>;
    try {
      r = await rpc(machine, { path: asked, roots: cwd ? [cwd] : [] });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 503) offline++;
      else failure ??= err;
      continue;
    }
    if (r.status === 'ok') {
      const rel = relativeToProject(q.path, cwd);
      const repo = rel && projectId ? (await repos.projectSetup.get(projectId)).data.repo : null;
      return {
        machineId: machine.id,
        response: {
          status: 'ok',
          machine: { id: machine.id, name: machine.name },
          project_id: projectId,
          path: r.path,
          rel_path: rel,
          name: path.posix.basename(r.path),
          size: r.size,
          mtime: new Date(r.mtime_ms).toISOString(),
          content: Buffer.from(r.content_b64, 'base64').toString('utf8'),
          github_url: githubUrl(repo?.full_name, repo?.base_branch, rel),
        },
      };
    }
    if (r.status === 'missing') missing ??= machine;
    else refusal ??= { status: r.status, machine, ...(r.size === undefined ? {} : { size: r.size }) };
  }

  const ref = (m: Machine) => ({ id: m.id, name: m.name });
  if (refusal) return { machineId: refusal.machine.id, response: { status: refusal.status, machine: ref(refusal.machine), ...(refusal.size === undefined ? {} : { size: refusal.size }) } };
  if (outdated) throw new HttpError(409, FILE_READ_OUTDATED_MESSAGE, 'AGENT_OUTDATED');
  if (missing) return { machineId: missing.id, response: { status: 'missing', machine: ref(missing) } };
  if (failure) throw failure;
  if (offline > 0) throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
  if (unsupported > 0) throw new HttpError(400, 'Esta máquina não usa o agente do termhub', 'UNSUPPORTED_MACHINE');
  throw badRequest('Caminho relativo: abra o arquivo a partir de um projeto');
}
