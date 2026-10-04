import type { ConnectionInfo, ExternalTicket, TicketProvider, TicketSourceConfig } from './types.js';
import { collectPages } from './paginate.js';

const API = 'https://api.linear.app/graphql';

async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) throw new Error(`Linear: ${body.errors?.[0]?.message ?? res.status}`);
  return body.data as T;
}

/** Tipos de estado do Linear → kanban. */
function mapState(type: string): ExternalTicket['status'] {
  if (type === 'started') return 'doing';
  if (type === 'completed' || type === 'canceled') return 'done';
  if (type === 'unstarted') return 'todo';
  return 'backlog'; // backlog, triage
}

/** kanban → tipo de estado do Linear (o estado escolhido é o primeiro do tipo, por posição). */
const STATE_TYPE: Record<string, string> = { backlog: 'backlog', todo: 'unstarted', doing: 'started', done: 'completed' };

type Node = { id: string; identifier: string; title: string; description: string | null; url: string; updatedAt: string; priority: number; state: { name: string; type: string }; assignee: { name: string } | null; labels: { nodes: { name: string }[] } };
const ISSUE_FIELDS = 'id identifier title description url updatedAt priority state { name type } assignee { name } labels { nodes { name } }';

function toTicket(i: Node): ExternalTicket {
  return {
    sync_key: `linear:${i.id}`,
    provider: 'linear',
    provider_id: i.id,
    key: i.identifier,
    title: i.title,
    description: i.description,
    url: i.url,
    state: i.state.name,
    status: mapState(i.state.type),
    updatedAt: i.updatedAt,
    meta: { priority: i.priority, assignee: i.assignee?.name ?? null, labels: i.labels.nodes.map((l) => l.name) },
  };
}

export const linear: TicketProvider = {
  provider: 'linear',

  async testConnection(secret): Promise<ConnectionInfo> {
    try {
      const data = await gql<{ viewer: { name: string; email: string }; teams: { nodes: { id: string; key: string; name: string }[] } }>(
        secret,
        `query { viewer { name email } teams(first: 50) { nodes { id key name } } }`,
      );
      return {
        ok: true,
        account: data.viewer.email,
        options: { teams: data.teams.nodes.map((t) => ({ id: t.key, name: `${t.name} (${t.key})` })) },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async listTickets(secret, _config, source: TicketSourceConfig) {
    const names = source.filter ? source.filter.split(',').map((s) => s.trim()).filter(Boolean) : [];
    // one `state` object: a separate name filter would overwrite the open-only one
    const state = { type: { nin: ['completed', 'canceled'] }, ...(names.length ? { name: { in: names } } : {}) };
    const { items, truncated } = await collectPages<Node, string>(async (after) => {
      const data = await gql<{ issues: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
        secret,
        `query($filter: IssueFilter, $after: String) {
          issues(filter: $filter, first: 100, after: $after, orderBy: updatedAt) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter: { team: { key: { eq: source.scope } }, state }, after },
      );
      return { items: data.issues.nodes, next: data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null };
    });
    return {
      truncated,
      tickets: items.map(toTicket),
    };
  },

  async getTicket(secret, _config, ticket) {
    const data = await gql<{ issue: Node | null }>(secret, `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: ticket.provider_id });
    if (!data.issue) throw new Error(`Linear: ticket ${ticket.key} não encontrado`);
    return toTicket(data.issue);
  },

  async updateStatus(secret, _config, ticket, status) {
    const data = await gql<{ workflowStates: { nodes: { id: string; name: string; type: string; position: number }[] } }>(
      secret,
      `query($key: String!) { workflowStates(filter: { team: { key: { eq: $key } } }, first: 50) { nodes { id name type position } } }`,
      { key: ticket.scope },
    );
    const target = data.workflowStates.nodes.filter((s) => s.type === STATE_TYPE[status]).sort((a, b) => a.position - b.position)[0];
    if (!target) throw new Error(`Linear: time ${ticket.scope} não tem estado do tipo ${STATE_TYPE[status]}`);
    await gql(secret, `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`, {
      id: ticket.provider_id,
      stateId: target.id,
    });
    return target.name;
  },
};
