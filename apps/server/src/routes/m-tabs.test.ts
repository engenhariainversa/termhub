import Fastify from 'fastify';
import { tabChatPage, tabsResponse } from '@termhub/mobile-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionForMethod } from '../auth/permissions.js';
import { ControlError } from '../control/context.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { applyErrorHandler, HttpError } from '../lib/errors.js';
import type { Page } from '../tab-chat/reader.js';

const sendInput = vi.fn(async (_ctx: unknown, input: { tab_id: string }) => ({ tab_id: input.tab_id, sent: true }));
const sendKey = vi.fn(async (_ctx: unknown, input: { tab_id: string; key: string }) => ({ tab_id: input.tab_id, key: input.key, sent: true }));
vi.mock('../control/terminals.js', () => ({ sendInput: (...a: unknown[]) => sendInput(...(a as [never, never])), sendKey: (...a: unknown[]) => sendKey(...(a as [never, never])) }));
const startAgent = vi.fn(async (..._a: unknown[]) => ({ tab_id: 't9' }));
vi.mock('../control/agents.js', () => ({ startAgent: (...a: unknown[]) => startAgent(...a) }));
const readScreen = vi.fn(async (..._a: unknown[]) => ({ tab_id: 't1', lines: 30, text: '', styled: false }));
vi.mock('../control/screen.js', () => ({ readScreen: (...a: unknown[]) => readScreen(...a) }));
const saveFileOnMachine = vi.fn(async (_m: unknown, data: Buffer, name: string) => ({ path: `/home/u/.cache/termhub/paste/${name}`, name, bytes: data.length, mime: 'application/octet-stream' }));
vi.mock('../terminal/paste-file.js', () => ({ saveFileOnMachine: (...a: unknown[]) => saveFileOnMachine(...(a as [never, Buffer, string])) }));
const agentState = { online: true, caps: ['transcript'] as string[] | null };
vi.mock('../agent/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../agent/registry.js')>();
  return { ...real, agents: { isOnline: () => agentState.online, capabilities: () => agentState.caps, info: () => null, awaitAgent: async () => agentState.online } };
});

const { mobileTabRoutes, WAITING_PERMISSION_MESSAGE } = await import('./m-tabs.js');

const SID = '11111111-2222-4333-8444-555555555555';
const user = { id: 'u1', email: 'ana@example.com', name: 'Ana' };
const project = { id: 'p1', key: 'TH', name: 'termhub', owner_id: 'u1' } as Project;
const machine = { id: 'm1', name: 'box', type: 'agent', owner_id: 'u1' } as Machine;
const foreignProject = { id: 'p2', key: 'XX', name: 'other', owner_id: 'u2' } as Project;
const tabRow = (o: Partial<Tab> = {}) =>
  ({
    id: 't1',
    name: 'api',
    project_id: 'p1',
    machine_id: 'm1',
    kind: 'terminal',
    tmux_session: 'th-t1',
    state: 'waiting_input',
    state_at: '2026-10-01T10:00:00.000Z',
    state_seen_at: null,
    state_tool: 'claude',
    activity: null,
    activity_verb: null,
    agent_session_id: SID,
    agent_transcript_path: `/h/.claude/projects/-w/${SID}.jsonl`,
    ...o,
  }) as Tab;
const question = (o: Record<string, unknown>) => ({
  id: 'q1',
  tab_id: 't1',
  project_id: 'p1',
  conversation_id: 'c1',
  user_id: 'u1',
  kind: 'permission',
  payload: { tool_name: 'Bash', summary: 'npm test', options: [] },
  tool_use_id: null,
  status: 'open',
  answer: null,
  error_code: null,
  answered_by: null,
  answered_at: null,
  closed_at: null,
  injected_at: null,
  created_at: '2026-10-01T10:00:00.000Z',
  suggestion: null,
  auto_answer: null,
  answered_via: null,
  surfaced_at: null,
  ...o,
});

