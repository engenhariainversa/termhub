import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { applyErrorHandler, HttpError } from '../lib/errors.js';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import { chatRoutes } from './chat.js';

const pendingAction = { id: 'act1', conversation_id: 'c1', tool: 'send_input', args: { tab_id: 't1' }, class: 'write', tab_id: 't1', machine_id: null, project_id: null };

function build(opts: {
  send?: ReturnType<typeof vi.fn>;
  start?: ReturnType<typeof vi.fn>;
  startAfterDecision?: ReturnType<typeof vi.fn>;
  reset?: ReturnType<typeof vi.fn>;
  decide?: ReturnType<typeof vi.fn>;
  findByIdForUser?: ReturnType<typeof vi.fn>;
  listByConversation?: ReturnType<typeof vi.fn>;
  conversationFor?: ReturnType<typeof vi.fn>;
  tabs?: { id: string; project_id: string; machine_id?: string; name: string }[];
  projects?: { id: string; owner_id: string; name: string }[];
  machines?: { id: string; name: string }[];
  /** Ids that only ever resolve for this owner — the request's own user id ('u1') unless overridden,
   * matching every one of the fixtures above by default. Used to prove the route scopes by the
   * signed-in user, not an unfiltered read. */
  fixturesOwner?: string;
  hostFor?: ReturnType<typeof vi.fn>;
  /** The machines this user owns, as `findByIdsForOwner` answers them (a host must be an agent one). */
  hostMachines?: { id: string; name: string; type: string }[];
  aiAccounts?: { id: string; provider: string; machine_id: string; config_dir: string | null }[];
  clearProjectSessions?: ReturnType<typeof vi.fn>;
  setHost?: ReturnType<typeof vi.fn>;
  /** Active grants `listActive` answers with, as `GET /chat` returns them. */
  grants?: { id: string; conversation_id: string; tab_id: string; tool: string; source_action_id: string | null; granted_by: string; created_at: string; expires_at: string; revoked_at: string | null; revoked_by: string | null }[];
  revoke?: ReturnType<typeof vi.fn>;
  findGrantByIdForUser?: ReturnType<typeof vi.fn>;
  listForUser?: ReturnType<typeof vi.fn>;
  tabQuestions?: unknown[];
  /** Cards `tasks.findByIdsForOwner` resolves (owner-scoped like the fixtures above): a board call's project. */
  boardTasks?: { id: string; project_id: string }[];
  /** Active project grants `chatProjectGrants.listActive` answers with, as `GET /chat` returns them. */
  projectGrants?: { id: string; conversation_id: string; project_id: string; scope?: 'board' | 'all'; source_action_id: string | null; granted_by: string; created_at: string; expires_at: string; revoked_at: string | null; revoked_by: string | null }[];
  /** Active standing grants `chatStandingGrants.listActive` answers with, as `GET /chat` returns them (TER-386). */
  standingGrants?: { id: string; user_id: string; project_id: string; kind: string; conversation_id: string | null; source_action_id: string | null; created_at: string; revoked_at: string | null; revoked_by: string | null }[];
  revokeStanding?: ReturnType<typeof vi.fn>;
  findStandingGrantByIdForUser?: ReturnType<typeof vi.fn>;
  listForUserStanding?: ReturnType<typeof vi.fn>;
  /** "View as" another owner: the request's own user stays 'u1'. */
  viewAsOwner?: string;
  subagentsFor?: ReturnType<typeof vi.fn>;
  cancelSubagent?: ReturnType<typeof vi.fn>;
  openAnswerIds?: ReturnType<typeof vi.fn>;
} = {}) {
  const send = opts.send ?? vi.fn(async () => ({ id: 'm2', role: 'assistant', text: 'Nada rodando.' }));
  const startAfterDecision = opts.startAfterDecision ?? vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done: Promise.resolve({ id: 'ma' }) }));
  // Kept on the stand-in only to prove the web's decision routes never await a whole run.
  const resumeAfterDecision = vi.fn(async () => ({ id: 'm3', role: 'assistant', text: 'Feito.' }));
  const reset = opts.reset ?? vi.fn(async () => ({ id: 'c_new', project_id: 'p1' }));
  const decide = opts.decide ?? vi.fn(async (_id: string, _userId: string, status: string) => ({ ...pendingAction, status }));
  const findByIdForUser = opts.findByIdForUser ?? vi.fn(async () => undefined);
  const listByConversation = opts.listByConversation ?? vi.fn(async () => []);
  // `cli_session_id: null` explicitly, not left `undefined`: production's `ChatConversation` is always
  // `string | null` here, and the `/host` guard's `!== null` check must be exercised against that same
  // shape, not against a fixture that happens to satisfy it by omission.
  const conversationFor = opts.conversationFor ?? vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: null }));
  const start = opts.start ?? vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done: new Promise(() => {}) }));
  const service = {
    conversationFor,
    send,
    start,
    startAfterDecision,
    resumeAfterDecision,
    reset,
    hostFor: opts.hostFor ?? vi.fn(async () => ({ kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null })),
    projectStatuses: vi.fn(async () => [{ project_id: 'p1', busy: true, pending_confirmations: 1 }]),
    subagentsFor: opts.subagentsFor ?? vi.fn(async () => []),
    cancelSubagent: opts.cancelSubagent ?? vi.fn(async () => ({ id: 'sub1', description: 'Escrever testes', subagent_type: null, status: 'stopping', started_at: '2026-09-26T12:00:00.000Z', ended_at: null })),
    isCompacting: vi.fn(() => false),
    openAnswerIds: opts.openAnswerIds ?? vi.fn(async () => []),
    compact: vi.fn(async () => ({ conversation_id: 'c1', done: Promise.resolve() })),
  };
  const tabs = opts.tabs ?? [];
  const projects = opts.projects ?? [];
  const machines = opts.machines ?? [];
  const fixturesOwner = opts.fixturesOwner ?? 'u1';
  const hostMachines = opts.hostMachines ?? [{ id: 'm1', name: 'jarvis', type: 'agent' }];
  const aiAccounts = opts.aiAccounts ?? [];
  const setHost =
    opts.setHost ??
    vi.fn(async (id: string, host: { machine_id: string; ai_account_id: string | null }) => ({ conversation: { id, user_id: 'u1', cli_session_id: null, ...host }, moved: false }));
  const clearProjectSessions = opts.clearProjectSessions ?? vi.fn(async () => undefined);
  const repos = {
    chat: { listMessages: vi.fn(async () => [{ id: 'm1', role: 'user', text: 'oi' }]), setHost, clearProjectSessions },
    chatActions: { decide, findByIdForUser, listByConversation },
    tabQuestions: { listByConversation: vi.fn(async () => opts.tabQuestions ?? []) },
    tabLimitNotices: { listByConversation: vi.fn(async () => []) },
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === fixturesOwner ? tabs.filter((t) => ids.includes(t.id)) : [])) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === fixturesOwner ? projects.filter((p) => ids.includes(p.id)) : [])) },
    // Both the trail's machine names and the host's own machine, owner-scoped exactly like the
    // repository: an id this user does not own resolves to nothing at all.
    machines: {
      findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => {
        // The trail's own fixtures win when a case defines a machine with the same id, so adding the
        // default host here cannot change what an existing card says.
        const rows = [...machines, ...hostMachines.filter((h) => !machines.some((m) => m.id === h.id))];
        return ownerId === fixturesOwner ? rows.filter((m) => ids.includes(m.id)) : [];
      }),
    },
    aiAccounts: { findById: vi.fn(async (id: string) => aiAccounts.find((a) => a.id === id)) },
    tasks: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === fixturesOwner ? (opts.boardTasks ?? []).filter((t) => ids.includes(t.id)) : [])) },
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
      findActiveBySourceAction: vi.fn(async () => undefined),
      revokeForConversation: vi.fn(async () => 0),
      listForUser: vi.fn(async () => ({ grants: [], next: null })),
    },
    chatDefaultRestrictions: {
      stateForUser: vi.fn(async () => ['open_tab', 'start_agent', 'link_tab_task', 'board', 'terminal', 'close_tab'].map((kind) => ({ kind, allowed: kind !== 'terminal' }))),
      setAllowed: vi.fn(async () => {}),
    },
    // ...and then to standing grants (TER-386): by default none matches either.
    chatStandingGrants: {
      grant: vi.fn(async (input: { user_id: string; project_id: string; kind: string; conversation_id: string | null; source_action_id: string | null }) => ({ id: 'sg1', ...input, created_at: '2026-09-28T10:00:00.000Z', revoked_at: null, revoked_by: null })),
      listActive: vi.fn(async () => opts.standingGrants ?? []),
      findActive: vi.fn(async (): Promise<unknown> => undefined),
      findActiveBySourceAction: vi.fn(async (): Promise<unknown> => undefined),
      revoke: opts.revokeStanding ?? vi.fn(async () => undefined),
      findByIdForUser: opts.findStandingGrantByIdForUser ?? vi.fn(async () => undefined),
      listForUser: opts.listForUserStanding ?? vi.fn(async () => ({ grants: [], next: null })),
    },
  };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    const ownerId = opts.viewAsOwner ?? 'u1';
    (req as unknown as { scope: unknown }).scope = { user: { id: 'u1' }, viewAs: opts.viewAsOwner ? { kind: 'user', userId: ownerId } : { kind: 'self' }, ownerId, createAs: ownerId };
  });
  const indexActions = vi.fn(async () => {});
  app.register((a) => chatRoutes(a, repos as never, { service: service as never, indexActions }), { prefix: '/chat' });
  return { app, service, decide, findByIdForUser, listByConversation, startAfterDecision, resumeAfterDecision, setHost, send, start, repos, indexActions };
}

