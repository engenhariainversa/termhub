import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { applyErrorHandler, HttpError } from '../lib/errors.js';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import { chatRoutes } from './chat.js';

const pendingAction = { id: 'act1', conversation_id: 'c1', tool: 'send_input', args: { tab_id: 't1' }, class: 'write', tab_id: 't1', machine_id: null, project_id: null };

function build(opts: {
  send?: ReturnType<typeof vi.fn>;
  resumeAfterDecision?: ReturnType<typeof vi.fn>;
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
} = {}) {
  const send = opts.send ?? vi.fn(async () => ({ id: 'm2', role: 'assistant', text: 'Nada rodando.' }));
  const resumeAfterDecision = opts.resumeAfterDecision ?? vi.fn(async () => ({ id: 'm3', role: 'assistant', text: 'Feito.' }));
  const reset = opts.reset ?? vi.fn(async () => ({ id: 'c_new', project_id: 'p1' }));
  const decide = opts.decide ?? vi.fn(async (_id: string, _userId: string, status: string) => ({ ...pendingAction, status }));
  const findByIdForUser = opts.findByIdForUser ?? vi.fn(async () => undefined);
  const listByConversation = opts.listByConversation ?? vi.fn(async () => []);
  // `cli_session_id: null` explicitly, not left `undefined`: production's `ChatConversation` is always
  // `string | null` here, and the `/host` guard's `!== null` check must be exercised against that same
  // shape, not against a fixture that happens to satisfy it by omission.
  const conversationFor = opts.conversationFor ?? vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false, machine_id: 'm1', ai_account_id: null, cli_session_id: null }));
  const service = {
    conversationFor,
    send,
    resumeAfterDecision,
    reset,
    hostFor: opts.hostFor ?? vi.fn(async () => ({ kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null })),
    projectStatuses: vi.fn(async () => [{ project_id: 'p1', busy: true, pending_confirmations: 1 }]),
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
    tasks: { findByIdsForOwner: vi.fn(async () => []) },
    chatGrants: {
      grant: vi.fn(async (input: { conversation_id: string; tab_id: string; tool: string; source_action_id: string; granted_by: string }) => ({ id: 'g1', ...input, created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', revoked_at: null, revoked_by: null })),
      listActive: vi.fn(async () => opts.grants ?? []),
      revoke: opts.revoke ?? vi.fn(async (id: string) => ({ id, conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1', created_at: '', expires_at: '', revoked_at: 'now', revoked_by: 'u1' })),
      findByIdForUser: opts.findGrantByIdForUser ?? vi.fn(async () => undefined),
    },
  };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user: { id: 'u1' }, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  app.register((a) => chatRoutes(a, repos as never, { service: service as never }), { prefix: '/chat' });
  return { app, service, decide, findByIdForUser, listByConversation, resumeAfterDecision, setHost, send, repos };
}

it('returns the conversation with its messages', async () => {
  const { app } = build();
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ conversation: { id: 'c1' }, messages: [{ id: 'm1', text: 'oi' }] });
});

it('returns the host state on the same read as the history, so the screen can say it before anything is typed', async () => {
  const { app } = build({ hostFor: vi.fn(async () => ({ kind: 'offline', machine: { id: 'm2', name: 'macbook' } })) });
  const res = await app.inject({ method: 'GET', url: '/chat' });
  // The state, not a sentence: Task 6 renders it, and it carries what that rendering needs.
  expect(res.json().host).toEqual({ kind: 'offline', machine: { id: 'm2', name: 'macbook' } });
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

it('sends a message and answers with the assistant row', async () => {
  const { app, service } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'o que está rodando?' } });
  expect(res.statusCode).toBe(201);
  expect(res.json().message.text).toBe('Nada rodando.');
  expect(service.send.mock.calls[0][1]).toBe('o que está rodando?');
});

it('rejects an empty or oversized message', async () => {
  const { app } = build();
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: '   ' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'x'.repeat(8001) } })).statusCode).toBe(400);
});