function build(opts: { grants?: string[]; tabs?: Tab[]; readPage?: (...a: unknown[]) => Promise<Page>; questions?: unknown[] } = {}) {
  const grants = new Set(opts.grants ?? ['terminals:read', 'terminals:write']);
  const tabs = opts.tabs ?? [tabRow(), tabRow({ id: 't2', project_id: 'p2' })];
  const repos = {
    tabs: {
      findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)),
      findByIdsForOwner: vi.fn(async (ids: string[]) => tabs.filter((t) => ids.includes(t.id))),
      listOpenTerminals: vi.fn(async (_owner: string | null) => tabs),
    },
    projects: { findById: vi.fn(async (id: string) => [project, foreignProject].find((p) => p.id === id)), list: vi.fn(async () => [project]) },
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? machine : undefined)), list: vi.fn(async () => [machine]) },
    projectMachines: { find: vi.fn(async (p: string, m: string) => ({ id: 'pm', project_id: p, machine_id: m, cwd: '/w' })) },
    tabQuestions: { listOpenForTab: vi.fn(async (_tab: string, _user: string) => opts.questions ?? []) },
    chatDecisions: {},
  };
  const readPage = vi.fn(opts.readPage ?? (async () => ({ items: [], before: null, live: `${SID}.0`, mode: null, degraded: false, missing: false })));
  const hub = { poke: vi.fn() };
  const logged: unknown[] = [];
  const app = Fastify({ logger: { level: 'debug', stream: { write: (line: string) => logged.push(line) } } });
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    // what the mobile auth hook does with the config `guardedMobile` sets
    const cfg = req.routeOptions.config as { resource?: string; action?: string };
    if (cfg.resource && !grants.has(`${cfg.resource}:${cfg.action}`)) throw new HttpError(403, `Sem permissão: ${cfg.resource}:${cfg.action}`, 'FORBIDDEN');
  });
  app.register(
    async (a) => {
      a.addHook('onRoute', (route) => {
        const cfg = (route.config ?? {}) as { action?: string };
        route.config = { ...cfg, resource: 'terminals', action: cfg.action ?? actionForMethod(String(route.method)) } as never;
      });
      await mobileTabRoutes(a, repos as never, { hub: hub as never, readPage: readPage as never, modeSettleMs: 0 });
    },
    { prefix: '/tabs' },
  );
  return { app, repos, readPage, hub, logged };
}

afterEach(() => {
  vi.clearAllMocks();
  agentState.online = true;
  agentState.caps = ['transcript'];
});

describe('GET /tabs', () => {
  it("lists the scope's terminal tabs with their availability", async () => {
    const { app, repos } = build();
    const res = await app.inject({ method: 'GET', url: '/tabs' });
    expect(res.statusCode).toBe(200);
    const body = tabsResponse.parse(res.json());
    // t2's project is not in the scope's list: it is left out
    expect(body.tabs.map((t) => [t.id, t.availability, t.project.key, t.machine.name])).toEqual([['t1', 'ready', 'TH', 'box']]);
    expect(repos.tabs.listOpenTerminals).toHaveBeenCalledWith('u1');
    expect(repos.projects.list).toHaveBeenCalledWith({ owner: 'u1' });
    expect(repos.machines.list).toHaveBeenCalledWith('u1');
  });

  it('says why a tab cannot be opened', async () => {
    agentState.caps = ['claude'];
    const { app } = build();
    expect((await app.inject({ method: 'GET', url: '/tabs' })).json().tabs[0].availability).toBe('agent_outdated');
  });

  it('needs terminals:read', async () => {
    const { app } = build({ grants: [] });
    expect((await app.inject({ method: 'GET', url: '/tabs' })).statusCode).toBe(403);
  });
});

describe('POST /tabs', () => {
  it('starts Claude Code in a new tab and answers its id', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/tabs', payload: { project_id: 'p1', machine_id: 'm1', prompt: 'faz o deploy' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tab_id: 't9' });
    expect(startAgent).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ ownerId: 'u1' }) }), { project_id: 'p1', machine_id: 'm1', prompt: 'faz o deploy' });
  });

  it('needs terminals:write', async () => {
    const { app } = build({ grants: ['terminals:read'] });
    expect((await app.inject({ method: 'POST', url: '/tabs', payload: { project_id: 'p1', prompt: 'x' } })).statusCode).toBe(403);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it("a refusal of startAgent answers 409 with its message", async () => {
    startAgent.mockRejectedValueOnce(new ControlError('ACCOUNT_REQUIRED', 'Escolha a conta'));
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/tabs', payload: { project_id: 'p1', prompt: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Escolha a conta', code: 'ACCOUNT_REQUIRED' });
  });

  it('a prompt over 4000 characters answers 400', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'POST', url: '/tabs', payload: { project_id: 'p1', prompt: 'x'.repeat(4001) } })).statusCode).toBe(400);
  });
});

