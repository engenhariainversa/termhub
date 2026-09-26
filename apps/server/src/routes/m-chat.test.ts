import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { chatGrantListResponse, decisionProofMessage } from '@termhub/mobile-api';
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
} = {}) {
  const extraProjects = opts.extraProjects ?? [];
  const decide = opts.decide ?? vi.fn(async (_id: string, _userId: string, status: string) => ({ ...pendingAction, status }));
  const findByIdForUser = opts.findByIdForUser ?? vi.fn(async () => ({ ...pendingAction, status: 'pending' }));
  const resumeAfterDecision = opts.resumeAfterDecision ?? vi.fn(async () => ({ id: 'm3', role: 'assistant', text: 'Feito.' }));
  const start =
    opts.start ??
    vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done: new Promise(() => undefined) }));
  const service = {
    conversationFor: vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: null })),
    start,
    resumeAfterDecision,
    reset: opts.reset ?? vi.fn(async () => ({ id: 'c_new', project_id: 'p1' })),
    hostFor: vi.fn(async () => ({ kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null })),
    projectStatuses: vi.fn(async () => opts.projectStatuses ?? [{ project_id: 'p1', busy: true, pending_confirmations: 2 }]),
  };
  const session = {
    checkPin: opts.checkPin ?? vi.fn(async () => ({ ok: true })),
    consumeDecisionChallenge: opts.consumeDecisionChallenge ?? vi.fn(async () => true),
  };
  const agents = {
    capabilities: vi.fn((id: string) => (id === 'm1' ? ['chat'] : null)),
    info: vi.fn((id: string) => (id === 'm1' ? { agent_version: '0.9.0' } : null)),
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
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[]) => (opts.tabs ?? []).filter((t) => ids.includes(t.id))) },
    chatGrants: {
      grant: vi.fn(async (input: { conversation_id: string; tab_id: string; tool: string; source_action_id: string; granted_by: string }) => ({ id: 'g1', ...input, created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', revoked_at: null, revoked_by: null })),
      listActive: vi.fn(async () => opts.grants ?? []),
      revoke: opts.revoke ?? vi.fn(async (id: string) => ({ id, conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: '', expires_at: '', revoked_at: 'now', revoked_by: 'u1' })),
      findByIdForUser: opts.findGrantByIdForUser ?? vi.fn(async () => undefined),
      listForUser: opts.listForUser ?? vi.fn(async () => ({ grants: [], next: null })),
    },
    projects: {
      findByIdsForOwner: vi.fn(async () => []),
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
    tasks: { findByIdsForOwner: vi.fn(async () => []) },
    userNotifications: { countUnread: vi.fn(async () => 3) },
    roles: { findById: vi.fn(async () => undefined), permissionsOf: vi.fn(async () => []) },
  };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    req.mobile = { device, user } as never;
  });
  app.register((a) => mobileChatRoutes(a, repos as never, { chat: service as never, agents, session: session as never }), { prefix: '/chat' });
  app.register((a) => mobileMeRoutes(a, repos as never), { prefix: '' });
  return { app, service, session, agents, repos, decide, findByIdForUser, resumeAfterDecision, start, setHost };
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
    expect(res.json().tab_suggestions).toEqual([expect.objectContaining({ id: 's1', kind: 'suggestion', payload: { text: 'commit it' } })]);
  });

  it('?project= reads that project conversation and its host', async () => {
    const { app, service } = build();
    const res = await app.inject({ method: 'GET', url: '/chat?project=p1' });
    expect(res.statusCode).toBe(200);
    expect(service.conversationFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
    expect(service.hostFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
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
        { id: 'p1', name: 'reactivando', key: 'REA', busy: true, pending_confirmations: 2, last_message_at: '2026-09-23T10:00:00.000Z' },
        { id: 'p2', name: 'termhub', key: 'TH', busy: false, pending_confirmations: 0, last_message_at: null },
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
});

describe('POST /chat/actions/:id/decision', () => {
  it('deny: decides, publishes the event and resumes, with no PIN involvement', async () => {
    const { app, decide, resumeAfterDecision, session } = build();
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

describe('POST /chat/actions/decisions (batch)', () => {
  const rowsOf = (rows: Record<string, { status: string; conversation_id?: string }>) =>
    vi.fn(async (id: string) => (rows[id] ? { ...pendingAction, id, conversation_id: 'c1', ...rows[id] } : undefined));
  const decideById = () => vi.fn(async (id: string, _userId: string, status: string) => ({ ...pendingAction, id, status }));
  const post = (app: ReturnType<typeof build>['app'], decisions: unknown[]) => app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions } });

  it('proves the approval, decides both, resumes once and answers queued', async () => {
    const decide = decideById();
    const { app, session, resumeAfterDecision } = build({ decide, findByIdForUser: rowsOf({ a1: { status: 'pending' }, a2: { status: 'pending' } }) });
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