it('passes the service busy error through as 409', async () => {
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build({ send: vi.fn(async () => { throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'segunda' } });
  expect(res.statusCode).toBe(409);
  expect(res.json().code).toBe('CHAT_BUSY');
});

it('surfaces a concierge that is not configured as 503, not as a stored failure', async () => {
  // Merged with no container running, every message would otherwise be answered 201 with a message
  // marked as failed, and the page would say "tente de novo" for ever. The status must reach the
  // browser so it can show the server's own pt-BR explanation.
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build({ send: vi.fn(async () => { throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi' } });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toMatchObject({ code: 'CONCIERGE_DISABLED', error: 'O chat não está configurado neste servidor' });
});

it('surfaces a concierge that did not answer as 502', async () => {
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build({ send: vi.fn(async () => { throw new HttpError(502, 'O concierge não respondeu', 'CONCIERGE_FAILED'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().code).toBe('CONCIERGE_FAILED');
});

it('approves a row the user owns: 200, decided through the repository, and the run is resumed', async () => {
  const { app, decide, resumeAfterDecision } = build();
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
  expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
  expect(resumeAfterDecision.mock.calls[0][0]).toMatchObject({ id: 'u1' });
  expect(resumeAfterDecision.mock.calls[0][1]).toMatchObject({ id: 'act1', status: 'approved' });
  // Every open tab must learn of the decision, not only the one that clicked.
  expect(events).toContainEqual({ type: 'decision', user_id: 'u1', conversation_id: 'c1', action_id: 'act1', status: 'approved' });
});

it('denies a row the user owns: 200, decided as denied, and the run is resumed', async () => {
  const { app, decide, resumeAfterDecision } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'deny' } });

  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'denied');
  expect(resumeAfterDecision.mock.calls[0][1]).toMatchObject({ id: 'act1', status: 'denied' });
});

it('answers 404 for a row that does not exist, or belongs to another user, without ever calling resumeAfterDecision', async () => {
  // `decide` filters ownership in SQL and returns undefined either way; `findByIdForUser` is scoped
  // the same way (the owning conversation's user_id), so a wrong id or another user's row both come
  // back undefined from it too, and the route answers 404 rather than 409.
  const { app, resumeAfterDecision, findByIdForUser } = build({ decide: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => undefined) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/nope/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(404);
  expect(findByIdForUser).toHaveBeenCalledWith('nope', 'u1');
  expect(resumeAfterDecision).not.toHaveBeenCalled();
});

it('answers 409 for a row this user already decided, without deciding it again or resuming', async () => {
  const decided = { ...pendingAction, id: 'act1', status: 'approved' };
  const { app, resumeAfterDecision } = build({ decide: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => decided) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(409);
  expect(resumeAfterDecision).not.toHaveBeenCalled();
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
  const { app, decide } = build({ resumeAfterDecision: vi.fn(async () => { throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved'); // the decision itself still happened
  expect(res.json()).toMatchObject({ action: { id: 'act1', status: 'approved' }, queued: true });
  expect(res.json().note).toMatch(/registrada/i);
});

it('lets any other resumeAfterDecision failure through unchanged, not the busy 200', async () => {
  const { app } = build({ resumeAfterDecision: vi.fn(async () => { throw new Error('boom'); }) });
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
  const { app, send } = build();
  await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi', project_id: 'p1' } });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'oi', { projectId: 'p1' });
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
  const { app, resumeAfterDecision } = build({ decide, findByIdForUser });

  const first = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
  const second = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(409);
  expect(resumeAfterDecision).toHaveBeenCalledTimes(1); // injected once — the second click never reaches it
});

it('approve_tab on an eligible send_input approves it, trusts the tab and says so live', async () => {
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  const eligible = { ...pendingAction, status: 'pending', args: { tab_id: 't1', text: 'oi' } };
  const { app, decide, repos, resumeAfterDecision } = build({ findByIdForUser: vi.fn(async () => eligible), tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 1' }] });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve_tab' } });
  off();
  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(repos.chatGrants.grant).toHaveBeenCalledWith({ conversation_id: 'c1', tab_id: 't1', tool: 'send_input', source_action_id: 'act1', granted_by: 'u1' });
  expect(res.json().grant).toMatchObject({ id: 'g1', tab_id: 't1', tab_name: 'Terminal 1', source_action_id: 'act1' });
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision', 'grant']));
  expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
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