it('returns the conversation with its messages', async () => {
  const { app } = build();
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ conversation: { id: 'c1' }, messages: [{ id: 'm1', text: 'oi' }] });
});

it('GET / returns the conversation\'s tab questions, named owner-scoped', async () => {
  const q = { id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null, status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z' };
  const { app, repos } = build({ tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], tabQuestions: [q] });
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.json().tab_questions).toEqual([{ id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null, auto_answer: null, answered_via: null, surfaced_at: null, auto_decision: null }]);
  expect(repos.tabQuestions.listByConversation).toHaveBeenCalledWith('c1');
});

it('returns the host state on the same read as the history, so the screen can say it before anything is typed', async () => {
  const { app } = build({ hostFor: vi.fn(async () => ({ kind: 'offline', machine: { id: 'm2', name: 'macbook' } })) });
  const res = await app.inject({ method: 'GET', url: '/chat' });
  // The state, not a sentence: Task 6 renders it, and it carries what that rendering needs.
  expect(res.json().host).toEqual({ kind: 'offline', machine: { id: 'm2', name: 'macbook' } });
});

it('GET / lists the answers still to come, only among the empty rows it returns', async () => {
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

it('GET / answers an empty list when nothing is being answered', async () => {
  const { app } = build();
  expect((await app.inject({ method: 'GET', url: '/chat' })).json().open_answer_ids).toEqual([]);
});

it('sets the host and answers with the conversation and the resolved state', async () => {
  const account = { id: 'acc1', provider: 'claude', machine_id: 'm1', config_dir: '/home/u/.claude-work' };
  const { app, setHost } = build({ aiAccounts: [account] });
  const res = await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1', ai_account_id: 'acc1' } });

  expect(res.statusCode).toBe(200);
  expect(setHost).toHaveBeenCalledWith('c1', { machine_id: 'm1', ai_account_id: 'acc1' });
  expect(res.json()).toMatchObject({ host: { kind: 'ready' } });
});

it('accepts a host with no account: the machine default login', async () => {
  const { app, setHost } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1' } });
  expect(res.statusCode).toBe(200);
  expect(setHost).toHaveBeenCalledWith('c1', { machine_id: 'm1', ai_account_id: null });
});

it('never accepts a machine this user does not own, nor an account that is not on it', async () => {
  const { app, setHost } = build({ aiAccounts: [{ id: 'acc9', provider: 'claude', machine_id: 'm9', config_dir: null }] });

  const foreign = await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm-someone-else' } });
  expect(foreign.statusCode).toBe(404);

  const elsewhere = await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1', ai_account_id: 'acc9' } });
  expect(elsewhere.statusCode).toBe(404);
  expect(setHost).not.toHaveBeenCalled();
});

it('refuses a machine with no agent and an account that is not a Claude login', async () => {
  const ssh = build({ hostMachines: [{ id: 'm1', name: 'vps', type: 'ssh' }] });
  const noAgent = await ssh.app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1' } });
  expect(noAgent.statusCode).toBe(400);
  expect(noAgent.json().code).toBe('CHAT_HOST_NOT_AGENT');
  expect(ssh.setHost).not.toHaveBeenCalled();

  const other = build({ aiAccounts: [{ id: 'acc1', provider: 'chatgpt', machine_id: 'm1', config_dir: null }] });
  const notClaude = await other.app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1', ai_account_id: 'acc1' } });
  expect(notClaude.statusCode).toBe(400);
  expect(other.setHost).not.toHaveBeenCalled();
});

it('rejects a host payload with no machine', async () => {
  const { app, setHost } = build();
  expect((await app.inject({ method: 'POST', url: '/chat/host', payload: {} })).statusCode).toBe(400);
  expect(setHost).not.toHaveBeenCalled();
});

it('returns the trail as sentences enriched with real names, keyed by each row\'s own id — not a raw tool name and ids', async () => {
  // The trail must come from here, not be rebuilt from live events, so a reload still shows it
  // (step 1's bug this task closes) — and every row is keyed by its own id, since a lapsed denial
  // leaves an old decided row beside a newer pending one for the very same proposal.
  const rows = [
    { ...pendingAction, id: 'act1', status: 'pending', args: { tab_id: 't1', text: 'npm test' } },
    { ...pendingAction, id: 'act0', status: 'denied', args: { tab_id: 't1', text: 'rm -rf /' } },
  ];
  const { app } = build({
    listByConversation: vi.fn(async () => rows),
    tabs: [{ id: 't1', project_id: 'p1', machine_id: 'm1', name: 'Terminal 2' }],
    projects: [{ id: 'p1', owner_id: 'u1', name: 'reactivando' }],
    machines: [{ id: 'm1', name: 'macbook m3' }],
  });

  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.statusCode).toBe(200);
  const { actions } = res.json();
  expect(actions).toHaveLength(2);
  const pending = actions.find((a: { id: string }) => a.id === 'act1');
  const denied = actions.find((a: { id: string }) => a.id === 'act0');
  expect(pending).toMatchObject({ id: 'act1', status: 'pending' });
  expect(pending.summary).toBe('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3');
  expect(denied).toMatchObject({ id: 'act0', status: 'denied' });
  expect(denied.summary).toBe('digitar `rm -rf /` na aba Terminal 2 do projeto reactivando, no macbook m3');
});

it('scopes the trail\'s enrichment to the signed-in user: a tab belonging to someone else never names itself on this card', async () => {
  // The security fix: a proposed action naming another user's tab id must read as "does not exist"
  // on this user's screen, not disclose the foreign tab's name — this is a live check that the route
  // passes the request's own user id through to describeActions, not an unscoped read.
  const rows = [{ ...pendingAction, id: 'act1', status: 'pending', args: { tab_id: 't9', text: 'oi' }, tab_id: 't9' }];
  const { app } = build({
    listByConversation: vi.fn(async () => rows),
    tabs: [{ id: 't9', project_id: 'p9', name: 'Aba Alheia' }],
    fixturesOwner: 'someone-else',
  });

  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.statusCode).toBe(200);
  const { actions } = res.json();
  expect(actions[0].summary).toBe('digitar `oi` numa aba que não existe mais');
  expect(actions[0].summary).not.toContain('Aba Alheia');
});