describe('GET /tabs/:id/chat', () => {
  it('a tab outside the scope answers 404', async () => {
    const { app, readPage } = build();
    expect((await app.inject({ method: 'GET', url: '/tabs/t2/chat' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/tabs/nope/chat' })).statusCode).toBe(404);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("a ready tab returns the page, its mode and the tab's open cards", async () => {
    const item = { kind: 'assistant', id: 'u1:0', at: '', text: 'Olá' };
    const { app, readPage, repos } = build({
      readPage: async () => ({ items: [item as never], before: `${SID}.10`, live: `${SID}.400`, mode: 'plan', degraded: true, missing: false }),
      questions: [question({}), question({ id: 'q2', kind: 'suggestion', payload: { text: 'rodar os testes', context: null } })],
    });
    const res = await app.inject({ method: 'GET', url: `/tabs/t1/chat?before=${SID}.99` });
    expect(res.statusCode).toBe(200);
    const page = tabChatPage.parse(res.json());
    expect(page).toMatchObject({ session_id: SID, items: [item], before: `${SID}.10`, live: `${SID}.400`, mode: 'plan', degraded: true, tab: { id: 't1', availability: 'ready' } });
    expect(page.questions.map((q) => q.id)).toEqual(['q1']);
    expect(page.suggestions.map((q) => q.id)).toEqual(['q2']);
    expect(readPage).toHaveBeenCalledWith(machine, expect.objectContaining({ id: 't1' }), `${SID}.99`);
    expect(repos.tabQuestions.listOpenForTab).toHaveBeenCalledWith('t1', 'u1');
  });

  it('a tab that is not ready returns an empty page with why, and never reads', async () => {
    agentState.online = false;
    const { app, readPage } = build();
    const page = (await app.inject({ method: 'GET', url: '/tabs/t1/chat' })).json();
    expect(page).toMatchObject({ items: [], before: null, live: null, tab: { availability: 'offline' } });
    expect(readPage).not.toHaveBeenCalled();
  });

  it('a transcript that is gone reads as no session; an agent that left mid-read as offline', async () => {
    const missing = build({ readPage: async () => ({ items: [], before: null, live: null, mode: null, degraded: false, missing: true }) });
    expect((await missing.app.inject({ method: 'GET', url: '/tabs/t1/chat' })).json().tab.availability).toBe('no_session');
    const gone = build({
      readPage: async () => {
        throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
      },
    });
    const res = await gone.app.inject({ method: 'GET', url: '/tabs/t1/chat' });
    expect(res.statusCode).toBe(200);
    expect(res.json().tab.availability).toBe('offline');
  });
});

describe('POST /tabs/:id/chat/messages', () => {
  it('types the text into the tab and logs only its length', async () => {
    const { app, hub, logged } = build();
    const res = await app.inject({ method: 'POST', url: '/tabs/t1/chat/messages', payload: { text: 'segredo do deploy' } });
    expect(res.statusCode).toBe(200);
    expect(sendInput).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', text: 'segredo do deploy' });
    expect(hub.poke).toHaveBeenCalledWith('t1');
    expect(logged.join('')).toContain('"textLen":17');
    expect(logged.join('')).not.toContain('segredo');
  });

  it('a tab waiting on a permission answers 409 WAITING_PERMISSION, pointing at the card', async () => {
    sendInput.mockRejectedValueOnce(new ControlError('WAITING_PERMISSION', 'Esta aba está esperando uma permissão: "x". Se a sua resposta…'));
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/tabs/t1/chat/messages', payload: { text: 'oi' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: WAITING_PERMISSION_MESSAGE, code: 'WAITING_PERMISSION' });
    expect(WAITING_PERMISSION_MESSAGE).toBe('Responda a pergunta acima antes de enviar uma mensagem');
  });

  it('an offline machine answers 503', async () => {
    sendInput.mockRejectedValueOnce(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
    const { app } = build();
    expect((await app.inject({ method: 'POST', url: '/tabs/t1/chat/messages', payload: { text: 'oi' } })).statusCode).toBe(503);
  });

  it('needs terminals:write, the scope and a text of at most 4000 characters', async () => {
    expect((await build({ grants: ['terminals:read'] }).app.inject({ method: 'POST', url: '/tabs/t1/chat/messages', payload: { text: 'oi' } })).statusCode).toBe(403);
    const { app } = build();
    expect((await app.inject({ method: 'POST', url: '/tabs/t2/chat/messages', payload: { text: 'oi' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/tabs/t1/chat/messages', payload: { text: 'x'.repeat(4001) } })).statusCode).toBe(400);
    expect(sendInput).not.toHaveBeenCalled();
  });
});

describe('POST /tabs/:id/chat/actions', () => {
  const act = (app: ReturnType<typeof build>['app'], action: string) => app.inject({ method: 'POST', url: '/tabs/t1/chat/actions', payload: { action } });

  it('interrupt presses Escape; clear and compact type their command', async () => {
    const { app } = build();
    expect((await act(app, 'interrupt')).json()).toEqual({ done: true, mode: null });
    expect(sendKey).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', key: 'Escape' });
    await act(app, 'clear');
    expect(sendInput).toHaveBeenLastCalledWith(expect.anything(), { tab_id: 't1', text: '/clear' });
    await act(app, 'compact');
    expect(sendInput).toHaveBeenLastCalledWith(expect.anything(), { tab_id: 't1', text: '/compact' });
  });

  it('cycle_mode presses Shift+Tab and answers the mode the footer shows', async () => {
    readScreen.mockResolvedValueOnce({ tab_id: 't1', lines: 30, text: ['● ok', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏸ plan mode on (shift+tab to cycle)'].join('\n'), styled: false });
    const { app } = build();
    const res = await act(app, 'cycle_mode');
    expect(res.json()).toEqual({ done: true, mode: 'plan' });
    expect(sendKey).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', key: 'BTab' });
    expect(readScreen).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', lines: 30 }, { plain: true });
  });

  it('cycle_mode on an agent without the capability answers 409 and sends no key', async () => {
    agentState.caps = ['claude'];
    const { app } = build();
    const res = await act(app, 'cycle_mode');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_OUTDATED');
    expect(sendKey).not.toHaveBeenCalled();
  });

  it('an action outside the list answers 400; any action needs terminals:write', async () => {
    expect((await act(build().app, 'reboot')).statusCode).toBe(400);
    expect((await act(build({ grants: ['terminals:read'] }).app, 'interrupt')).statusCode).toBe(403);
  });
});

describe('POST /tabs/:id/chat/files', () => {
  const upload = (app: ReturnType<typeof build>['app'], body: Buffer, url = '/tabs/t1/chat/files?name=foto.png') =>
    app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'image/png' } });

  it('saves the file on the tab’s machine and answers its path', async () => {
    const { app } = build();
    const res = await upload(app, Buffer.from('png bytes'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: '/home/u/.cache/termhub/paste/foto.png', name: 'foto.png' });
    expect(saveFileOnMachine).toHaveBeenCalledWith(machine, Buffer.from('png bytes'), 'foto.png');
  });

  it('refuses an empty body, a missing name and a body over 20 MB', async () => {
    const { app } = build();
    expect((await upload(app, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await upload(app, Buffer.from('x'), '/tabs/t1/chat/files')).statusCode).toBe(400);
    expect((await upload(app, Buffer.alloc(20 * 1024 * 1024 + 1))).statusCode).toBe(413);
    expect(saveFileOnMachine).not.toHaveBeenCalled();
  });

  it('needs terminals:write', async () => {
    expect((await upload(build({ grants: ['terminals:read'] }).app, Buffer.from('x'))).statusCode).toBe(403);
  });
});

describe('GET /tabs/:id/screen', () => {
  it('reads the last lines of the pane as plain text', async () => {
    readScreen.mockResolvedValueOnce({ tab_id: 't1', lines: 80, text: '$ ls', styled: false });
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/tabs/t1/screen?lines=80' });
    expect(res.json()).toEqual({ text: '$ ls' });
    expect(readScreen).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', lines: 80 }, { plain: true });
  });

  it('more than 200 lines answers 400', async () => {
    expect((await build().app.inject({ method: 'GET', url: '/tabs/t1/screen?lines=500' })).statusCode).toBe(400);
  });
});
