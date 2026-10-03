import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { chatGrantListResponse, decisionProofMessage, tabQuestionAutoAnswerCancelResponse } from '@termhub/mobile-api';
import type { Device } from '../db/repositories/devices.js';
import { applyErrorHandler, HttpError } from '../lib/errors.js';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import { mobileChatRoutes, mobileMeRoutes } from './m-chat.js';

const device: Device = {
  id: 'd1',
  user_id: 'u1',
  name: 'iPhone de Ana',
  platform: 'ios',
  model: 'iPhone 15',
  os_version: '18.0',
  app_version: '1.0.0+1',
  public_key: '{"kty":"EC"}',
  key_thumbprint: 'thumb',
  pin_failures: 0,
  pin_locked_until: null,
  status: 'active',
  revoked_at: null,
  revoked_reason: null,
  push_token: null,
  last_seen_at: '2026-09-20T00:00:00.000Z',
  last_ip: null,
  request_id: null,
  created_at: '2026-09-19T00:00:00.000Z',
};
const user = { id: 'u1', email: 'ana@example.com', name: 'Ana', nickname: 'ana', role_id: null, password_hash: 'secret-hash' };
const pendingAction = { id: 'act1', conversation_id: 'c1', tool: 'send_input', args: { tab_id: 't1' }, class: 'write', tab_id: 't1', machine_id: null, project_id: null };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function build(opts: {
  start?: ReturnType<typeof vi.fn>;
  reset?: ReturnType<typeof vi.fn>;
  resumeAfterDecision?: ReturnType<typeof vi.fn>;
  decide?: ReturnType<typeof vi.fn>;
  findByIdForUser?: ReturnType<typeof vi.fn>;
  checkPin?: ReturnType<typeof vi.fn>;
  consumeDecisionChallenge?: ReturnType<typeof vi.fn>;
  hostMachines?: { id: string; name: string; type: string }[];
  aiAccounts?: { id: string; provider: string; machine_id: string; config_dir: string | null; label?: string }[];
  setHost?: ReturnType<typeof vi.fn>;
  extraProjects?: { id: string; name: string; key: string; status: string }[];
  projectStatuses?: { project_id: string; busy: boolean; pending_confirmations: number }[];
  tabs?: { id: string; project_id: string; name: string }[];
  grants?: { id: string; conversation_id: string; tab_id: string; tool: string; source_action_id: string | null; granted_by: string; created_at: string; expires_at: string; revoked_at: string | null; revoked_by: string | null }[];
  revoke?: ReturnType<typeof vi.fn>;
  findGrantByIdForUser?: ReturnType<typeof vi.fn>;
  listForUser?: ReturnType<typeof vi.fn>;
  tabQuestions?: unknown[];
  /** Cards `tasks.findByIdsForOwner` resolves for 'u1': a board call's project. */
  boardTasks?: { id: string; project_id: string }[];
  /** Projects `projects.findByIdsForOwner` names for 'u1'. */
  namedProjects?: { id: string; name: string }[];
  /** Active project grants `chatProjectGrants.listActive` answers with, as `GET /chat` returns them. */
  projectGrants?: { id: string; conversation_id: string; project_id: string; scope?: 'board' | 'all'; source_action_id: string | null; granted_by: string; created_at: string; expires_at: string; revoked_at: string | null; revoked_by: string | null }[];
  /** Active standing grants `chatStandingGrants.listActive` answers with, as `GET /chat` returns them (TER-386). */
  standingGrants?: { id: string; user_id: string; project_id: string; kind: string; conversation_id: string | null; source_action_id: string | null; created_at: string; revoked_at: string | null; revoked_by: string | null }[];
  revokeStanding?: ReturnType<typeof vi.fn>;
  listForUserStanding?: ReturnType<typeof vi.fn>;
  /** Overrides the conversation `GET /` and the decision route resolve, e.g. to give it a `project_id`. */
  conversationFor?: ReturnType<typeof vi.fn>;
  /** "View as" another owner: the request's own user stays 'u1'. */
  viewAsOwner?: string;
  subagentsFor?: ReturnType<typeof vi.fn>;
  cancelSubagent?: ReturnType<typeof vi.fn>;
  openAnswerIds?: ReturnType<typeof vi.fn>;
  /** The members of the signed-in user's Favoritos, in order; undefined = no Favoritos row yet. */
  favorites?: string[];
  setFavorite?: ReturnType<typeof vi.fn>;
} = {}) {
  const extraProjects = opts.extraProjects ?? [];
  const decide = opts.decide ?? vi.fn(async (_id: string, _userId: string, status: string) => ({ ...pendingAction, status }));
  const findByIdForUser = opts.findByIdForUser ?? vi.fn(async () => ({ ...pendingAction, status: 'pending' }));
  const resumeAfterDecision = opts.resumeAfterDecision ?? vi.fn(async () => ({ id: 'm3', role: 'assistant', text: 'Feito.' }));
  const start =
    opts.start ??
    vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done: new Promise(() => undefined) }));
  const service = {
    conversationFor: opts.conversationFor ?? vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: null })),
    start,
    resumeAfterDecision,
    reset: opts.reset ?? vi.fn(async () => ({ id: 'c_new', project_id: 'p1' })),
    hostFor: vi.fn(async () => ({ kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null })),
    projectStatuses: vi.fn(async () => opts.projectStatuses ?? [{ project_id: 'p1', busy: true, pending_confirmations: 2 }]),
    subagentsFor: opts.subagentsFor ?? vi.fn(async () => []),
    cancelSubagent: opts.cancelSubagent ?? vi.fn(async () => ({ id: 'sub1', description: 'Escrever testes', subagent_type: null, status: 'stopping', started_at: '2026-09-26T12:00:00.000Z', ended_at: null })),
    openAnswerIds: opts.openAnswerIds ?? vi.fn(async () => []),
  };
  const session = {
    checkPin: opts.checkPin ?? vi.fn(async () => ({ ok: true })),
    consumeDecisionChallenge: opts.consumeDecisionChallenge ?? vi.fn(async () => true),
  };
  const agents = {
    capabilities: vi.fn((id: string) => (id === 'm1' ? ['chat'] : null)),
    info: vi.fn((id: string) => (id === 'm1' ? { agent_version: '0.9.0' } : null)),
    awaitAgent: vi.fn(async () => true),
    awaitHandover: vi.fn(async () => true),
  };
  const hostMachines = opts.hostMachines ?? [{ id: 'm1', name: 'jarvis', type: 'agent' }];
  const aiAccounts = opts.aiAccounts ?? [];
  const setHost =
    opts.setHost ??
    vi.fn(async (id: string, host: { machine_id: string; ai_account_id: string | null }) => ({ conversation: { id, user_id: 'u1', cli_session_id: null, ...host }, moved: false }));
  const repos = {
    chat: {
      listMessages: vi.fn(async () => [{ id: 'm1', role: 'user', text: 'oi' }]),
      setHost,
      clearProjectSessions: vi.fn(async () => undefined),
      listActiveProjectConversations: vi.fn(async () => [{ id: 'c_p1', project_id: 'p1', last_message_at: '2026-09-23T10:00:00.000Z' }]),
    },
    chatActions: { decide, findByIdForUser, listByConversation: vi.fn(async () => []) },
    tabQuestions: { listByConversation: vi.fn(async () => opts.tabQuestions ?? []) },
    tabLimitNotices: { listByConversation: vi.fn(async () => []) },
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[]) => (opts.tabs ?? []).filter((t) => ids.includes(t.id))) },
    chatGrants: {
      grant: vi.fn(async (input: { conversation_id: string; tab_id: string; tool: string; source_action_id: string; granted_by: string }) => ({ id: 'g1', ...input, created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', revoked_at: null, revoked_by: null })),
      listActive: vi.fn(async () => opts.grants ?? []),
      revoke: opts.revoke ?? vi.fn(async (id: string) => ({ id, conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: '', expires_at: '', revoked_at: 'now', revoked_by: 'u1' })),
      findByIdForUser: opts.findGrantByIdForUser ?? vi.fn(async () => undefined),
      listForUser: opts.listForUser ?? vi.fn(async () => ({ grants: [], next: null })),
      findActive: vi.fn(async (): Promise<unknown> => undefined),
      revokeTool: vi.fn(async () => 0),
    },
    // `revokeGrant` falls through to this repository once a tab grant does not match: by default no
    // project grant matches either.
    chatProjectGrants: {
      grant: vi.fn(async (input: { conversation_id: string; project_id: string; source_action_id: string; granted_by: string }) => ({ id: 'pg1', ...input, created_at: '2026-09-27T10:00:00.000Z', expires_at: '2026-09-28T10:00:00.000Z', revoked_at: null, revoked_by: null })),
      listActive: vi.fn(async () => opts.projectGrants ?? []),
      revoke: vi.fn(async () => undefined),
      findByIdForUser: vi.fn(async () => undefined),
      listForUser: vi.fn(async () => ({ grants: [], next: null })),
    },
    // ...and then to standing grants (TER-386): by default none matches either.
    chatStandingGrants: {
      grant: vi.fn(async (input: { user_id: string; project_id: string; kind: string; conversation_id: string | null; source_action_id: string | null }) => ({ id: 'sg1', ...input, created_at: '2026-09-28T10:00:00.000Z', revoked_at: null, revoked_by: null })),
      listActive: vi.fn(async () => opts.standingGrants ?? []),
      findActive: vi.fn(async (): Promise<unknown> => undefined),
      findActiveBySourceAction: vi.fn(async (): Promise<unknown> => undefined),
      revoke: opts.revokeStanding ?? vi.fn(async () => undefined),
      findByIdForUser: vi.fn(async () => undefined),
      listForUser: opts.listForUserStanding ?? vi.fn(async () => ({ grants: [], next: null })),
    },
    projects: {
      findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === 'u1' ? (opts.namedProjects ?? []).filter((p) => ids.includes(p.id)) : [])),
      list: vi.fn(async (f: { owner?: string }) =>
        f.owner === 'u1'
          ? [
              { id: 'p1', name: 'reactivando', key: 'REA', status: 'active' },
              { id: 'p2', name: 'termhub', key: 'TH', status: 'paused' },
              ...extraProjects,
            ]
          : []
      ),
    },
    machines: {
      findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === 'u1' ? hostMachines.filter((m) => ids.includes(m.id)) : [])),
      list: vi.fn(async (owner: string) =>
        owner === 'u1'
          ? [
              { id: 'm1', name: 'jarvis', type: 'agent' },
              { id: 'm2', name: 'macbook', type: 'agent' },
              { id: 'm3', name: 'vps', type: 'ssh' },
            ]
          : []
      ),
    },
    aiAccounts: {
      findById: vi.fn(async (id: string) => aiAccounts.find((a) => a.id === id)),
      list: vi.fn(async (owner: string) =>
        owner === 'u1'
          ? [
              { id: 'acc1', label: 'Trabalho', machine_id: 'm1', provider: 'claude', config_dir: '/home/u/.claude-work' },
              { id: 'acc2', label: 'GPT', machine_id: 'm1', provider: 'chatgpt', config_dir: null },
              { id: 'acc3', label: 'Pessoal', machine_id: 'm2', provider: 'claude', config_dir: null },
            ]
          : []
      ),
    },
    tasks: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === 'u1' ? (opts.boardTasks ?? []).filter((t) => ids.includes(t.id)) : [])) },
    userNotifications: { countUnread: vi.fn(async () => 3) },
    projectGroups: {
      read: vi.fn(async (userId: string) =>
        userId === 'u1' && opts.favorites ? [{ id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: opts.favorites }, { id: 'g2', name: 'Outro', kind: 'custom', position: 1, project_ids: ['p2'] }] : []
      ),
      list: vi.fn(async () => []),
      setFavorite: opts.setFavorite ?? vi.fn(async () => undefined),
    },
    roles: { findById: vi.fn(async () => undefined), permissionsOf: vi.fn(async () => []) },
  };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    const ownerId = opts.viewAsOwner ?? 'u1';
    (req as unknown as { scope: unknown }).scope = { user, viewAs: opts.viewAsOwner ? { kind: 'user', userId: ownerId } : { kind: 'self' }, ownerId, createAs: ownerId };
    req.mobile = { device, user } as never;
  });
  const indexActions = vi.fn(async () => {});
  app.register((a) => mobileChatRoutes(a, repos as never, { chat: service as never, agents, session: session as never, indexActions }), { prefix: '/chat' });
  app.register((a) => mobileMeRoutes(a, repos as never), { prefix: '' });
  return { app, service, session, agents, repos, decide, findByIdForUser, resumeAfterDecision, start, setHost, indexActions };
}

