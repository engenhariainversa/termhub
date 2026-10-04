import type { Task, TaskStatus, Ticket } from '../db/repositories/types.js';
import { getProvider, type IntegrationProvider } from '../integrations/index.js';
import { providerIdOf, readTicketLink, ticketLinkJson } from '../integrations/ticket-link.js';
import { HttpError } from '../lib/errors.js';
import { sourceIdentity } from '../setup/schema.js';
import { lastSync, syncProjectTickets, type SyncResult } from '../setup/tickets-sync.js';
import type { ControlContext } from './context.js';
import { cardUrl, taskOut, type TaskOut } from './tasks.js';

// Same rule as inventory's normalizeName, kept local: inventory imports this module (find → resolveTickets).
const normalizeName = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

export const TICKET_LIST_DEFAULT = 50;
export const TICKET_LIST_MAX = 200;
export const TICKET_IMPORT_MAX = 200;
export const TICKET_DESCRIPTION_CUT = 500;
export const SYNC_THROTTLE_MS = 60_000;

/** A ticket as the tools return it: no raw meta, no sync_key. */
export interface TicketOut {
  id: string;
  key: string;
  title: string;
  description: string | null;
  state: string;
  status: TaskStatus;
  url: string;
  source: { provider: IntegrationProvider; scope: string | null };
  priority: unknown;
  labels: string[];
  assignee: string | null;
  synced_at: string;
  /** set when the source no longer returns this imported ticket (closed, or out of the filter) */
  left_source_at: string | null;
  card: { id: string; ref: string; url: string } | null;
}

const cut = (s: string | null, full: boolean) => (s && !full && s.length > TICKET_DESCRIPTION_CUT ? `${s.slice(0, TICKET_DESCRIPTION_CUT)}…` : s);

function toOut(t: Ticket, card: Task | undefined, full: boolean): TicketOut {
  const labels = Array.isArray(t.meta.labels) ? t.meta.labels.filter((l): l is string => typeof l === 'string') : [];
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    description: cut(t.description, full),
    state: t.state,
    status: t.status,
    url: t.url,
    source: { provider: t.provider, scope: t.scope },
    priority: t.meta.priority ?? null,
    labels,
    assignee: typeof t.meta.assignee === 'string' ? t.meta.assignee : null,
    synced_at: t.synced_at,
    left_source_at: t.left_source_at,
    card: card ? { id: card.id, ref: card.ref, url: cardUrl(card.ref) } : null,
  };
}

/** The cards of these tickets (imported ones), by task id. */
export async function cardsOf(ctx: ControlContext, tickets: Ticket[]): Promise<Map<string, Task>> {
  const ids = tickets.map((t) => t.task_id).filter((v): v is string => v !== null);
  return new Map((await ctx.repos.tasks.findByIds(ids)).map((t) => [t.id, t]));
}

export async function listTickets(
  ctx: ControlContext,
  input: { project_id: string; source?: string; status?: TaskStatus; imported?: boolean; query?: string; limit?: number },
) {
  await ctx.scoped.project(input.project_id);
  const q = input.query ? normalizeName(input.query) : '';
  const all = (await ctx.repos.tickets.listByProject(input.project_id)).filter(
    (t) =>
      (!input.source || t.scope === input.source.trim()) &&
      (!input.status || t.status === input.status) &&
      (input.imported === undefined || (t.task_id !== null) === input.imported) &&
      (!q || normalizeName(t.key).includes(q) || normalizeName(t.title).includes(q)),
  );
  const page = all.slice(0, Math.min(input.limit ?? TICKET_LIST_DEFAULT, TICKET_LIST_MAX));
  const cards = await cardsOf(ctx, page);
  const last = lastSync(input.project_id);
  return {
    tickets: page.map((t) => toOut(t, t.task_id ? cards.get(t.task_id) : undefined, false)),
    total: all.length,
    last_sync: last
      ? { at: last.synced_at, sources: last.sources.map((s) => ({ provider: s.provider, scope: s.scope, truncated: s.truncated ?? false, error: s.error ?? null })) }
      : null,
  };
}

// No owner part: "wrongowner/api#12" must resolve only by exact match, never fall back to a suffix search.
const GITHUB_SHORT = /^([\w.-]+)?#(\d+)$/;

/**
 * Tickets a typed key names. Exact key or URL anywhere in `projectIds`. `allowShort` also accepts
 * `repo#12` and `#12` (GitHub) when there is exactly one project — the spec allows those only when
 * the caller named a `project_id` explicitly (import) or resolved to one project through it (get).
 * Callers decide what several matches mean.
 */
