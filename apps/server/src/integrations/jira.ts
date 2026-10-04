import type { ConnectionInfo, ExternalTicket, TicketProvider, TicketSourceConfig } from './types.js';
import { collectPages } from './paginate.js';

/** Jira Cloud: config = { baseUrl: "https://xxx.atlassian.net", email }, secret = API token. */
function auth(config: Record<string, unknown>, token: string) {
  const email = String(config.email ?? '');
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

function base(config: Record<string, unknown>): string {
  const url = String(config.baseUrl ?? '').replace(/\/$/, '');
  if (!url.startsWith('http')) throw new Error('Jira: baseUrl inválida (ex.: https://empresa.atlassian.net)');
  return url;
}

async function jira<T>(config: Record<string, unknown>, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base(config)}${path}`, {
    ...init,
    headers: { authorization: auth(config, token), accept: 'application/json', 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

function mapCategory(key: string): ExternalTicket['status'] {
  if (key === 'indeterminate') return 'doing';
  if (key === 'done') return 'done';
  return 'backlog'; // new / undefined
}

/** kanban → statusCategory do Jira (backlog e todo caem em "new"). */
const CATEGORY: Record<string, string> = { backlog: 'new', todo: 'new', doing: 'indeterminate', done: 'done' };

/** Descrição do Jira Cloud vem em ADF; extrai o texto puro. */
function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfToText).join('');
  return n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' ? inner + '\n' : inner;
}

type Issue = { id: string; key: string; fields: { summary: string; description: unknown; updated: string; status: { name: string; statusCategory: { key: string } }; priority?: { name: string } | null; assignee?: { displayName: string } | null; labels?: string[] } };
const FIELDS = ['summary', 'description', 'updated', 'status', 'priority', 'assignee', 'labels'];

function toTicket(config: Record<string, unknown>, i: Issue): ExternalTicket {
  return {
    sync_key: `jira:${i.key}`,
    provider: 'jira',
    provider_id: i.id,
    key: i.key,
    title: i.fields.summary,
    description: i.fields.description ? adfToText(i.fields.description).trim() || null : null,
    url: `${base(config)}/browse/${i.key}`,
    state: i.fields.status.name,
    status: mapCategory(i.fields.status.statusCategory.key),
    updatedAt: i.fields.updated,
    meta: { priority: i.fields.priority?.name ?? null, assignee: i.fields.assignee?.displayName ?? null, labels: i.fields.labels ?? [] },
  };
}

export const jiraProvider: TicketProvider = {
  provider: 'jira',

  async testConnection(secret, config): Promise<ConnectionInfo> {
    try {
      const me = await jira<{ emailAddress?: string; displayName: string }>(config, secret, '/rest/api/3/myself');
      const projects = await jira<{ values: { key: string; name: string }[] }>(config, secret, '/rest/api/3/project/search?maxResults=100');
      return {
        ok: true,
        account: me.emailAddress ?? me.displayName,
        options: { projects: projects.values.map((p) => ({ id: p.key, name: `${p.name} (${p.key})` })) },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async listTickets(secret, config, source: TicketSourceConfig) {
    const parts = [`project = "${source.scope}"`, 'statusCategory != Done'];
    if (source.filter) parts.push(`(${source.filter})`);
    const jql = parts.join(' AND ') + ' ORDER BY updated DESC';
    const { items, truncated } = await collectPages<Issue, string>(async (token) => {
      const data = await jira<{ issues: Issue[]; nextPageToken?: string; isLast?: boolean }>(config, secret, '/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({ jql, maxResults: 100, ...(token ? { nextPageToken: token } : {}), fields: FIELDS }),
      });
      return { items: data.issues, next: data.isLast === true ? null : (data.nextPageToken ?? null) };
    });
    return {
      truncated,
      tickets: items.map((i) => toTicket(config, i)),
    };
  },

  async getTicket(secret, config, ticket) {
    return toTicket(config, await jira<Issue>(config, secret, `/rest/api/3/issue/${encodeURIComponent(ticket.provider_id)}?fields=${FIELDS.join(',')}`));
  },

  async updateStatus(secret, config, ticket, status) {
    const { transitions } = await jira<{ transitions: { id: string; name: string; to: { name: string; statusCategory: { key: string } } }[] }>(
      config,
      secret,
      `/rest/api/3/issue/${ticket.key}/transitions`,
    );
    const t = transitions.find((x) => x.to.statusCategory.key === CATEGORY[status]);
    if (!t) throw new Error(`Jira: nenhuma transição disponível para a categoria ${CATEGORY[status]} (${transitions.map((x) => x.to.name).join(', ')})`);
    const res = await fetch(`${base(config)}/rest/api/3/issue/${ticket.key}/transitions`, {
      method: 'POST',
      headers: { authorization: auth(config, secret), 'content-type': 'application/json' },
      body: JSON.stringify({ transition: { id: t.id } }),
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return t.to.name;
  },
};