it('answers 202 with the three ids at once when the page says it will not wait', async () => {
  let resolve!: (m: unknown) => void;
  const done = new Promise((r) => (resolve = r));
  const start = vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done }));
  const { app, send } = build({ start });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', project_id: 'p1', wait: false } });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma' });
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'oi', { projectId: 'p1' });
  expect(send).not.toHaveBeenCalled();
  resolve({ id: 'ma' });
});

it('a run that fails after the 202 never becomes an unhandled rejection', async () => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    let reject!: (e: unknown) => void;
    const done = new Promise((_r, rej) => (reject = rej));
    const { app } = build({ start: vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done })) });
    const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', wait: false } });
    expect(res.statusCode).toBe(202);
    reject(new HttpError(502, 'O concierge não respondeu', 'CONCIERGE_FAILED'));
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

it('a refusal from start still answers with its own status when the page does not wait', async () => {
  const { app } = build({ start: vi.fn(async () => { throw new HttpError(409, 'Esta conversa foi encerrada; envie de novo para começar a nova conversa', 'CHAT_ARCHIVED'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', wait: false } });
  expect(res.statusCode).toBe(409);
  expect(res.json().code).toBe('CHAT_ARCHIVED');
});

it('POST /messages answers 202 with the three ids, with or without the flag', async () => {
  // `wait` is read and ignored: a page loaded before this release still sends it, and a caller that
  // forgets it must not hold the request for the whole answer.
  const { app, start, send } = build();
  for (const payload of [{ text: 'oi' }, { text: 'oi', wait: false }]) {
    const res = await app.inject({ method: 'POST', url: '/chat/messages', payload });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma' });
  }
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[0][1]).toBe('oi');
  expect(start.mock.calls[1][1]).toBe('oi');
  expect(send).not.toHaveBeenCalled();
});

it('rejects a wait flag that is not a boolean', async () => {
  const { app } = build();
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', wait: 'no' } })).statusCode).toBe(400);
});

it('rejects an empty or oversized message', async () => {
  const { app } = build();
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: '   ' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'x'.repeat(8001) } })).statusCode).toBe(400);
});

it('passes the service busy error through as 409', async () => {
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build({ start: vi.fn(async () => { throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'segunda' } });
  expect(res.statusCode).toBe(409);
  expect(res.json().code).toBe('CHAT_BUSY');
});

it('surfaces a concierge that is not configured as 503, not as a stored failure', async () => {
  // Merged with no container running, every message would otherwise be answered with a message
  // marked as failed, and the page would say "tente de novo" for ever. The status must reach the
  // browser so it can show the server's own pt-BR explanation.
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build({ start: vi.fn(async () => { throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi' } });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toMatchObject({ code: 'CONCIERGE_DISABLED', error: 'O chat não está configurado neste servidor' });
});

it('surfaces a concierge that did not answer as 502', async () => {
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build({ start: vi.fn(async () => { throw new HttpError(502, 'O concierge não respondeu', 'CONCIERGE_FAILED'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().code).toBe('CONCIERGE_FAILED');
});

it('approves a row the user owns: 200, decided through the repository, and the run is resumed', async () => {
  const { app, decide, startAfterDecision, resumeAfterDecision, indexActions } = build();
  const events: ChatEvent[] = [];
  const unsubscribe = chatBus.subscribe((e) => events.push(e));
  let res;
  try {
    res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
  } finally {
    unsubscribe();
  }

  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
  expect(startAfterDecision.mock.calls[0][0]).toMatchObject({ id: 'u1' });
  expect(startAfterDecision.mock.calls[0][1]).toMatchObject({ id: 'act1', status: 'approved' });
  expect(resumeAfterDecision).not.toHaveBeenCalled();
  // Every open tab must learn of the decision, not only the one that clicked.
  expect(events).toContainEqual({ type: 'decision', user_id: 'u1', conversation_id: 'c1', action_id: 'act1', status: 'approved' });
  // Memory (spec 2026-09-26 concierge memory §4): the decided row is indexed, fire-and-forget.
  expect(indexActions).toHaveBeenCalledWith('u1', [expect.objectContaining({ id: 'act1', status: 'approved' })]);
});

it('denies a row the user owns: 200, decided as denied, and the run is resumed', async () => {
  const { app, decide, startAfterDecision } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'deny' } });

  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'denied');
  expect(startAfterDecision.mock.calls[0][1]).toMatchObject({ id: 'act1', status: 'denied' });
});

it('a decision answers while the run it started is still being written', async () => {
  const done = new Promise(() => {});
  const { app } = build({ startAfterDecision: vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done })) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ action: { id: 'act1', status: 'approved' } });
  expect(res.json().message).toBeUndefined();
});

it('a batch of decisions answers while the run it started is still being written', async () => {
  const done = new Promise(() => {});
  const findByIdForUser = vi.fn(async (id: string) => ({ ...pendingAction, id, status: 'pending' }));
  const decide = vi.fn(async (id: string, _u: string, status: string) => ({ ...pendingAction, id, status }));
  const { app } = build({ findByIdForUser, decide, startAfterDecision: vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done })) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions: [{ id: 'a1', decision: 'approve' }] } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ actions: [{ id: 'a1', status: 'approved' }], skipped: [] });
  expect(res.json().message).toBeUndefined();
});

