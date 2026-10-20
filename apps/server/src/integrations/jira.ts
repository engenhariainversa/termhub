import type { ConnectionInfo, ExternalTicket, TicketProvider, TicketSourceConfig } from './types.js';
import { collectPages } from './paginate.js';
import { checkPublicUrl, checkUrlShape } from './public-url.js';

/** Jira Cloud: config = { baseUrl: "https://xxx.atlassian.net", email }, secret = API token. */
function auth(config: Record<string, unknown>, token: string) {
  const email = String(config.email ?? '');
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

/** The site's root, normalized (no trailing slash). Shape only: https, a dotted name or a public IP. */
function base(config: Record<string, unknown>): string {
  const shape = checkUrlShape(String(config.baseUrl ?? ''));
  if (!shape.ok) throw new Error(`Jira: ${shape.reason}`);
  return rootOf(shape.url);
}

const rootOf = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, '')}`;

/** Same-site redirects followed before giving up. */
const MAX_REDIRECTS = 3;

/**
 * One request to the Jira site (TER-578): the base URL is checked again — DNS included — before every
 * call, redirects are followed only within the same origin, and an error carries the HTTP status alone,
 * never a piece of the answer body.
 */
async function request(config: Record<string, unknown>, token: string, path: string, init?: RequestInit): Promise<Response> {
  const check = await checkPublicUrl(String(config.baseUrl ?? ''));
  if (!check.ok) throw new Error(`Jira: ${check.reason}`);
  const origin = check.url.origin;
  let url = `${rootOf(check.url)}${path}`;
  let current: RequestInit = {
    ...init,
    headers: { authorization: auth(config, token), accept: 'application/json', 'content-type': 'application/json', ...(init?.headers ?? {}) },
  };
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...current, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400 || res.status === 304) {
      if (!res.ok) throw new Error(`Jira ${res.status}`);
      return res;
    }
    const location = res.headers.get('location');
    let next: URL | null = null;
    try {
      next = location ? new URL(location, url) : null;
    } catch {
      next = null;
    }
    if (!next || next.origin !== origin) throw new Error(`Jira ${res.status}: redirecionamento para fora de ${check.url.host} recusado`);
    if (hop >= MAX_REDIRECTS) throw new Error(`Jira ${res.status}: redirecionamentos demais`);
    // 307/308 keep the method and body; the others turn into a GET, as browsers do.
    if (res.status !== 307 && res.status !== 308) current = { ...current, method: 'GET', body: undefined };
    url = next.href;
  }
}

async function jira<T>(config: Record<string, unknown>, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await request(config, token, path, init);
  try {
    return (await res.json()) as T;
  } catch {
    // The parser's message quotes the start of the body; keep it out of the error.
    throw new Error('Jira: resposta não é JSON');
  }
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
    await request(config, secret, `/rest/api/3/issue/${ticket.key}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: t.id } }),
    });
    return t.to.name;
  },
};