const approve = { decision: 'approve', challenge: 'chal-1', pin_proof: 'proof-1' };

describe('GET /chat', () => {
  it('returns { conversation, messages, actions, host } like the web', async () => {
    const { app, service, repos } = build();
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ conversation: { id: 'c1' }, messages: [{ id: 'm1', text: 'oi' }], actions: [], host: { kind: 'ready' } });
    expect(service.conversationFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), null);
    expect(repos.chat.listMessages).toHaveBeenCalledWith('c1');
    expect(repos.chatActions.listByConversation).toHaveBeenCalledWith('c1');
  });

  it('lists the answers still to come, only among the empty rows it returns', async () => {
    const { app, repos } = build({ openAnswerIds: vi.fn(async () => ['m-open', 'm-done', 'm-gone']) });
    repos.chat.listMessages = vi.fn(async () => [
      { id: 'm-q', role: 'user', text: 'oi', error_code: null },
      { id: 'm-done', role: 'assistant', text: 'pronto', error_code: null },
      { id: 'm-open', role: 'assistant', text: '', error_code: null },
      { id: 'm-dead', role: 'assistant', text: '', error_code: null },
    ]) as never;
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.statusCode).toBe(200);
    expect(res.json().open_answer_ids).toEqual(['m-open']);
  });

  it('answers an empty list when nothing is being answered', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'GET', url: '/chat' })).json().open_answer_ids).toEqual([]);
  });

  it('returns the tab questions too', async () => {
    const q = { id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null, status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '' };
    const { app } = build({ tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], tabQuestions: [q] });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.json().tab_questions).toEqual([expect.objectContaining({ id: 'q1', tab_name: 'api', kind: 'permission' })]);
  });

  it('returns the suggestions apart from the tab questions', async () => {
    const common = { tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', tool_use_id: null, status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '' };
    const { app } = build({ tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], tabQuestions: [{ ...common, id: 'q1', kind: 'permission', payload: { tool_name: 'Bash' } }, { ...common, id: 's1', kind: 'suggestion', payload: { text: 'commit it' } }] });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.json().tab_questions).toEqual([expect.objectContaining({ id: 'q1' })]);
    expect(res.json().tab_suggestions).toEqual([expect.objectContaining({ id: 's1', kind: 'suggestion', payload: { text: 'commit it', context: null } })]);
  });

  it('?project= reads that project conversation and its host', async () => {
    const { app, service } = build();
    const res = await app.inject({ method: 'GET', url: '/chat?project=p1' });
    expect(res.statusCode).toBe(200);
    expect(service.conversationFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
    expect(service.hostFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
  });

  it('returns the conversation\'s active standing grants, scoped to its own project (TER-386)', async () => {
    const conversationFor = vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: null, project_id: 'p1' }));
    const { app, repos } = build({
      conversationFor,
      standingGrants: [{ id: 'sg1', user_id: 'u1', project_id: 'p1', kind: 'board', conversation_id: 'c0', source_action_id: 'a0', created_at: 'x', revoked_at: null, revoked_by: null }],
      namedProjects: [{ id: 'p1', name: 'App' }],
    });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(repos.chatStandingGrants.listActive).toHaveBeenCalledWith('u1', 'p1');
    expect(res.json().standing_grants).toEqual([{ id: 'sg1', project_id: 'p1', project_name: 'App', kind: 'board', source_action_id: 'a0', created_at: 'x' }]);
  });

  it('with no project (general chat) reads every one of the user\'s standing grants', async () => {
    const conversationFor = vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: null, project_id: null }));
    const { app, repos } = build({ conversationFor });
    await app.inject({ method: 'GET', url: '/chat' });
    expect(repos.chatStandingGrants.listActive).toHaveBeenCalledWith('u1', undefined);
  });
});

describe('GET /chat/projects', () => {
  it('joins the statuses with the owner projects, including projects with no conversation yet', async () => {
    const { app, repos } = build();
    const res = await app.inject({ method: 'GET', url: '/chat/projects' });
    expect(res.statusCode).toBe(200);
    expect(repos.projects.list).toHaveBeenCalledWith({ owner: 'u1' });
    expect(res.json()).toEqual({
      projects: [
        { id: 'p1', name: 'reactivando', key: 'REA', busy: true, pending_confirmations: 2, last_message_at: '2026-09-23T10:00:00.000Z', favorite_position: null },
        { id: 'p2', name: 'termhub', key: 'TH', busy: false, pending_confirmations: 0, last_message_at: null, favorite_position: null },
      ],
    });
  });
});