it('answers 404 for a row that does not exist, or belongs to another user, without ever calling startAfterDecision', async () => {
  // `decide` filters ownership in SQL and returns undefined either way; `findByIdForUser` is scoped
  // the same way (the owning conversation's user_id), so a wrong id or another user's row both come
  // back undefined from it too, and the route answers 404 rather than 409.
  const { app, startAfterDecision, findByIdForUser } = build({ decide: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => undefined) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/nope/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(404);
  expect(findByIdForUser).toHaveBeenCalledWith('nope', 'u1');
  expect(startAfterDecision).not.toHaveBeenCalled();
});

it('answers 409 for a row this user already decided, without deciding it again or resuming', async () => {
  const decided = { ...pendingAction, id: 'act1', status: 'approved' };
  const { app, startAfterDecision } = build({ decide: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => decided) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(409);
  expect(startAfterDecision).not.toHaveBeenCalled();
});

it('answers 400 for an unknown decision value, without touching the repository', async () => {
  const { app, decide } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'maybe' } });

  expect(res.statusCode).toBe(400);
  expect(decide).not.toHaveBeenCalled();
});

it('answers 200 (not 409) when the decision is recorded but a run is busy, and says it will be applied later', async () => {
  // The decision is already durably recorded and already published above this point — a 409 here
  // would tell the client its own successful decision was a conflict. `ChatService.drainNextDecision`
  // picks the row up (still approved/denied, never injected) once the busy run's own lock frees up.
  const { HttpError } = await import('../lib/errors.js');
  const { app, decide } = build({ startAfterDecision: vi.fn(async () => { throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved'); // the decision itself still happened
  expect(res.json()).toMatchObject({ action: { id: 'act1', status: 'approved' }, queued: true });
  expect(res.json().note).toMatch(/registrada/i);
});

it('lets any other startAfterDecision failure through unchanged, not the busy 200', async () => {
  const { app } = build({ startAfterDecision: vi.fn(async () => { throw new Error('boom'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(500);
});

it('GET /?project= reads that project conversation and its host', async () => {
  const { app, service } = build();
  const res = await app.inject({ method: 'GET', url: '/chat?project=p1' });
  expect(res.statusCode).toBe(200);
  expect(service.conversationFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
  expect(service.hostFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
});

it('POST /messages passes project_id through', async () => {
  const { app, start } = build();
  await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', project_id: 'p1' } });
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'oi', { projectId: 'p1' });
});

it('POST /reset archives the scope and answers the fresh conversation', async () => {
  const { app, service } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/reset', payload: { project_id: 'p1' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().conversation.id).toBe('c_new');
  expect(service.reset).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
});

it('POST /reset without project_id resets the account-wide chat', async () => {
  const { app, service } = build();
  await app.inject({ method: 'POST', url: '/chat/reset', payload: {} });
  expect(service.reset).toHaveBeenCalledWith(expect.anything(), null);
});

it('POST /reset is a 409 while busy', async () => {
  const { app } = build({ reset: vi.fn(async () => { throw new HttpError(409, 'ocupado', 'CHAT_BUSY'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/reset', payload: {} });
  expect(res.statusCode).toBe(409);
});

it('GET /projects lists per-project status', async () => {
  const { app } = build();
  const res = await app.inject({ method: 'GET', url: '/chat/projects' });
  expect(res.json()).toEqual({ projects: [{ project_id: 'p1', busy: true, pending_confirmations: 1 }] });
});

it('clears when moved: true, even with no prior session', async () => {
  // The account-wide row had no CLI session to begin with — a user who only uses project chats, or
  // right after "Nova conversa" — so a guard that infers a move from a cli_session_id transition
  // (non-null -> null) would miss this. `moved` is `setHost`'s own verdict and the route must trust
  // it, not re-derive it from the conversation it returns.
  const setHost = vi.fn(async (id: string, host: { machine_id: string; ai_account_id: string | null }) => ({
    conversation: { id, user_id: 'u1', cli_session_id: null, ...host },
    moved: true,
  }));
  const { app, repos } = build({
    conversationFor: vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: null })),
    setHost,
  });
  await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1' } });
  expect(repos.chat.clearProjectSessions).toHaveBeenCalledWith('u1');
});

it('does not clear when moved: false, even if a session existed', async () => {
  // A session existed ('s-old') and `setHost` says the pair did not really move — re-picking the
  // same host the conversation was already running on. Only `setHost` knows this; the route must
  // trust its answer, not assume any host write strands a session.
  const setHost = vi.fn(async (id: string, host: { machine_id: string; ai_account_id: string | null }) => ({
    conversation: { id, user_id: 'u1', cli_session_id: 's-old', ...host },
    moved: false,
  }));
  const { app, repos } = build({
    conversationFor: vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: 's-old' })),
    setHost,
  });
  await app.inject({ method: 'POST', url: '/chat/host', payload: { machine_id: 'm1' } });
  expect(repos.chat.clearProjectSessions).not.toHaveBeenCalled();
});

it('a double click on the same decision still answers 409 the second time, having injected only once', async () => {
  let decided = false;
  const decide = vi.fn(async (_id: string, _userId: string, status: string) => {
    if (decided) return undefined;
    decided = true;
    return { ...pendingAction, status };
  });
  const findByIdForUser = vi.fn(async () => ({ ...pendingAction, status: 'approved' }));
  const { app, startAfterDecision } = build({ decide, findByIdForUser });

  const first = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
  const second = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(409);
  expect(startAfterDecision).toHaveBeenCalledTimes(1); // injected once — the second click never reaches it
});

it('POST /chat/actions/decisions decides the batch and resumes the conversation once', async () => {
  const rows: Record<string, typeof pendingAction & { status: string }> = { a1: { ...pendingAction, id: 'a1', status: 'pending' }, a2: { ...pendingAction, id: 'a2', status: 'pending' } };
  const findByIdForUser = vi.fn(async (id: string) => rows[id]);
  const decide = vi.fn(async (id: string, _u: string, status: string) => ({ ...rows[id], status }));
  const { app, startAfterDecision, indexActions } = build({ findByIdForUser, decide });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions: [{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'deny' }] } });
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('a1', 'u1', 'approved');
  expect(decide).toHaveBeenCalledWith('a2', 'u1', 'denied');
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
  expect(res.json()).toMatchObject({ actions: [{ id: 'a1', status: 'approved' }, { id: 'a2', status: 'denied' }], skipped: [] });
  // Memory (spec 2026-09-26 concierge memory §4): the whole decided batch is indexed, fire-and-forget.
  expect(indexActions).toHaveBeenCalledWith('u1', [expect.objectContaining({ id: 'a1', status: 'approved' }), expect.objectContaining({ id: 'a2', status: 'denied' })]);
});

it('POST /chat/actions/decisions validates the body', async () => {
  const { app, decide } = build();
  for (const payload of [{}, { decisions: [] }, { decisions: [{ id: 'a1', decision: 'approve_tab' }] }, { decisions: [{ id: 'a1', decision: 'approve' }, { id: 'a1', decision: 'deny' }] }, { decisions: Array.from({ length: 21 }, (_, i) => ({ id: `a${i}`, decision: 'deny' })) }]) {
    expect((await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload })).statusCode).toBe(400);
  }
  expect(decide).not.toHaveBeenCalled();
});

it('POST /chat/actions/decisions answers queued when a run holds the conversation', async () => {
  const findByIdForUser = vi.fn(async (id: string) => ({ ...pendingAction, id, status: 'pending' }));
  const startAfterDecision = vi.fn(async () => {
    throw new HttpError(409, 'ocupado', 'CHAT_BUSY');
  });
  const { app } = build({ findByIdForUser, startAfterDecision });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions: [{ id: 'a1', decision: 'approve' }] } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ queued: true });
});

it('approve_tab on an eligible send_input approves it, trusts the tab and says so live', async () => {
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  const eligible = { ...pendingAction, status: 'pending', args: { tab_id: 't1', text: 'oi' } };
  const { app, decide, repos, startAfterDecision } = build({ findByIdForUser: vi.fn(async () => eligible), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
  off();
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(repos.chatGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1' });
  expect(res.json().grant).toMatchObject({ id: 'g1', tab_id: 't1', tab_name: 'Terminal 1', source_action_id: 'act1' });
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'grant']));
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
});

it('approve_tab whose grant fails still approves and resumes, with no grant in the answer or on the bus', async () => {
  // The approval is already decided and published when the grant is written: a failing grant write
  // must not turn it into an error, nor leave the model waiting for a resume that never comes.
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  const eligible = { ...pendingAction, status: 'pending', args: { tab_id: 't1', text: 'oi' } };
  const { app, decide, repos, startAfterDecision } = build({ findByIdForUser: vi.fn(async () => eligible), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
  vi.mocked(repos.chatGrants.grant).mockRejectedValueOnce(new Error('connection terminated'));
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
  off();
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(res.json().action).toMatchObject({ id: 'act1', status: 'approved' });
  expect(res.json()).not.toHaveProperty('grant');
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
  expect(events.map((e) => e.type)).toContain('decision');
  expect(events.map((e) => e.type)).not.toContain('grant');
});

it.each([
  ['answering a permission', { tab_id: 't1', text: '1', answering_permission: true }, 'send_input'],
  ['run_command', { tab_id: 't1', command: 'ls' }, 'run_command'],
])('approve_tab refuses %s with 400 and decides nothing', async (_l, args, tool) => {
  const row = { ...pendingAction, status: 'pending', tool, args };
  const { app, decide, repos } = build({ findByIdForUser: vi.fn(async () => row) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
  expect(decide).not.toHaveBeenCalled();
  expect(repos.chatGrants.grant).not.toHaveBeenCalled();
});

it('approve_tab on a row that is not this user\'s is a 404', async () => {
  const { app, decide } = build({ findByIdForUser: vi.fn(async () => undefined) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
  expect(res.statusCode).toBe(404);
  expect(decide).not.toHaveBeenCalled();
});

it('approve_tab on a row already decided is a 409, deciding nothing and granting nothing', async () => {
  const decided = { ...pendingAction, status: 'approved', args: { tab_id: 't1', text: 'oi' } };
  const { app, decide, repos } = build({ findByIdForUser: vi.fn(async () => decided) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe('Esta ação já foi decidida');
  expect(decide).not.toHaveBeenCalled();
  expect(repos.chatGrants.grant).not.toHaveBeenCalled();
});

const boardCard = { ...pendingAction, status: 'pending', tool: 'move_task', args: { task_id: 'k1', status: 'done' }, tab_id: null };

it('approve_project decides and grants the resolved project, and says so live', async () => {
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  const { app, decide, repos, startAfterDecision } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }], projects: [{ id: 'p1', owner_id: 'u1', name: 'App' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project' } });
  off();
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', project_id: 'p1', source_action_id: 'act1', granted_by: 'u1', scope: 'board' });
  expect(res.json().project_grant).toEqual({ id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'act1', created_at: '2026-09-27T10:00:00.000Z', expires_at: '2026-09-28T10:00:00.000Z', scope: 'board' });
  expect(res.json()).not.toHaveProperty('grant');
  expect(repos.chatGrants.grant).not.toHaveBeenCalled();
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'project_grant']));
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
});

it('approve_project resolves the card with the signed-in user, never the "view as" owner', async () => {
  // The fixtures only resolve for 'u1', the request's own user; the scope's owner is someone else.
  const { app, repos } = build({ viewAsOwner: 'u2', findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project' } });
  expect(res.statusCode).toBe(200);
  expect(repos.tasks.findByIdsForOwner).toHaveBeenCalledWith(['k1'], 'u1');
  expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', granted_by: 'u1' }));
});

it('approve_project whose grant fails still approves and resumes, with no project_grant in the answer', async () => {
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  const { app, decide, repos, startAfterDecision } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
  vi.mocked(repos.chatProjectGrants.grant).mockRejectedValueOnce(new Error('connection terminated'));
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project' } });
  off();
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(res.json()).not.toHaveProperty('project_grant');
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
  expect(events.map((e) => e.type)).not.toContain('project_grant');
});

it('approve_project answers queued with the project grant when a run holds the conversation', async () => {
  const startAfterDecision = vi.fn(async () => {
    throw new HttpError(409, 'ocupado', 'CHAT_BUSY');
  });
  const { app } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }], startAfterDecision });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ queued: true, project_grant: { id: 'pg1', project_id: 'p1' } });
});

it.each([
  ['a non-board card', { ...boardCard, tool: 'delete_task', args: { task_id: 'k1' } }],
  ['a card whose project does not resolve', boardCard],
])('approve_project on %s answers 400 GRANT_NOT_ALLOWED and decides nothing', async (_l, row) => {
  const { app, decide, repos } = build({ findByIdForUser: vi.fn(async () => row) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
  expect(decide).not.toHaveBeenCalled();
  expect(repos.chatProjectGrants.grant).not.toHaveBeenCalled();
});

it('approve_project: 404 for a row that is not this user\'s, 409 for one already decided', async () => {
  const gone = build({ findByIdForUser: vi.fn(async () => undefined) });
  expect((await gone.app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project' } })).statusCode).toBe(404);
  const done = build({ findByIdForUser: vi.fn(async () => ({ ...boardCard, status: 'approved' })), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
  expect((await done.app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project' } })).statusCode).toBe(409);
  expect(gone.decide).not.toHaveBeenCalled();
  expect(done.decide).not.toHaveBeenCalled();
  expect(done.repos.chatProjectGrants.grant).not.toHaveBeenCalled();
});

it('a batch refuses approve_project', async () => {
  const { app, decide } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions: [{ id: 'act1', decision: 'approve_project' }] } });
  expect(res.statusCode).toBe(400);
  expect(decide).not.toHaveBeenCalled();
});

const keyCard = { ...pendingAction, status: 'pending', tool: 'send_key', args: { tab_id: 't1', key: 'enter' }, tab_id: 't1' };

it('approve_tab_terminal decides, replaces the narrow grant with a terminal one and returns grant (TER-325)', async () => {
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  const { app, decide, repos, startAfterDecision } = build({ findByIdForUser: vi.fn(async () => keyCard), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
  vi.mocked(repos.chatGrants.findActive).mockResolvedValueOnce({ id: 'g-narrow', conversation_id: 'c1', tab_id: 't1', tool: 'send_input' });
  vi.mocked(repos.chatGrants.revokeTool).mockResolvedValueOnce(1);
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab_terminal' } });
  off();
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(repos.chatGrants.revokeTool).toHaveBeenCalledWith('c1', 't1', 'send_input', 'u1');
  expect(repos.chatGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', tab_id: 't1', tool: 'terminal', source_action_id: 'act1', granted_by: 'u1' });
  expect(res.json().grant).toMatchObject({ tab_id: 't1', tool: 'terminal', tab_name: 'Terminal 1' });
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'grant_revoked', 'grant']));
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
});

it('approve_tab_terminal whose grant fails still approves and resumes, with no grant in the answer', async () => {
  const { app, decide, repos, startAfterDecision } = build({ findByIdForUser: vi.fn(async () => keyCard), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
  vi.mocked(repos.chatGrants.grant).mockRejectedValueOnce(new Error('connection terminated'));
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab_terminal' } });
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(res.json()).not.toHaveProperty('grant');
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
});

it.each([
  ['run_command', { ...keyCard, tool: 'run_command', args: { tab_id: 't1', command: 'ls' } }],
  ['answering a permission', { ...keyCard, args: { tab_id: 't1', key: '1', answering_permission: true } }],
  ['a tab that is not this user\'s', keyCard],
])('approve_tab_terminal on %s answers 400 GRANT_NOT_ALLOWED and decides nothing', async (_l, row) => {
  const { app, decide, repos } = build({ findByIdForUser: vi.fn(async () => row), tabs: _l === 'a tab that is not this user\'s' ? [] : [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab_terminal' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
  expect(decide).not.toHaveBeenCalled();
  expect(repos.chatGrants.grant).not.toHaveBeenCalled();
});

it('approve_project_all on a terminal card grants the tab\'s project with scope all and returns project_grant (TER-325)', async () => {
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  const { app, decide, repos, startAfterDecision } = build({ findByIdForUser: vi.fn(async () => keyCard), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }], projects: [{ id: 'p1', owner_id: 'u1', name: 'App' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project_all' } });
  off();
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', project_id: 'p1', source_action_id: 'act1', granted_by: 'u1', scope: 'all' });
  expect(res.json().project_grant).toMatchObject({ id: 'pg1', project_id: 'p1', project_name: 'App', scope: 'all' });
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'project_grant']));
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
});

it('approve_project_all on a board card grants the card\'s project with scope all', async () => {
  const { app, repos } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project_all' } });
  expect(res.statusCode).toBe(200);
  expect(repos.chatProjectGrants.grant).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', scope: 'all' }));
});

it.each([
  ['delete_task', { ...boardCard, tool: 'delete_task', args: { task_id: 'k1' } }],
  ['a tab that is not this user\'s', { ...keyCard, tab_id: 't9', args: { tab_id: 't9', key: 'enter' } }],
])('approve_project_all on %s answers 400 GRANT_NOT_ALLOWED and decides nothing', async (_l, row) => {
  const { app, decide, repos } = build({ findByIdForUser: vi.fn(async () => row), boardTasks: [{ id: 'k1', project_id: 'p1' }], tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project_all' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
  expect(decide).not.toHaveBeenCalled();
  expect(repos.chatProjectGrants.grant).not.toHaveBeenCalled();
});

it.each(['approve_tab_terminal', 'approve_project_all'])('a batch refuses %s', async (decision) => {
  const { app, decide } = build({ findByIdForUser: vi.fn(async () => keyCard), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions: [{ id: 'act1', decision }] } });
  expect(res.statusCode).toBe(400);
  expect(decide).not.toHaveBeenCalled();
});

it('approve_project_always on a board card decides, grants standing with no expiry and returns standing_grant (TER-386)', async () => {
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  const { app, decide, repos, startAfterDecision } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }], projects: [{ id: 'p1', owner_id: 'u1', name: 'App' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project_always' } });
  off();
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(repos.chatStandingGrants.grant).toHaveBeenCalledWith({ user_id: 'u1', project_id: 'p1', kind: 'board', conversation_id: 'c1', source_action_id: 'act1' });
  expect(res.json().standing_grant).toMatchObject({ id: 'sg1', project_id: 'p1', project_name: 'App', kind: 'board', source_action_id: 'act1' });
  expect(res.json()).not.toHaveProperty('grant');
  expect(res.json()).not.toHaveProperty('project_grant');
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'standing_grant']));
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
});

it('approve_project_always on a terminal card grants the tab\'s project as a "terminal" standing grant', async () => {
  const { app, repos } = build({ findByIdForUser: vi.fn(async () => keyCard), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }], projects: [{ id: 'p1', owner_id: 'u1', name: 'App' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project_always' } });
  expect(res.statusCode).toBe(200);
  expect(repos.chatStandingGrants.grant).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', kind: 'terminal' }));
  expect(res.json().standing_grant).toMatchObject({ kind: 'terminal' });
});

it.each([
  ['delete_task', { ...boardCard, tool: 'delete_task', args: { task_id: 'k1' } }],
  ['a tab that is not this user\'s', keyCard],
])('approve_project_always on %s answers 400 GRANT_NOT_ALLOWED and decides nothing', async (_l, row) => {
  const { app, decide, repos } = build({ findByIdForUser: vi.fn(async () => row), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project_always' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('GRANT_NOT_ALLOWED');
  expect(decide).not.toHaveBeenCalled();
  expect(repos.chatStandingGrants.grant).not.toHaveBeenCalled();
});

it('approve_project_always whose grant fails still approves and resumes, with no standing_grant in the answer', async () => {
  const { app, decide, repos, startAfterDecision } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
  vi.mocked(repos.chatStandingGrants.grant).mockRejectedValueOnce(new Error('connection terminated'));
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_project_always' } });
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(res.json()).not.toHaveProperty('standing_grant');
  expect(startAfterDecision).toHaveBeenCalledTimes(1);
});

it('a batch refuses approve_project_always', async () => {
  const { app, decide } = build({ findByIdForUser: vi.fn(async () => boardCard), boardTasks: [{ id: 'k1', project_id: 'p1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/decisions', payload: { decisions: [{ id: 'act1', decision: 'approve_project_always' }] } });
  expect(res.statusCode).toBe(400);
  expect(decide).not.toHaveBeenCalled();
});

it('GET /chat returns the conversation\'s active standing grants, scoped to the conversation\'s project', async () => {
  const { app, repos } = build({
    conversationFor: vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: null, project_id: 'p1' })),
    standingGrants: [{ id: 'sg1', user_id: 'u1', project_id: 'p1', kind: 'board', conversation_id: 'c0', source_action_id: 'a0', created_at: 'x', revoked_at: null, revoked_by: null }],
    projects: [{ id: 'p1', owner_id: 'u1', name: 'App' }],
  });
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(repos.chatStandingGrants.listActive).toHaveBeenCalledWith('u1', 'p1');
  expect(res.json().standing_grants).toEqual([{ id: 'sg1', project_id: 'p1', project_name: 'App', kind: 'board', source_action_id: 'a0', created_at: 'x' }]);
});

it('GET /chat with no project (general chat) reads every one of the user\'s standing grants', async () => {
  const { app, repos } = build({
    conversationFor: vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: null, project_id: null })),
  });
  await app.inject({ method: 'GET', url: '/chat' });
  expect(repos.chatStandingGrants.listActive).toHaveBeenCalledWith('u1', undefined);
});

it('GET /chat/grants?kinds=all_standing passes through to listGrants', async () => {
  const listForUserStanding = vi.fn(async () => ({ grants: [], next: null }));
  const { app } = build({ listForUserStanding });
  const res = await app.inject({ method: 'GET', url: '/chat/grants?state=ended&kinds=all_standing' });
  expect(res.statusCode).toBe(200);
  expect(listForUserStanding).toHaveBeenCalledWith('u1', { state: 'ended', cursor: null, limit: 50 });
});

it('DELETE /chat/grants/:id on a standing id revokes and answers 200', async () => {
  const revokeStanding = vi.fn(async () => ({ id: 'sg1', user_id: 'u1', project_id: 'p1', kind: 'board', conversation_id: null, source_action_id: 'a0', created_at: 'x', revoked_at: 'now', revoked_by: 'u1' }));
  // Neither the tab- nor the project-grant table matches this id, so `revokeGrant` falls through to
  // the standing table, exactly as it would with a real (non-colliding) id.
  const { app, repos } = build({ revoke: vi.fn(async () => undefined), revokeStanding, projects: [{ id: 'p1', owner_id: 'u1', name: 'App' }] });
  const res = await app.inject({ method: 'DELETE', url: '/chat/grants/sg1' });
  expect(res.statusCode).toBe(200);
  expect(repos.chatStandingGrants.revoke).toHaveBeenCalledWith('sg1', 'u1');
  expect(res.json().grant).toMatchObject({ id: 'sg1', project_id: 'p1', kind: 'board' });
});

it('GET /chat returns the conversation\'s active project grants with the project name', async () => {
  const { app, repos } = build({
    projectGrants: [{ id: 'pg1', conversation_id: 'c1', project_id: 'p1', scope: 'all', source_action_id: 'a1', granted_by: 'u1', created_at: 'x', expires_at: 'y', revoked_at: null, revoked_by: null }],
    projects: [{ id: 'p1', owner_id: 'u1', name: 'App' }],
  });
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(repos.chatProjectGrants.listActive).toHaveBeenCalledWith('c1');
  expect(res.json().project_grants).toEqual([{ id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: 'x', expires_at: 'y', scope: 'all' }]);
  expect(res.json().grants).toEqual([]);
});

it('DELETE /chat/grants/:id revokes and says so live', async () => {
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  const { app, repos } = build();
  const res = await app.inject({ method: 'DELETE', url: '/chat/grants/g1' });
  off();
  expect(res.statusCode).toBe(200);
  expect(repos.chatGrants.revoke).toHaveBeenCalledWith('g1', 'u1');
  expect(events).toContainEqual(expect.objectContaining({ type: 'grant_revoked', grant_id: 'g1', conversation_id: 'c1' }));
});

it('DELETE /chat/grants/:id: 404 when unknown, 409 when already revoked', async () => {
  const gone = build({ revoke: vi.fn(async () => undefined) });
  expect((await gone.app.inject({ method: 'DELETE', url: '/chat/grants/nope' })).statusCode).toBe(404);
  const done = build({ revoke: vi.fn(async () => undefined), findGrantByIdForUser: vi.fn(async () => ({ id: 'g1', revoked_at: 'x' })) });
  expect((await done.app.inject({ method: 'DELETE', url: '/chat/grants/g1' })).statusCode).toBe(409);
});

it('GET /chat returns the conversation\'s active grants with the tab name', async () => {
  const { app } = build({ grants: [{ id: 'g1', conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: 'a', expires_at: 'b', revoked_at: null, revoked_by: null }], tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.json().grants).toEqual([{ id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', created_at: 'a', expires_at: 'b', tab_name: 'Terminal 1' }]);
});

it('GET / keeps suggestions out of tab_questions and lists them in tab_suggestions', async () => {
  const common = { tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', tool_use_id: null, answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z' };
  const q = { ...common, id: 'q1', kind: 'permission', payload: { tool_name: 'Bash' }, status: 'open' };
  const s = { ...common, id: 's1', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open' };
  const { app } = build({ tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], tabQuestions: [q, s] });
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.json().tab_questions.map((x: { id: string }) => x.id)).toEqual(['q1']);
  expect(res.json().tab_suggestions).toEqual([{ id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it', context: null }, status: 'open', answer: null, error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null, auto_answer: null, answered_via: null, surfaced_at: null, auto_decision: null }]);
});

const listedRow = { id: 'g1', conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', revoked_at: '2026-09-25T12:00:00.000Z', revoked_by: 'u1', conversation_project_id: null, conversation_archived: false };

it('GET /chat/grants lists this user\'s grants, named, with a cursor for the next page', async () => {
  const listForUser = vi.fn(async () => ({ grants: [listedRow], next: { created_at: listedRow.created_at, id: 'g1' } }));
  const { app } = build({ listForUser, tabs: [{ id: 't1', project_id: 'p1', name: 'api' }], projects: [{ id: 'p1', owner_id: 'u1', name: 'termhub' }] });
  const res = await app.inject({ method: 'GET', url: '/chat/grants?state=ended' });
  expect(res.statusCode).toBe(200);
  expect(listForUser).toHaveBeenCalledWith('u1', { state: 'ended', cursor: null, limit: 50 }, expect.any(Date));
  const body = res.json();
  expect(body.grants[0]).toMatchObject({ id: 'g1', tab_name: 'api', project_name: 'termhub', conversation_project_name: null, state: 'revoked', ended_at: listedRow.revoked_at });
  expect(typeof body.next_cursor).toBe('string');
  await app.inject({ method: 'GET', url: `/chat/grants?state=ended&cursor=${body.next_cursor}` });
  expect(listForUser).toHaveBeenLastCalledWith('u1', { state: 'ended', cursor: { created_at: listedRow.created_at, id: 'g1' }, limit: 50 }, expect.any(Date));
});

it('GET /chat/grants: 400 without a valid state, with a bad cursor or a limit out of range', async () => {
  const listForUser = vi.fn(async () => ({ grants: [], next: null }));
  const { app } = build({ listForUser });
  for (const url of ['/chat/grants', '/chat/grants?state=all', '/chat/grants?state=ended&cursor=nope', '/chat/grants?state=ended&limit=0', '/chat/grants?state=ended&limit=101']) {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400);
  }
  expect(listForUser).not.toHaveBeenCalled();
});

it('POST /messages passes attachment_ids to the service and allows an empty text with them', async () => {
  const { app, start } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: '', attachment_ids: ['a1', 'a2'] } });
  expect(res.statusCode).toBe(202);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), '', { projectId: null, attachmentIds: ['a1', 'a2'] });
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: '', attachment_ids: [] } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { attachment_ids: [] } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', attachment_ids: ['1', '2', '3', '4', '5', '6'] } })).statusCode).toBe(400);
});

it('POST /messages passes reply_to_id to the service (TER-447)', async () => {
  const { app, start } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'faz de novo', reply_to_id: 'm7' } });
  expect(res.statusCode).toBe(202);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'faz de novo', { projectId: null, replyToId: 'm7' });
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', reply_to_id: '' } })).statusCode).toBe(400);
});

it('POST /messages passes reply_to_card to the service, never together with reply_to_id (TER-849)', async () => {
  const { app, start } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'por quê?', reply_to_card: { kind: 'action', id: 'a7' } } });
  expect(res.statusCode).toBe(202);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'por quê?', { projectId: null, replyToCard: { kind: 'action', id: 'a7' } });
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', reply_to_card: { kind: 'tab_suggestion', id: 'q1' } } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', reply_to_id: 'm7', reply_to_card: { kind: 'action', id: 'a7' } } })).statusCode).toBe(400);
});