export async function resolveTickets(ctx: ControlContext, key: string, projectIds: string[], allowShort: boolean): Promise<Ticket[]> {
  const k = key.trim();
  if (/^https?:\/\//i.test(k)) return ctx.repos.tickets.findByKeyish(projectIds, { url: k.replace(/\/$/, '') });
  const exact = await ctx.repos.tickets.findByKeyish(projectIds, { key: k });
  if (exact.length > 0 || !allowShort || projectIds.length !== 1) return exact;
  const m = GITHUB_SHORT.exec(k);
  if (!m) return [];
  return ctx.repos.tickets.findByKeyish(projectIds, { suffix: m[1] ? `/${m[1]}#${m[2]}` : `#${m[2]}` });
}

function one(key: string, found: Ticket[], projectNames: Map<string, string>): Ticket {
  if (found.length === 0) throw new HttpError(404, `Ticket ${key} não encontrado. Rode sync_tickets se ele for novo.`, 'TICKET_NOT_FOUND');
  if (found.length > 1) {
    const multiProject = new Set(found.map((t) => t.project_id)).size > 1;
    const names = found.map((t) => (multiProject ? `${projectNames.get(t.project_id) ?? t.project_id} / ${t.key}` : t.key)).join(', ');
    throw new HttpError(409, `${key} é ambíguo: ${names}. Use a chave completa.`, 'TICKET_AMBIGUOUS');
  }
  return found[0];
}

export async function getTicket(ctx: ControlContext, input: { key: string; project_id?: string }) {
  const projects = input.project_id ? [(await ctx.scoped.project(input.project_id)).project] : await ctx.repos.projects.list({ owner: ctx.scope.ownerId });
  const found = await resolveTickets(ctx, input.key, projects.map((p) => p.id), input.project_id !== undefined);
  const t = one(input.key, found, new Map(projects.map((p) => [p.id, p.name])));
  const cards = await cardsOf(ctx, [t]);
  return { ticket: toOut(t, t.task_id ? cards.get(t.task_id) : undefined, true), project_id: t.project_id };
}

async function sourcesOf(ctx: ControlContext, projectId: string) {
  const sources = (await ctx.repos.projectSetup.get(projectId)).data.ticket_sources;
  if (sources.length === 0) throw new HttpError(400, 'Configure uma fonte de tickets no setup do projeto', 'NO_TICKET_SOURCE');
  return sources;
}

export async function syncTickets(ctx: ControlContext, input: { project_id: string }, now = Date.now()): Promise<SyncResult & { cached: boolean }> {
  await ctx.scoped.project(input.project_id);
  const sources = await sourcesOf(ctx, input.project_id);
  const last = lastSync(input.project_id);
  // The scheduler records single sources: reuse only a result that covers every source of the setup.
  const covered = new Set(last?.sources.map(sourceIdentity) ?? []);
  if (last && now - Date.parse(last.synced_at) < SYNC_THROTTLE_MS && sources.every((s) => covered.has(sourceIdentity(s)))) return { ...last, cached: true };
  return { ...(await syncProjectTickets(ctx.repos, input.project_id, sources)), cached: false };
}

export async function importTickets(ctx: ControlContext, input: { project_id: string; keys?: string[]; ticket_ids?: string[] }) {
  const { project } = await ctx.scoped.project(input.project_id);
  if (!input.keys === !input.ticket_ids) throw new HttpError(400, 'Informe keys ou ticket_ids (um dos dois)', 'BAD_REQUEST');
  const names = new Map([[project.id, project.name]]);
  let resolved: Ticket[];
  if (input.ticket_ids) resolved = await ctx.repos.tickets.findByIds(project.id, input.ticket_ids.slice(0, TICKET_IMPORT_MAX));
  else {
    // one after the other: up to 200 keys must not become 200 concurrent queries
    resolved = [];
    for (const k of input.keys!.slice(0, TICKET_IMPORT_MAX)) resolved.push(one(k, await resolveTickets(ctx, k, [project.id], true), names));
  }
  // Two keys (case, short vs. full form) or two ids can name the same ticket: keep the first occurrence,
  // or the second createFromTicket would hit the unique (project_id, external_key) constraint.
  const seen = new Set<string>();
  const picked = resolved.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  const existing = await cardsOf(ctx, picked);
  const cards: { ticket_key: string; card: TaskOut; task: Task; created: boolean }[] = [];
  for (const t of picked) {
    const old = t.task_id ? existing.get(t.task_id) : undefined;
    if (old) {
      cards.push({ ticket_key: t.key, card: taskOut(old), task: old, created: false });
      continue;
    }
    const link = ticketLinkJson(
      { provider: t.provider, provider_id: providerIdOf(t), key: t.key, url: t.url, state: t.state, status: t.status, updated_at: String(t.meta.updated_at ?? ''), meta: t.meta },
      { integration_id: t.integration_id, scope: t.scope ?? String(t.meta.scope ?? '') },
    );
    const task = await ctx.repos.tasks.createFromTicket(project.id, { key: t.sync_key, title: t.title, description: t.description, ref: link, ticketId: t.id });
    cards.push({ ticket_key: t.key, card: taskOut(task), task, created: true });
  }
  return { cards };
}

/** The provider API id from the sync key: "linear:<uuid>", "jira:<KEY>", "github:<owner/repo>#<n>". */
export async function pushTicketStatus(ctx: ControlContext, input: { task_id: string }) {
  const { task } = await ctx.scoped.task(input.task_id);
  const link = readTicketLink(task.external_ref);
  if (!link) throw new HttpError(400, 'Este card não está ligado a um ticket externo', 'NOT_LINKED');
  const sources = (await ctx.repos.projectSetup.get(task.project_id)).data.ticket_sources;
  const source =
    sources.find((s) => link.integration_id !== null && s.integration_id === link.integration_id && s.scope === link.scope) ??
    sources.find((s) => s.provider === link.provider && s.scope === link.scope);
  if (!source) throw new HttpError(400, `A fonte de ${link.key} não está mais no setup do projeto`, 'SOURCE_NOT_FOUND');
  const integration = await ctx.scoped.integration(source.integration_id);
  const secret = await ctx.repos.integrations.getSecret(source.integration_id);
  if (!secret) throw new HttpError(400, 'Integração sem credencial', 'SOURCE_NOT_FOUND');
  let state: string;
  try {
    state = await getProvider(link.provider).updateStatus(secret, integration.config, { provider_id: link.provider_id, key: link.key, scope: source.scope }, task.status);
  } catch (e) {
    throw new HttpError(502, (e as Error).message, 'PROVIDER_ERROR');
  }
  const next = { ...(task.external_ref as object), state, status: task.status, integration_id: source.integration_id, pushed_at: new Date().toISOString() };
  await ctx.repos.tasks.setExternalRef(task.id, next);
  const updated = { ...task, external_ref: next };
  return { card: taskOut(updated), task: updated, ticket_key: link.key, state };
}