describe('GET /chat/projects, archived projects', () => {
  it('hides an archived project, but keeps one whose chat is busy or waiting on a confirmation', async () => {
    const { app } = build({
      extraProjects: [
        { id: 'p3', name: 'antigo', key: 'ANT', status: 'archived' },
        { id: 'p4', name: 'arquivado-pendente', key: 'ARP', status: 'archived' },
        { id: 'p5', name: 'arquivado-ocupado', key: 'ARO', status: 'archived' },
      ],
      projectStatuses: [
        { project_id: 'p1', busy: true, pending_confirmations: 2 },
        { project_id: 'p3', busy: false, pending_confirmations: 0 },
        { project_id: 'p4', busy: false, pending_confirmations: 1 },
        { project_id: 'p5', busy: true, pending_confirmations: 0 },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/chat/projects' });
    expect(res.statusCode).toBe(200);
    const ids = res.json().projects.map((p: { id: string }) => p.id);
    // p2 is paused: paused projects stay listed.
    expect(ids).toEqual(['p1', 'p2', 'p4', 'p5']);
    expect(res.json().projects.find((p: { id: string }) => p.id === 'p4')).toMatchObject({ pending_confirmations: 1, busy: false });
  });
});

describe('GET /chat/projects, favorites (TER-541)', () => {
  it("gives each pinned project its place in the user's Favoritos, dense over the projects listed", async () => {
    const { app, repos } = build({ favorites: ['p2', 'gone', 'p1'] });
    const res = await app.inject({ method: 'GET', url: '/chat/projects' });
    expect(res.statusCode).toBe(200);
    const place = Object.fromEntries(res.json().projects.map((p: { id: string; favorite_position: number | null }) => [p.id, p.favorite_position]));
    expect(place).toEqual({ p1: 1, p2: 0 });
    expect(repos.projectGroups.read).toHaveBeenCalledWith('u1');
    expect(repos.projectGroups.list).not.toHaveBeenCalled();
  });

  it('reads the signed-in user groups even when viewing as another owner', async () => {
    const { app, repos } = build({ viewAsOwner: 'u2', favorites: ['p1'] });
    await app.inject({ method: 'GET', url: '/chat/projects' });
    expect(repos.projectGroups.read).toHaveBeenCalledWith('u1');
  });
});

describe('PUT /chat/projects/:id/favorite (TER-541)', () => {
  it('pins and unpins a project of the user, answering 204', async () => {
    const { app, repos } = build({ namedProjects: [{ id: 'p1', name: 'reactivando' }] });
    const pin = await app.inject({ method: 'PUT', url: '/chat/projects/p1/favorite', payload: { favorite: true } });
    expect(pin.statusCode).toBe(204);
    expect(repos.projectGroups.setFavorite).toHaveBeenLastCalledWith('u1', 'p1', true);
    const unpin = await app.inject({ method: 'PUT', url: '/chat/projects/p1/favorite', payload: { favorite: false } });
    expect(unpin.statusCode).toBe(204);
    expect(repos.projectGroups.setFavorite).toHaveBeenLastCalledWith('u1', 'p1', false);
  });

  it('answers 404 for a project that is not the user own, and writes nothing', async () => {
    const { app, repos } = build({ namedProjects: [] });
    const res = await app.inject({ method: 'PUT', url: '/chat/projects/px/favorite', payload: { favorite: true } });
    expect(res.statusCode).toBe(404);
    expect(repos.projectGroups.setFavorite).not.toHaveBeenCalled();
  });

  it('answers 400 for a body without the end state', async () => {
    const { app, repos } = build({ namedProjects: [{ id: 'p1', name: 'reactivando' }] });
    const res = await app.inject({ method: 'PUT', url: '/chat/projects/p1/favorite', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(repos.projectGroups.setFavorite).not.toHaveBeenCalled();
  });

  it('writes to the signed-in user Favoritos when viewing as another owner', async () => {
    const { app, repos } = build({ viewAsOwner: 'u2', namedProjects: [{ id: 'p1', name: 'reactivando' }] });
    const res = await app.inject({ method: 'PUT', url: '/chat/projects/p1/favorite', payload: { favorite: true } });
    expect(res.statusCode).toBe(204);
    expect(repos.projectGroups.setFavorite).toHaveBeenCalledWith('u1', 'p1', true);
  });

  it('answers 400 when Favoritos is full', async () => {
    const { ProjectGroupRuleError } = await import('../db/repositories/project-groups.js');
    const setFavorite = vi.fn(async () => {
      throw new ProjectGroupRuleError('LIMIT', 'Limite de 500 projetos por grupo');
    });
    const { app } = build({ namedProjects: [{ id: 'p1', name: 'reactivando' }], setFavorite });
    const res = await app.inject({ method: 'PUT', url: '/chat/projects/p1/favorite', payload: { favorite: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('LIMIT');
  });
});

describe('GET /chat/host/options', () => {
  it('lists only the user agent machines, with online, agent_version and their Claude accounts', async () => {
    const { app, repos } = build();
    const res = await app.inject({ method: 'GET', url: '/chat/host/options' });
    expect(res.statusCode).toBe(200);
    expect(repos.machines.list).toHaveBeenCalledWith('u1');
    expect(repos.aiAccounts.list).toHaveBeenCalledWith('u1');
    expect(res.json()).toEqual({
      machines: [
        { id: 'm1', name: 'jarvis', online: true, agent_version: '0.9.0', accounts: [{ id: 'acc1', label: 'Trabalho', config_dir: '/home/u/.claude-work' }] },
        { id: 'm2', name: 'macbook', online: false, agent_version: null, accounts: [{ id: 'acc3', label: 'Pessoal', config_dir: null }] },
      ],
    });
  });
});

describe('POST /chat/host', () => {
  it('sets the host and answers with the conversation and the resolved state', async () => {
    const { app, setHost } = build({ aiAccounts: [{ id: 'acc1', provider: 'claude', machine_id: 'm1', config_dir: null }] });
    const res = await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1', ai_account_id: 'acc1' } });
    expect(res.statusCode).toBe(200);
    expect(setHost).toHaveBeenCalledWith('c1', { machine_id: 'm1', ai_account_id: 'acc1' });
    expect(res.json()).toMatchObject({ host: { kind: 'ready' } });
  });

  it('never accepts a machine this user does not own, nor an account that is not on it', async () => {
    const { app, setHost } = build({ aiAccounts: [{ id: 'acc9', provider: 'claude', machine_id: 'm9', config_dir: null }] });
    expect((await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm-someone-else' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1', ai_account_id: 'acc9' } })).statusCode).toBe(404);
    expect(setHost).not.toHaveBeenCalled();
  });

  it('refuses a machine with no agent and an account that is not a Claude login', async () => {
    const ssh = build({ hostMachines: [{ id: 'm1', name: 'vps', type: 'ssh' }] });
    const noAgent = await ssh.app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1' } });
    expect(noAgent.statusCode).toBe(400);
    expect(noAgent.json().code).toBe('CHAT_HOST_NOT_AGENT');

    const other = build({ aiAccounts: [{ id: 'acc1', provider: 'chatgpt', machine_id: 'm1', config_dir: null }] });
    const notClaude = await other.app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1', ai_account_id: 'acc1' } });
    expect(notClaude.statusCode).toBe(400);
    expect(other.setHost).not.toHaveBeenCalled();
  });

  it('clears the project sessions when the host really moved', async () => {
    const setHost = vi.fn(async (id: string, host: { machine_id: string; ai_account_id: string | null }) => ({ conversation: { id, ...host }, moved: true }));
    const { app, repos } = build({ setHost });
    await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1' } });
    expect(repos.chat.clearProjectSessions).toHaveBeenCalledWith('u1');
  });
});

describe('POST /chat/reset', () => {
  it('archives the scope and answers the fresh conversation', async () => {
    const { app, service } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/reset', payload: { project_id: 'p1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.id).toBe('c_new');
    expect(service.reset).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
  });

  it('without project_id resets the account-wide chat, and is a 409 while busy', async () => {
    const { app, service } = build();
    await app.inject({ method: 'POST', url: '/chat/reset', payload: {} });
    expect(service.reset).toHaveBeenCalledWith(expect.anything(), null);

    const busy = build({ reset: vi.fn(async () => { throw new HttpError(409, 'ocupado', 'CHAT_BUSY'); }) });
    expect((await busy.app.inject({ method: 'POST', url: '/chat/reset', payload: {} })).statusCode).toBe(409);
  });
});

describe('POST /chat/messages', () => {
  it('answers 202 with the three ids while the run is still going', async () => {
    const d = deferred<unknown>();
    const start = vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done: d.promise }));
    const { app } = build({ start });
    const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', project_id: 'p1' } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma' });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'oi', { projectId: 'p1' });
    d.resolve({ id: 'ma' });
  });

  it('swallows a rejected done: never an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const d = deferred<unknown>();
      const start = vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done: d.promise }));
      const { app } = build({ start });
      const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi' } });
      expect(res.statusCode).toBe(202);
      d.reject(new HttpError(502, 'O concierge não respondeu', 'CONCIERGE_FAILED'));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('passes CHAT_BUSY from start through as 409, and rejects an empty message', async () => {
    const { app } = build({ start: vi.fn(async () => { throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY'); }) });
    const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'segunda' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CHAT_BUSY');
    expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: '  ' } })).statusCode).toBe(400);
  });

  it('passes attachment_ids to start and allows an empty text with them', async () => {
    const { app, start } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: '', attachment_ids: ['a1'] } });
    expect(res.statusCode).toBe(202);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), '', { projectId: null, attachmentIds: ['a1'] });
    expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: '', attachment_ids: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { attachment_ids: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', attachment_ids: ['1', '2', '3', '4', '5', '6'] } })).statusCode).toBe(400);
  });

  it('passes reply_to_id to start (TER-447)', async () => {
    const { app, start } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'faz de novo', reply_to_id: 'm7' } });
    expect(res.statusCode).toBe(202);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'faz de novo', { projectId: null, replyToId: 'm7' });
    expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', reply_to_id: '' } })).statusCode).toBe(400);
  });

  it('passes reply_to_card to start (TER-849)', async () => {
    const { app, start } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'escolhe azul', reply_to_card: { kind: 'tab_question', id: 'q7' } } });
    expect(res.statusCode).toBe(202);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'escolhe azul', { projectId: null, replyToCard: { kind: 'tab_question', id: 'q7' } });
  });
});