it('POST /messages answers 409 ATTACHMENT_UNAVAILABLE as the service throws it', async () => {
  const { app } = build({ start: vi.fn(async () => { throw new HttpError(409, 'Um dos anexos não está disponível: envie de novo', 'ATTACHMENT_UNAVAILABLE'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', attachment_ids: ['gone'] } });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: 'Um dos anexos não está disponível: envie de novo', code: 'ATTACHMENT_UNAVAILABLE' });
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

  it('GET / carries an empty panel when nothing is running', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.json().subagents).toEqual([]);
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

it('GET / says whether the conversation is being compacted', async () => {
  const { app, service } = build();
  expect((await app.inject({ method: 'GET', url: '/chat' })).json().compacting).toBe(false);
  service.isCompacting.mockReturnValue(true);
  expect((await app.inject({ method: 'GET', url: '/chat' })).json().compacting).toBe(true);
  expect(service.isCompacting).toHaveBeenCalledWith('c1');
});

it('POST /compact starts the compaction of the scope and answers 202', async () => {
  const { app, service } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/compact', payload: { project_id: 'p1' } });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ conversation_id: 'c1' });
  expect(service.compact).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1');
  await app.inject({ method: 'POST', url: '/chat/compact' });
  expect(service.compact).toHaveBeenLastCalledWith(expect.anything(), null);
});

it('POST /compact passes the service refusal through with its code', async () => {
  const { app, service } = build();
  service.compact.mockRejectedValueOnce(new HttpError(409, 'Ainda não há contexto para compactar nesta conversa', 'CHAT_NOTHING_TO_COMPACT'));
  const res = await app.inject({ method: 'POST', url: '/chat/compact', payload: {} });
  expect(res.statusCode).toBe(409);
  expect(res.json().code).toBe('CHAT_NOTHING_TO_COMPACT');
});

describe('POST /chat/tab-questions/:id/auto-answer/cancel (web)', () => {
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

describe('default allowances (TER-627)', () => {
  it('GET /defaults lists every kind with its label and whether it is on for the caller', async () => {
    const { app, repos } = build();
    const res = await app.inject({ method: 'GET', url: '/chat/defaults' });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaults).toHaveLength(6);
    expect(res.json().defaults).toContainEqual({ kind: 'terminal', allowed: false, label: 'teclas e texto nas abas de agente' });
    expect(res.json().defaults).toContainEqual({ kind: 'close_tab', allowed: true, label: 'fechar abas paradas' });
    expect(repos.chatDefaultRestrictions.stateForUser).toHaveBeenCalledWith('u1');
  });

  it('PUT /defaults/:kind turns one kind off for the caller and answers the new list', async () => {
    const { app, repos } = build();
    const res = await app.inject({ method: 'PUT', url: '/chat/defaults/board', payload: { allowed: false } });
    expect(res.statusCode).toBe(200);
    expect(repos.chatDefaultRestrictions.setAllowed).toHaveBeenCalledWith('u1', 'board', false);
    expect(res.json().defaults).toHaveLength(6);
  });

  it.each([
    ['/chat/defaults/run_command', { allowed: true }],
    ['/chat/defaults/delete_task', { allowed: true }],
    ['/chat/defaults/board', { allowed: 'yes' }],
    ['/chat/defaults/board', {}],
  ])('PUT %s %j is a 400 and changes nothing', async (url, payload) => {
    const { app, repos } = build();
    const res = await app.inject({ method: 'PUT', url, payload });
    expect(res.statusCode).toBe(400);
    expect(repos.chatDefaultRestrictions.setAllowed).not.toHaveBeenCalled();
  });
});