describe('POST /chat/actions/:id/decision', () => {
  it('deny: decides, publishes the event and resumes, with no PIN involvement', async () => {
    const { app, decide, resumeAfterDecision, session, indexActions } = build();
    const events: ChatEvent[] = [];
    const unsubscribe = chatBus.subscribe((e) => events.push(e));
    let res;
    try {
      res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'deny' } });
    } finally {
      unsubscribe();
    }
    expect(res.statusCode).toBe(200);
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'denied');
    expect(events).toContainEqual({ type: 'decision', user_id: 'u1', conversation_id: 'c1', action_id: 'act1', status: 'denied' });
    expect(resumeAfterDecision.mock.calls[0][1]).toMatchObject({ id: 'act1', status: 'denied' });
    expect(res.json()).toEqual({ action: expect.objectContaining({ id: 'act1', status: 'denied' }), queued: true, note: 'A decisão foi registrada; a resposta chega pelo chat.' });
    expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    // Memory (spec 2026-09-26 concierge memory §4): the decided row is indexed, fire-and-forget.
    expect(indexActions).toHaveBeenCalledWith('u1', [expect.objectContaining({ id: 'act1', status: 'denied' })]);
  });

  it('deny: 404 for an unknown row and 409 for a decided one', async () => {
    const missing = build({ decide: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => undefined) });
    expect((await missing.app.inject({ method: 'POST', url: '/chat/actions/nope/decision', payload: { decision: 'deny' } })).statusCode).toBe(404);
    const decided = build({ decide: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => ({ ...pendingAction, status: 'approved' })) });
    expect((await decided.app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'deny' } })).statusCode).toBe(409);
  });

  it('approve: a write card without a proof is approved with no challenge and no PIN work', async () => {
    const { app, session, decide, resumeAfterDecision } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ queued: true });
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    await vi.waitFor(() => expect(resumeAfterDecision).toHaveBeenCalled());
  });

  it('approve: an irreversible card without a proof is 401 PIN_REQUIRED and stays pending, nothing consumed', async () => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => ({ ...pendingAction, status: 'pending', class: 'irreversible' })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Confirme com o PIN para autorizar esta ação.', code: 'PIN_REQUIRED' });
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: a read card without a proof is 401 PIN_REQUIRED and stays pending, nothing consumed', async () => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => ({ ...pendingAction, status: 'pending', class: 'read' })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Confirme com o PIN para autorizar esta ação.', code: 'PIN_REQUIRED' });
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: an irreversible card with a good proof is approved as before', async () => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => ({ ...pendingAction, status: 'pending', class: 'irreversible' })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(200);
    expect(session.checkPin).toHaveBeenCalled();
    expect(decide).toHaveBeenCalled();
  });

  it('approve: a write card sent with a proof (an older app) still has it checked and counted', async () => {
    const { app, decide } = build({ checkPin: vi.fn(async () => ({ ok: false, code: 'PIN_INVALID', failures: 1 })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('PIN_INVALID');
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: half a proof is a 400', async () => {
    const { app, decide } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve', challenge: 'chal-1' } });
    expect(res.statusCode).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve_tab without a proof is still a 400', async () => {
    const { app, decide } = build();
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
    expect(res.statusCode).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: 404 for a row this user cannot see, before any PIN work', async () => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => undefined) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/nope/decision', payload: approve });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Ação não encontrada');
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: an already-decided action answers 409 before the challenge or the PIN are touched', async () => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => ({ ...pendingAction, status: 'denied' })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Esta ação já foi decidida');
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: a challenge that does not consume is 400 CHALLENGE_INVALID, with no PIN check', async () => {
    const { app, session, decide } = build({ consumeDecisionChallenge: vi.fn(async () => false) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'CHALLENGE_INVALID', error: 'Desafio inválido ou expirado' });
    expect(session.consumeDecisionChallenge).toHaveBeenCalledWith(device, 'chal-1', 'act1');
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: a wrong PIN is 401 with the failures, and the action stays pending', async () => {
    const { app, session, decide, resumeAfterDecision } = build({ checkPin: vi.fn(async () => ({ ok: false, code: 'PIN_INVALID', failures: 2 })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PIN_INVALID', failures: 2 });
    expect(session.checkPin).toHaveBeenCalledWith(device, decisionProofMessage('chal-1', 'act1', 'approve'), 'proof-1', expect.objectContaining({ ip: expect.any(String) }));
    expect(decide).not.toHaveBeenCalled();
    expect(resumeAfterDecision).not.toHaveBeenCalled();
  });

  it('approve: a locked device is 423 with retry-after in whole seconds', async () => {
    const { app, decide } = build({ checkPin: vi.fn(async () => ({ ok: false, code: 'DEVICE_LOCKED', retryAfterMs: 61_500 })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(423);
    expect(res.headers['retry-after']).toBe('62');
    expect(res.json().code).toBe('DEVICE_LOCKED');
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: a device revoked by the attempt is 401 DEVICE_REVOKED', async () => {
    const { app, decide } = build({ checkPin: vi.fn(async () => ({ ok: false, code: 'DEVICE_REVOKED' })) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('DEVICE_REVOKED');
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve: with a good proof decides, publishes the event and resumes', async () => {
    const { app, decide, resumeAfterDecision, session } = build();
    const events: ChatEvent[] = [];
    const unsubscribe = chatBus.subscribe((e) => events.push(e));
    let res;
    try {
      res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    } finally {
      unsubscribe();
    }
    expect(res.statusCode).toBe(200);
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    // challenge, then PIN, then the decision itself
    const [consumed] = session.consumeDecisionChallenge.mock.invocationCallOrder;
    const [checked] = session.checkPin.mock.invocationCallOrder;
    const [decided] = decide.mock.invocationCallOrder;
    expect(consumed).toBeLessThan(checked);
    expect(checked).toBeLessThan(decided);
    expect(events).toContainEqual({ type: 'decision', user_id: 'u1', conversation_id: 'c1', action_id: 'act1', status: 'approved' });
    expect(resumeAfterDecision.mock.calls[0][1]).toMatchObject({ id: 'act1', status: 'approved' });
    expect(res.json()).toEqual({ action: expect.objectContaining({ id: 'act1', status: 'approved' }), queued: true, note: 'A decisão foi registrada; a resposta chega pelo chat.' });
    expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
  });

  it('approve: a race lost to the web after the proof ends in the same 409', async () => {
    const findByIdForUser = vi
      .fn()
      .mockResolvedValueOnce({ ...pendingAction, status: 'pending' })
      .mockResolvedValueOnce({ ...pendingAction, status: 'approved' });
    const { app, resumeAfterDecision } = build({ decide: vi.fn(async () => undefined), findByIdForUser });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(409);
    expect(resumeAfterDecision).not.toHaveBeenCalled();
  });

  it('answers at once, without waiting for the resumed run', async () => {
    let finish!: () => void;
    const resumeAfterDecision = vi.fn(() => new Promise((resolve) => { finish = () => resolve({ id: 'm3' }); }));
    const { app } = build({ resumeAfterDecision });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: approve });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ queued: true, note: 'A decisão foi registrada; a resposta chega pelo chat.' });
    expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
    finish();
  });

  it.each([
    ['CHAT_BUSY', new HttpError(409, 'ocupado', 'CHAT_BUSY')],
    ['any other failure', new Error('boom')],
  ])('a resume that rejects (%s) never fails the request nor leaks an unhandled rejection', async (_label, failure) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const resumeAfterDecision = vi.fn(async () => { throw failure; });
      const { app } = build({ resumeAfterDecision });
      for (const payload of [approve, { decision: 'deny' }]) {
        const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ queued: true, note: 'A decisão foi registrada; a resposta chega pelo chat.' });
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(resumeAfterDecision).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('approve_tab: with a valid challenge and proof, decides, grants the tab and publishes both events', async () => {
    const eligible = { ...pendingAction, status: 'pending', args: { tab_id: 't1', text: 'oi' } };
    const { app, decide, repos, session } = build({ findByIdForUser: vi.fn(async () => eligible), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
    const events: ChatEvent[] = [];
    const unsubscribe = chatBus.subscribe((e) => events.push(e));
    let res;
    try {
      res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab', challenge: 'ch', pin_proof: 'proof-1' } });
    } finally {
      unsubscribe();
    }
    expect(res.statusCode).toBe(200);
    expect(session.checkPin).toHaveBeenCalledWith(device, decisionProofMessage('ch', 'act1', 'approve_tab'), 'proof-1', expect.objectContaining({ ip: expect.any(String) }));
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    expect(repos.chatGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1' });
    expect(res.json().grant).toMatchObject({ id: 'g1', tab_id: 't1', tab_name: 'Terminal 1' });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'grant']));
  });

  it('approve_tab whose grant fails still approves and resumes, with no grant in the answer or on the bus', async () => {
    const eligible = { ...pendingAction, status: 'pending', args: { tab_id: 't1', text: 'oi' } };
    const resumeAfterDecision = vi.fn(async () => undefined);
    const { app, decide, repos } = build({ resumeAfterDecision, findByIdForUser: vi.fn(async () => eligible), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
    vi.mocked(repos.chatGrants.grant).mockRejectedValueOnce(new Error('connection terminated'));
    const events: ChatEvent[] = [];
    const unsubscribe = chatBus.subscribe((e) => events.push(e));
    let res;
    try {
      res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab', challenge: 'ch', pin_proof: 'proof-1' } });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      unsubscribe();
    }
    expect(res.statusCode).toBe(200);
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    expect(res.json().action).toMatchObject({ id: 'act1', status: 'approved' });
    expect(res.json()).toMatchObject({ queued: true });
    expect(res.json()).not.toHaveProperty('grant');
    expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toContain('decision');
    expect(events.map((e) => e.type)).not.toContain('grant');
  });

  it('approve_tab: the PIN proof is bound to the decision word — a proof signed for "approve" cannot open a grant', async () => {
    // A route that mistakenly checked the proof against decisionProofMessage(..., 'approve') would
    // accept a proof that was only ever meant to approve, never to trust the tab. Staging checkPin to
    // succeed only for the exact 'approve_tab' message pins that the route asks for that word.
    const checkPin = vi.fn(async (_d: unknown, message: string) => (message.endsWith('\napprove_tab') ? { ok: true } : { ok: false, code: 'PIN_INVALID', failures: 1 }));
    const eligible = { ...pendingAction, status: 'pending', args: { tab_id: 't1', text: 'oi' } };
    const { app, decide, session } = build({ checkPin, findByIdForUser: vi.fn(async () => eligible) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab', challenge: 'ch', pin_proof: 'proof-1' } });
    expect(res.statusCode).toBe(200);
    expect(session.checkPin).toHaveBeenCalledWith(device, decisionProofMessage('ch', 'act1', 'approve_tab'), 'proof-1', expect.objectContaining({ ip: expect.any(String) }));
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  });

  it.each([
    ['run_command', { ...pendingAction, status: 'pending', tool: 'run_command', args: { command: 'ls' } }],
    ['send_input answering a permission', { ...pendingAction, status: 'pending', args: { tab_id: 't1', text: '1', answering_permission: true } }],
  ])('approve_tab refuses %s with 400 GRANT_NOT_ALLOWED, before any challenge or PIN work', async (_label, row) => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => row) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab', challenge: 'ch', pin_proof: 'proof-1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('approve_tab: an already-decided action answers 409 before the challenge, the PIN or the grant are touched', async () => {
    const decided = { ...pendingAction, status: 'approved', args: { tab_id: 't1', text: 'oi' } };
    const { app, session, decide, repos } = build({ findByIdForUser: vi.fn(async () => decided) });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab', challenge: 'ch', pin_proof: 'proof-1' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Esta ação já foi decidida');
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(repos.chatGrants.grant).not.toHaveBeenCalled();
  });
});

describe('POST /chat/actions/:id/decision: approve_project', () => {
  const boardCard = { ...pendingAction, status: 'pending', tool: 'move_task', args: { task_id: 'k1', status: 'done' }, tab_id: null };
  const decideProject = (app: ReturnType<typeof build>['app']) =>
    app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project', challenge: 'ch', pin_proof: 'proof-1' } });

  it('with a proof signed for approve_project, decides, grants the project and publishes both events', async () => {
    const { app, decide, repos, session } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }], namedProjects: [{ id: 'p1', name: 'App' }] });
    const events: ChatEvent[] = [];
    const unsubscribe = chatBus.subscribe((e) => events.push(e));
    let res;
    try {
      res = await decideProject(app);
    } finally {
      unsubscribe();
    }
    expect(res.statusCode).toBe(200);
    expect(session.consumeDecisionChallenge).toHaveBeenCalledWith(device, 'ch', 'act1');
    expect(session.checkPin).toHaveBeenCalledWith(device, decisionProofMessage('ch', 'act1', 'approve_project'), 'proof-1', expect.objectContaining({ ip: expect.any(String) }));
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', project_id: 'p1', source_action_id: 'act1', granted_by: 'u1', scope: 'board' });
    expect(repos.chatGrants.grant).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ queued: true, project_grant: { id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'act1' } });
    expect(res.json()).not.toHaveProperty('grant');
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'project_grant']));
  });

  it('resolves the card with the signed-in user, never the "view as" owner', async () => {
    const { app, repos } = build({ viewAsOwner: 'u2', findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    const res = await decideProject(app);
    expect(res.statusCode).toBe(200);
    expect(repos.tasks.findByIdsForOwner).toHaveBeenCalledWith(['k1'], 'u1');
    expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', granted_by: 'u1' }));
  });

  it.each([['approve_tab'], ['approve']] as const)('a proof signed for %s is refused for approve_project', async (word) => {
    // checkPin only accepts the exact message the proof was signed over: a route that checked the
    // wrong word would let a proof for another decision open a project grant.
    const checkPin = vi.fn(async (_d: unknown, message: string) => (message === decisionProofMessage('ch', 'act1', word) ? { ok: true } : { ok: false, code: 'PIN_INVALID', failures: 1 }));
    const { app, decide, repos } = build({ checkPin, findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    const res = await decideProject(app);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('PIN_INVALID');
    expect(decide).not.toHaveBeenCalled();
    expect(repos.chatProjectGrants.grant).not.toHaveBeenCalled();
  });

  it('whose grant fails still approves and resumes, with no project_grant in the answer or on the bus', async () => {
    const resumeAfterDecision = vi.fn(async () => undefined);
    const { app, decide, repos } = build({ resumeAfterDecision, findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    vi.mocked(repos.chatProjectGrants.grant).mockRejectedValueOnce(new Error('connection terminated'));
    const events: ChatEvent[] = [];
    const unsubscribe = chatBus.subscribe((e) => events.push(e));
    let res;
    try {
      res = await decideProject(app);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      unsubscribe();
    }
    expect(res.statusCode).toBe(200);
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    expect(res.json()).toMatchObject({ queued: true });
    expect(res.json()).not.toHaveProperty('project_grant');
    expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).not.toContain('project_grant');
  });

  it.each([
    ['a non-board card', { ...boardCard, tool: 'delete_task', args: { task_id: 'k1' } }],
    ['a card whose project does not resolve', boardCard],
  ])('refuses %s with 400 GRANT_NOT_ALLOWED, before the challenge is consumed or the PIN checked', async (_label, row) => {
    const { app, session, decide, repos } = build({ findByIdForUser: vi.fn(async () => row) });
    const res = await decideProject(app);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(repos.chatProjectGrants.grant).not.toHaveBeenCalled();
  });

  it('404 for a row this user cannot see and 409 for a decided one, before the challenge or the PIN', async () => {
    const gone = build({ findByIdForUser: vi.fn(async () => undefined) });
    expect((await decideProject(gone.app)).statusCode).toBe(404);
    const done = build({ findByIdForUser: vi.fn(async () => ({ ...boardCard, status: 'approved' })), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    expect((await decideProject(done.app)).statusCode).toBe(409);
    for (const b of [gone, done]) {
      expect(b.session.consumeDecisionChallenge).not.toHaveBeenCalled();
      expect(b.session.checkPin).not.toHaveBeenCalled();
      expect(b.decide).not.toHaveBeenCalled();
    }
  });

  it('without a proof is a 400 (schema), touching nothing', async () => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project' } });
    expect(res.statusCode).toBe(400);
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('POST /chat/actions/:id/decision: terminal grants (TER-325)', () => {
  const keyCard = { ...pendingAction, status: 'pending', tool: 'send_key', args: { tab_id: 't1', key: 'enter' }, tab_id: 't1' };
  const boardCard = { ...pendingAction, status: 'pending', tool: 'move_task', args: { task_id: 'k1', status: 'done' }, tab_id: null };
  const tabs = [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }];
  const post = (app: ReturnType<typeof build>['app'], decision: string) =>
    app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision, challenge: 'ch', pin_proof: 'proof-1' } });

  it('approve_tab_terminal with a proof signed for it decides, replaces the narrow grant and returns grant', async () => {
    const { app, decide, repos, session } = build({ findByIdForUser: vi.fn(async () => keyCard), tabs });
    vi.mocked(repos.chatGrants.findActive).mockResolvedValueOnce({ id: 'g-narrow', conversation_id: 'c1', tab_id: 't1', tool: 'send_input' });
    vi.mocked(repos.chatGrants.revokeTool).mockResolvedValueOnce(1);
    const events: ChatEvent[] = [];
    const unsubscribe = chatBus.subscribe((e) => events.push(e));
    let res;
    try {
      res = await post(app, 'approve_tab_terminal');
    } finally {
      unsubscribe();
    }
    expect(res.statusCode).toBe(200);
    expect(session.consumeDecisionChallenge).toHaveBeenCalledWith(device, 'ch', 'act1');
    expect(session.checkPin).toHaveBeenCalledWith(device, decisionProofMessage('ch', 'act1', 'approve_tab_terminal'), 'proof-1', expect.objectContaining({ ip: expect.any(String) }));
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    expect(repos.chatGrants.revokeTool).toHaveBeenCalledWith('c1', 't1', 'send_input', 'u1');
    expect(repos.chatGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', tab_id: 't1', tool: 'terminal', source_action_id: 'act1', granted_by: 'u1' });
    expect(res.json()).toMatchObject({ queued: true, grant: { tab_id: 't1', tool: 'terminal', tab_name: 'Terminal 1' } });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'grant_revoked', 'grant']));
  });

  it('approve_project_all with a proof signed for it grants the tab\'s project with scope all and returns project_grant', async () => {
    const { app, repos, session } = build({ findByIdForUser: vi.fn(async () => keyCard), tabs, namedProjects: [{ id: 'p1', name: 'App' }] });
    const res = await post(app, 'approve_project_all');
    expect(res.statusCode).toBe(200);
    expect(session.checkPin).toHaveBeenCalledWith(device, decisionProofMessage('ch', 'act1', 'approve_project_all'), 'proof-1', expect.objectContaining({ ip: expect.any(String) }));
    expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', project_id: 'p1', source_action_id: 'act1', granted_by: 'u1', scope: 'all' });
    expect(res.json()).toMatchObject({ queued: true, project_grant: { id: 'pg1', project_id: 'p1', project_name: 'App', scope: 'all' } });
    expect(res.json()).not.toHaveProperty('grant');
  });

  it('approve_project_all on a board card grants its project with scope all', async () => {
    const { app, repos } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    expect((await post(app, 'approve_project_all')).statusCode).toBe(200);
    expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', scope: 'all' }));
  });

  it.each([
    ['approve_tab_terminal', 'approve_tab'],
    ['approve_tab_terminal', 'approve'],
    ['approve_project_all', 'approve_project'],
    ['approve_project_all', 'approve_tab_terminal'],
  ] as const)('%s refuses a proof signed for %s', async (decision, word) => {
    const checkPin = vi.fn(async (_d: unknown, message: string) => (message === decisionProofMessage('ch', 'act1', word) ? { ok: true } : { ok: false, code: 'PIN_INVALID', failures: 1 }));
    const { app, decide, repos } = build({ checkPin, findByIdForUser: vi.fn(async () => keyCard), tabs });
    const res = await post(app, decision);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('PIN_INVALID');
    expect(decide).not.toHaveBeenCalled();
    expect(repos.chatGrants.grant).not.toHaveBeenCalled();
    expect(repos.chatProjectGrants.grant).not.toHaveBeenCalled();
  });

  it.each([
    ['approve_tab_terminal', 'run_command', { ...keyCard, tool: 'run_command', args: { tab_id: 't1', command: 'ls' } }],
    ['approve_tab_terminal', 'a foreign tab', { ...keyCard, tab_id: 't9', args: { tab_id: 't9', key: 'enter' } }],
    ['approve_project_all', 'delete_task', { ...boardCard, tool: 'delete_task', args: { task_id: 'k1' } }],
    ['approve_project_all', 'a foreign tab', { ...keyCard, tab_id: 't9', args: { tab_id: 't9', key: 'enter' } }],
  ])('%s on %s is 400 GRANT_NOT_ALLOWED before the challenge is consumed or the PIN checked', async (decision, _label, row) => {
    const { app, session, decide, repos } = build({ findByIdForUser: vi.fn(async () => row), tabs, boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    const res = await post(app, decision);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(repos.chatGrants.grant).not.toHaveBeenCalled();
    expect(repos.chatProjectGrants.grant).not.toHaveBeenCalled();
  });

  it.each(['approve_tab_terminal', 'approve_project_all'])('%s without a proof is refused (400, schema), touching nothing', async (decision) => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => keyCard), tabs });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision } });
    expect(res.statusCode).toBe(400);
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('POST /chat/actions/:id/decision: approve_project_always (TER-386)', () => {
  const keyCard = { ...pendingAction, status: 'pending', tool: 'send_key', args: { tab_id: 't1', key: 'enter' }, tab_id: 't1' };
  const boardCard = { ...pendingAction, status: 'pending', tool: 'move_task', args: { task_id: 'k1', status: 'done' }, tab_id: null };
  const tabs = [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }];
  const post = (app: ReturnType<typeof build>['app']) =>
    app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project_always', challenge: 'ch', pin_proof: 'proof-1' } });

  it('on a board card, with a proof signed for it, decides, grants standing with no expiry and returns standing_grant', async () => {
    const { app, decide, repos, session } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }], namedProjects: [{ id: 'p1', name: 'App' }] });
    const events: ChatEvent[] = [];
    const unsubscribe = chatBus.subscribe((e) => events.push(e));
    let res;
    try {
      res = await post(app);
    } finally {
      unsubscribe();
    }
    expect(res.statusCode).toBe(200);
    expect(session.consumeDecisionChallenge).toHaveBeenCalledWith(device, 'ch', 'act1');
    expect(session.checkPin).toHaveBeenCalledWith(device, decisionProofMessage('ch', 'act1', 'approve_project_always'), 'proof-1', expect.objectContaining({ ip: expect.any(String) }));
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    expect(repos.chatStandingGrants.grant).toHaveBeenCalledWith({ user_id: 'u1', project_id: 'p1', kind: 'board', conversation_id: 'c1', source_action_id: 'act1' });
    expect(repos.chatProjectGrants.grant).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ queued: true, standing_grant: { id: 'sg1', project_id: 'p1', project_name: 'App', kind: 'board', source_action_id: 'act1' } });
    expect(res.json()).not.toHaveProperty('project_grant');
    expect(res.json()).not.toHaveProperty('grant');
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'standing_grant']));
  });

  it('on a terminal card grants the tab\'s project as a "terminal" standing grant', async () => {
    const { app, repos } = build({ findByIdForUser: vi.fn(async () => keyCard), tabs, namedProjects: [{ id: 'p1', name: 'App' }] });
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    expect(repos.chatStandingGrants.grant).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', kind: 'terminal' }));
    expect(res.json()).toMatchObject({ standing_grant: { kind: 'terminal' } });
  });

  it('a proof signed for approve_project_all is refused for approve_project_always', async () => {
    const checkPin = vi.fn(async (_d: unknown, message: string) => (message === decisionProofMessage('ch', 'act1', 'approve_project_all') ? { ok: true } : { ok: false, code: 'PIN_INVALID', failures: 1 }));
    const { app, decide, repos } = build({ checkPin, findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    const res = await post(app);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('PIN_INVALID');
    expect(decide).not.toHaveBeenCalled();
    expect(repos.chatStandingGrants.grant).not.toHaveBeenCalled();
  });

  it.each([
    ['delete_task', { ...boardCard, tool: 'delete_task', args: { task_id: 'k1' } }],
    ['a foreign tab', { ...keyCard, tab_id: 't9', args: { tab_id: 't9', key: 'enter' } }],
  ])('on %s is 400 GRANT_NOT_ALLOWED before the challenge is consumed or the PIN checked', async (_label, row) => {
    const { app, session, decide, repos } = build({ findByIdForUser: vi.fn(async () => row), tabs, boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    const res = await post(app);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(repos.chatStandingGrants.grant).not.toHaveBeenCalled();
  });

  it('without a proof is refused (400, schema), touching nothing', async () => {
    const { app, session, decide } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project_always' } });
    expect(res.statusCode).toBe(400);
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('whose grant fails still approves and resumes, with no standing_grant in the answer', async () => {
    const { app, decide, repos } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
    vi.mocked(repos.chatStandingGrants.grant).mockRejectedValueOnce(new Error('connection terminated'));
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
    expect(res.json()).not.toHaveProperty('standing_grant');
  });
});

describe('POST /chat/actions/decisions (batch)', () => {
  const rowsOf = (rows: Record<string, { status: string; conversation_id?: string; class?: string }>) =>
    vi.fn(async (id: string) => (rows[id] ? { ...pendingAction, id, conversation_id: 'c1', ...rows[id] } : undefined));
  const decideById = () => vi.fn(async (id: string, _userId: string, status: string) => ({ ...pendingAction, id, status }));
  const post = (app: ReturnType<typeof build>['app'], decisions: unknown[]) => app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions } });

  it('proves the approval, decides both, resumes once and answers queued', async () => {
    const decide = decideById();
    const { app, session, resumeAfterDecision, indexActions } = build({ decide, findByIdForUser: rowsOf({ a1: { status: 'pending' }, a2: { status: 'pending' } }) });
    const res = await post(app, [{ id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' }, { id: 'a2', decision: 'deny' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actions: [{ id: 'a1', status: 'approved' }, { id: 'a2', status: 'denied' }], skipped: [], queued: true, note: 'A decisão foi registrada; a resposta chega pelo chat.' });
    expect(session.consumeDecisionChallenge).toHaveBeenCalledTimes(1);
    expect(session.consumeDecisionChallenge).toHaveBeenCalledWith(device, 'ch1', 'a1');
    expect(session.checkPin).toHaveBeenCalledTimes(1);
    expect(session.checkPin).toHaveBeenCalledWith(device, decisionProofMessage('ch1', 'a1', 'approve'), 'pp1', expect.objectContaining({ ip: expect.any(String) }));
    expect(decide).toHaveBeenCalledWith('a1', 'u1', 'approved');
    expect(decide).toHaveBeenCalledWith('a2', 'u1', 'denied');
    expect(session.checkPin.mock.invocationCallOrder[0]).toBeLessThan(decide.mock.invocationCallOrder[0]);
    expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
    // Memory (spec 2026-09-26 concierge memory §4): the whole decided batch is indexed, fire-and-forget.
    expect(indexActions).toHaveBeenCalledWith('u1', [
      expect.objectContaining({ id: 'a1', status: 'approved' }),
      expect.objectContaining({ id: 'a2', status: 'denied' }),
    ]);
  });

  it('a wrong PIN on the second approval is 401 and decides nothing', async () => {
    const checkPin = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, code: 'PIN_INVALID', failures: 1 });
    const { app, decide, resumeAfterDecision } = build({ checkPin, findByIdForUser: rowsOf({ a1: { status: 'pending' }, a2: { status: 'pending' } }) });
    const res = await post(app, [
      { id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' },
      { id: 'a2', decision: 'approve', challenge: 'ch2', pin_proof: 'pp2' },
    ]);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PIN_INVALID', failures: 1 });
    expect(checkPin).toHaveBeenCalledTimes(2);
    expect(decide).not.toHaveBeenCalled();
    expect(resumeAfterDecision).not.toHaveBeenCalled();
  });

  it('a refused challenge is 400 CHALLENGE_INVALID and decides nothing', async () => {
    const { app, session, decide } = build({ consumeDecisionChallenge: vi.fn(async () => false), findByIdForUser: rowsOf({ a1: { status: 'pending' } }) });
    const res = await post(app, [{ id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' }]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'CHALLENGE_INVALID' });
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('skips an approval no longer pending without spending its challenge', async () => {
    const decide = decideById();
    const { app, session } = build({ decide, findByIdForUser: rowsOf({ a1: { status: 'approved' }, a2: { status: 'pending' } }) });
    const res = await post(app, [
      { id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' },
      { id: 'a2', decision: 'approve', challenge: 'ch2', pin_proof: 'pp2' },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actions: [{ id: 'a2', status: 'approved' }], skipped: [{ id: 'a1', reason: 'already_decided' }] });
    expect(session.consumeDecisionChallenge).toHaveBeenCalledTimes(1);
    expect(session.consumeDecisionChallenge).toHaveBeenCalledWith(device, 'ch2', 'a2');
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('skips an unknown approval without spending its challenge, and lists it in skipped', async () => {
    const decide = decideById();
    const { app, session } = build({ decide, findByIdForUser: rowsOf({ a2: { status: 'pending' } }) });
    const res = await post(app, [
      { id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' },
      { id: 'a2', decision: 'deny' },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actions: [{ id: 'a2', status: 'denied' }], skipped: [{ id: 'a1', reason: 'not_found' }] });
    expect(res.json().skipped).toHaveLength(1);
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalledWith('a1', expect.anything(), expect.anything());
  });

  it('never approves a row whose proof was not checked, even if a later read sees it pending', async () => {
    // First read: a1 is not pending (no proof is checked for it). Every later read says pending.
    const reads = new Map<string, number>();
    const findByIdForUser = vi.fn(async (id: string) => {
      const n = (reads.get(id) ?? 0) + 1;
      reads.set(id, n);
      if (id === 'a1') return n === 1 ? undefined : { ...pendingAction, id, conversation_id: 'c1', status: 'pending' };
      if (id === 'a3') return n === 1 ? { ...pendingAction, id, conversation_id: 'c1', status: 'approved' } : { ...pendingAction, id, conversation_id: 'c1', status: 'pending' };
      return { ...pendingAction, id, conversation_id: 'c1', status: 'pending' };
    });
    const decide = decideById();
    const { app, session } = build({ decide, findByIdForUser });
    const res = await post(app, [
      { id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' },
      { id: 'a2', decision: 'approve', challenge: 'ch2', pin_proof: 'pp2' },
      { id: 'a3', decision: 'approve', challenge: 'ch3', pin_proof: 'pp3' },
    ]);
    expect(res.statusCode).toBe(200);
    expect(session.checkPin).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith('a2', 'u1', 'approved');
    expect(res.json()).toMatchObject({ actions: [{ id: 'a2', status: 'approved' }] });
    expect(res.json().skipped).toEqual(
      expect.arrayContaining([
        { id: 'a1', reason: 'not_found' },
        { id: 'a3', reason: 'already_decided' },
      ])
    );
    expect(res.json().skipped).toHaveLength(2);
  });

  it('nothing left to decide is 409, with no challenge spent and nothing decided', async () => {
    const { app, session, decide, resumeAfterDecision } = build({ findByIdForUser: rowsOf({ a1: { status: 'approved' } }) });
    const res = await post(app, [
      { id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' },
      { id: 'a2', decision: 'deny' },
    ]);
    expect(res.statusCode).toBe(409);
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(resumeAfterDecision).not.toHaveBeenCalled();
  });

  it('a deny-only batch never touches the challenge or the PIN', async () => {
    const decide = decideById();
    const { app, session, resumeAfterDecision } = build({ decide, findByIdForUser: rowsOf({ a1: { status: 'pending' }, a2: { status: 'pending' } }) });
    const res = await post(app, [{ id: 'a1', decision: 'deny' }, { id: 'a2', decision: 'deny' }]);
    expect(res.statusCode).toBe(200);
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
  });

  it('TER-92: write approvals without a proof are decided with no challenge and no PIN work', async () => {
    const decide = decideById();
    const { app, session, resumeAfterDecision } = build({ decide, findByIdForUser: rowsOf({ a1: { status: 'pending' }, a2: { status: 'pending' }, a3: { status: 'pending' } }) });
    const res = await post(app, [{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'approve' }, { id: 'a3', decision: 'deny' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actions: [{ id: 'a1', status: 'approved' }, { id: 'a2', status: 'approved' }, { id: 'a3', status: 'denied' }], skipped: [] });
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
  });

  it('TER-92: an irreversible approval without a proof is 401 PIN_REQUIRED and decides nothing, not even the write one', async () => {
    const decide = decideById();
    const { app, session, resumeAfterDecision } = build({ decide, findByIdForUser: rowsOf({ a1: { status: 'pending' }, a2: { status: 'pending', class: 'irreversible' }, a3: { status: 'pending' } }) });
    const res = await post(app, [{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'approve' }, { id: 'a3', decision: 'deny' }]);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Confirme com o PIN para autorizar esta ação.', code: 'PIN_REQUIRED' });
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(resumeAfterDecision).not.toHaveBeenCalled();
  });

  it('TER-92: a read approval without a proof is PIN_REQUIRED too (only write goes without the PIN)', async () => {
    const { app, decide } = build({ findByIdForUser: rowsOf({ a1: { status: 'pending', class: 'read' } }) });
    const res = await post(app, [{ id: 'a1', decision: 'approve' }]);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PIN_REQUIRED' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('TER-92: an irreversible approval with its proof and a write one without decide together, proving only the first', async () => {
    const decide = decideById();
    const { app, session } = build({ decide, findByIdForUser: rowsOf({ a1: { status: 'pending', class: 'irreversible' }, a2: { status: 'pending' } }) });
    const res = await post(app, [{ id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' }, { id: 'a2', decision: 'approve' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actions: [{ id: 'a1', status: 'approved' }, { id: 'a2', status: 'approved' }] });
    expect(session.consumeDecisionChallenge).toHaveBeenCalledTimes(1);
    expect(session.consumeDecisionChallenge).toHaveBeenCalledWith(device, 'ch1', 'a1');
    expect(session.checkPin).toHaveBeenCalledTimes(1);
  });

  it('TER-92: a write approval sent with a proof (an older app) still has it checked and counted', async () => {
    const { app, decide } = build({ checkPin: vi.fn(async () => ({ ok: false, code: 'PIN_INVALID', failures: 1 })), findByIdForUser: rowsOf({ a1: { status: 'pending' } }) });
    const res = await post(app, [{ id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' }]);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PIN_INVALID' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('half a proof is a 400, and "Permitir sempre" (approve_tab) is never accepted in a batch', async () => {
    const { app, session, decide } = build({ findByIdForUser: rowsOf({ a1: { status: 'pending' } }) });
    expect((await post(app, [{ id: 'a1', decision: 'approve', challenge: 'ch1' }])).statusCode).toBe(400);
    expect((await post(app, [{ id: 'a1', decision: 'approve_tab', challenge: 'ch1', pin_proof: 'pp1' }])).statusCode).toBe(400);
    expect((await post(app, [{ id: 'a1', decision: 'approve_project', challenge: 'ch1', pin_proof: 'pp1' }])).statusCode).toBe(400);
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('mixed conversations are 400 MIXED_CONVERSATIONS before any challenge is consumed', async () => {
    const { app, session, decide } = build({ findByIdForUser: rowsOf({ a1: { status: 'pending' }, a2: { status: 'pending', conversation_id: 'c2' } }) });
    const res = await post(app, [
      { id: 'a1', decision: 'approve', challenge: 'ch1', pin_proof: 'pp1' },
      { id: 'a2', decision: 'deny' },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'MIXED_CONVERSATIONS' });
    expect(session.consumeDecisionChallenge).not.toHaveBeenCalled();
    expect(session.checkPin).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('grants', () => {
  it('DELETE /chat/grants/:id revokes and publishes grant_revoked', async () => {
    const { app, repos } = build();
    const events: ChatEvent[] = [];
    const unsubscribe = chatBus.subscribe((e) => events.push(e));
    let res;
    try {
      res = await app.inject({ method: 'DELETE', url: '/chat/grants/g1' });
    } finally {
      unsubscribe();
    }
    expect(res.statusCode).toBe(200);
    expect(repos.chatGrants.revoke).toHaveBeenCalledWith('g1', 'u1');
    expect(events).toContainEqual(expect.objectContaining({ type: 'grant_revoked', grant_id: 'g1', conversation_id: 'c1' }));
  });

  it('DELETE /chat/grants/:id: 404 for an unknown grant, 409 for one already revoked', async () => {
    const gone = build({ revoke: vi.fn(async () => undefined) });
    expect((await gone.app.inject({ method: 'DELETE', url: '/chat/grants/nope' })).statusCode).toBe(404);
    const done = build({ revoke: vi.fn(async () => undefined), findGrantByIdForUser: vi.fn(async () => ({ id: 'g1', revoked_at: 'x' })) });
    expect((await done.app.inject({ method: 'DELETE', url: '/chat/grants/g1' })).statusCode).toBe(409);
  });

  it('GET /chat returns the conversation\'s active grants with the tab name', async () => {
    const { app } = build({
      grants: [{ id: 'g1', conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: 'a', expires_at: 'b', revoked_at: null, revoked_by: null }],
      tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }],
    });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.json().grants).toEqual([{ id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', created_at: 'a', expires_at: 'b', tab_name: 'Terminal 1' }]);
  });

  it('GET /chat returns the conversation\'s active project grants with the project name', async () => {
    const { app, repos } = build({
      projectGrants: [{ id: 'pg1', conversation_id: 'c1', project_id: 'p1', scope: 'all', source_action_id: 'a1', granted_by: 'u1', created_at: 'x', expires_at: 'y', revoked_at: null, revoked_by: null }],
      namedProjects: [{ id: 'p1', name: 'App' }],
    });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(repos.chatProjectGrants.listActive).toHaveBeenCalledWith('c1');
    expect(res.json().project_grants).toEqual([{ id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: 'x', expires_at: 'y', scope: 'all' }]);
    expect(res.json().grants).toEqual([]);
  });

  it('GET /chat/grants answers the shared contract shape for this user', async () => {
    const row = { id: 'g1', conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-09-26T10:00:00.000Z', revoked_at: null, revoked_by: null, conversation_project_id: null, conversation_archived: false };
    const listForUser = vi.fn(async () => ({ grants: [row], next: null }));
    const { app } = build({ listForUser, tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
    const res = await app.inject({ method: 'GET', url: '/chat/grants?state=active' });
    expect(res.statusCode).toBe(200);
    expect(chatGrantListResponse.safeParse(res.json()).success).toBe(true);
    expect(res.json()).toMatchObject({ grants: [{ id: 'g1', tab_name: 'Terminal 1', state: 'active', ended_at: null }], next_cursor: null });
    // `active` is never paged: the route always asks the repository for GRANT_LIST_MAX (100), not the
    // query's own default of 50, so the default can never silently truncate the active list.
    expect(listForUser).toHaveBeenCalledWith('u1', { state: 'active', cursor: null, limit: 100 }, expect.any(Date));
    expect((await app.inject({ method: 'GET', url: '/chat/grants?state=ended&cursor=nope' })).statusCode).toBe(400);
  });

  it('GET /chat/grants?kinds=all_standing passes through to listGrants (TER-386)', async () => {
    const listForUserStanding = vi.fn(async () => ({ grants: [], next: null }));
    const { app } = build({ listForUserStanding });
    const res = await app.inject({ method: 'GET', url: '/chat/grants?state=ended&kinds=all_standing' });
    expect(res.statusCode).toBe(200);
    expect(chatGrantListResponse.safeParse(res.json()).success).toBe(true);
    expect(listForUserStanding).toHaveBeenCalledWith('u1', { state: 'ended', cursor: null, limit: 50 });
  });

  it('DELETE /chat/grants/:id on a standing id revokes and answers 200 (TER-386)', async () => {
    const revokeStanding = vi.fn(async () => ({ id: 'sg1', user_id: 'u1', project_id: 'p1', kind: 'board', conversation_id: null, source_action_id: 'a0', created_at: 'x', revoked_at: 'now', revoked_by: 'u1' }));
    // Neither the tab- nor the project-grant table matches this id, so `revokeGrant` falls through to
    // the standing table, exactly as it would with a real (non-colliding) id.
    const { app, repos } = build({ revoke: vi.fn(async () => undefined), revokeStanding, namedProjects: [{ id: 'p1', name: 'App' }] });
    const res = await app.inject({ method: 'DELETE', url: '/chat/grants/sg1' });
    expect(res.statusCode).toBe(200);
    expect(repos.chatStandingGrants.revoke).toHaveBeenCalledWith('sg1', 'u1');
    expect(res.json().grant).toMatchObject({ id: 'sg1', project_id: 'p1', kind: 'board' });
  });
});

describe('subagents panel (spec 2026-09-26 §4)', () => {
  it('GET / includes the panel, from the service, alongside the trail', async () => {
    const subagentsFor = vi.fn(async () => [{ id: 'sub1', description: 'Escrever testes', subagent_type: 'general-purpose', status: 'running', started_at: '2026-09-26T12:00:00.000Z', ended_at: null }]);
    const { app } = build({ subagentsFor });
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.statusCode).toBe(200);
    expect(subagentsFor).toHaveBeenCalledWith('c1');
    expect(res.json().subagents).toEqual([{ id: 'sub1', description: 'Escrever testes', subagent_type: 'general-purpose', status: 'running', started_at: '2026-09-26T12:00:00.000Z', ended_at: null }]);
  });

  it('POST /subagents/:id/cancel answers 202 with the row now stopping', async () => {
    const cancelSubagent = vi.fn(async () => ({ id: 'sub1', description: 'Escrever testes', subagent_type: null, status: 'stopping', started_at: '2026-09-26T12:00:00.000Z', ended_at: null }));
    const { app } = build({ cancelSubagent });
    const res = await app.inject({ method: 'POST', url: '/chat/subagents/sub1/cancel' });
    expect(res.statusCode).toBe(202);
    expect(cancelSubagent).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'sub1');
    expect(res.json()).toEqual({ subagent: { id: 'sub1', description: 'Escrever testes', subagent_type: null, status: 'stopping', started_at: '2026-09-26T12:00:00.000Z', ended_at: null } });
  });

  it('POST /subagents/:id/cancel answers 404 for a foreign or missing subagent', async () => {
    const cancelSubagent = vi.fn(async () => { throw new HttpError(404, 'Subagente não encontrado', 'NOT_FOUND'); });
    const { app } = build({ cancelSubagent });
    const res = await app.inject({ method: 'POST', url: '/chat/subagents/nope/cancel' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /subagents/:id/cancel answers 409 when the row is not running or the process is gone', async () => {
    const notRunning = vi.fn(async () => { throw new HttpError(409, 'Este subagente não está rodando', 'SUBAGENT_NOT_RUNNING'); });
    const { app: a1 } = build({ cancelSubagent: notRunning });
    expect((await a1.inject({ method: 'POST', url: '/chat/subagents/sub1/cancel' })).statusCode).toBe(409);

    const gone = vi.fn(async () => { throw new HttpError(409, 'O processo deste subagente já terminou', 'SUBAGENT_GONE'); });
    const { app: a2 } = build({ cancelSubagent: gone });
    const res = await a2.inject({ method: 'POST', url: '/chat/subagents/sub1/cancel' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('SUBAGENT_GONE');
  });

  it('POST /subagents/:id/cancel answers 400 for an id longer than 64 characters, without calling the service', async () => {
    const cancelSubagent = vi.fn(async () => ({ id: 'sub1', description: 'x', subagent_type: null, status: 'stopping', started_at: '', ended_at: null }));
    const { app } = build({ cancelSubagent });
    const res = await app.inject({ method: 'POST', url: `/chat/subagents/${'a'.repeat(65)}/cancel` });
    expect(res.statusCode).toBe(400);
    expect(cancelSubagent).not.toHaveBeenCalled();
  });
});

describe('GET /me', () => {
  it('answers the user, the permissions, this device and the unread count, never the device secrets', async () => {
    const { app, repos } = build();
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(200);
    expect(repos.userNotifications.countUnread).toHaveBeenCalledWith('u1');
    expect(res.json()).toEqual({
      user: { id: 'u1', email: 'ana@example.com', name: 'Ana', nickname: 'ana' },
      permissions: [],
      device: { id: 'd1', name: 'iPhone de Ana', platform: 'ios', model: 'iPhone 15', created_at: '2026-09-19T00:00:00.000Z', last_seen_at: '2026-09-20T00:00:00.000Z' },
      unread_notifications: 3,
    });
    expect(res.body).not.toContain('public_key');
    expect(res.body).not.toContain('pin_secret_enc');
    expect(res.body).not.toContain('secret-hash');
  });
});

describe('POST /chat/tab-questions/:id/auto-answer/cancel (mobile)', () => {
  const countdown = { answer: { answers: [{ selected: [0] }] }, by: 'memory', reason: 'Mesma pergunta respondida antes', sources: [{ kind: 'decision', id: 'd1' }], due_at: '2026-09-26T12:01:00.000Z', status: 'scheduled' };
  const q = { id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: false }] }] }, tool_use_id: null, status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-26T12:00:00.000Z', suggestion: null, auto_answer: countdown, answered_via: null, woken_at: null };
  const setup = (cancelled: unknown) => {
    const built = build({ tabs: [{ id: 't1', project_id: 'p1', name: 'api' }] });
    const tq = built.repos.tabQuestions as Record<string, unknown>;
    tq.findByIdForUser = vi.fn(async (id: string, userId: string) => (id === 'q1' && userId === 'u1' ? q : undefined));
    tq.cancelAutoAnswer = vi.fn(async () => cancelled);
    return { ...built, tq };
  };

  it('cancels the countdown and answers the card', async () => {
    const { app, tq } = setup({ ...q, auto_answer: { ...countdown, status: 'cancelled', decided_by: 'u1' } });
    const events: ChatEvent[] = [];
    const off = chatBus.subscribe((e) => events.push(e));
    const res = await app.inject({ method: 'POST', url: '/chat/tab-questions/q1/auto-answer/cancel' });
    off();
    expect(res.statusCode).toBe(200);
    expect(res.json().tab_question).toMatchObject({ id: 'q1', tab_name: 'api', status: 'open', auto_answer: { status: 'cancelled', answer: { answers: [{ selected: [0] }] } } });
    expect(tq.cancelAutoAnswer).toHaveBeenCalledWith('q1', 'u1');
    expect(events).toEqual([expect.objectContaining({ type: 'tab_question', question: expect.objectContaining({ id: 'q1' }) })]);
    // What the phone parses (`@termhub/mobile-api`).
    const parsed = tabQuestionAutoAnswerCancelResponse.safeParse(res.json());
    expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
  });

  it('404 for a foreign or missing id', async () => {
    const { app, tq } = setup(undefined);
    const res = await app.inject({ method: 'POST', url: '/chat/tab-questions/other/auto-answer/cancel' });
    expect(res.statusCode).toBe(404);
    expect(tq.cancelAutoAnswer).not.toHaveBeenCalled();
  });

  it('409 NOT_SCHEDULED when no countdown is running', async () => {
    const { app } = setup(undefined);
    const res = await app.inject({ method: 'POST', url: '/chat/tab-questions/q1/auto-answer/cancel' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_SCHEDULED');
  });
});
