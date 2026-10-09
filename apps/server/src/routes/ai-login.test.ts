import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiLoginResumeResponse, aiLoginStartResponse, aiLoginStatusResponse, aiLoginSubmitResponse } from '@termhub/mobile-api';

const rpc = vi.fn();
const online = new Set<string>();
const caps = new Map<string, string[]>();
vi.mock('../agent/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/registry.js')>()),
  agents: {
    rpc: (...a: unknown[]) => rpc(...a),
    awaitAgent: async (m: { id: string }) => online.has(m.id),
    isOnline: (id: string) => online.has(id),
    capabilities: (id: string) => caps.get(id) ?? null,
    info: (id: string) => (online.has(id) ? { agent_version: '0.26.0', os: 'macos', tools: [], connected_at: '' } : null),
  },
}));
const screens = new Map<string, string>();
vi.mock('../agent/screen.js', () => ({ captureScreen: vi.fn(async (_m: unknown, session: string) => screens.get(session) ?? '') }));
const sendInput = vi.fn(async (_ctx: unknown, input: { tab_id: string }) => ({ tab_id: input.tab_id, sent: true as const }));
vi.mock('../control/terminals.js', () => ({ sendInput: (...a: unknown[]) => sendInput(...(a as [unknown, { tab_id: string }])) }));
const canAccess = vi.fn(async () => true);
vi.mock('../auth/permissions.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../auth/permissions.js')>()), canAccess: () => canAccess() }));

const { applyErrorHandler } = await import('../lib/errors.js');
const { aiLoginRoutes } = await import('./ai-login.js');
const { aiLogin, LOGIN_FLOW_TTL_MS } = await import('../ai/login.js');

const machines = [
  { id: 'm1', name: 'jarvis', type: 'agent', owner_id: 'u1' },
  { id: 'm2', name: 'hulk', type: 'agent', owner_id: 'u1' },
  { id: 'ms', name: 'ssh box', type: 'ssh', owner_id: 'u1' },
];
const acc = (id: string, machine_id: string, provider = 'claude', config_dir: string | null = null) => ({ id, label: `conta ${id}`, provider, machine_id, config_dir, exclusive_project: null, created_at: '' });
const accounts = [acc('a1', 'm1'), acc('a2', 'm1', 'claude', '~/.claude-2'), acc('c1', 'm2', 'chatgpt'), acc('g1', 'm1', 'gemini'), acc('s1', 'ms')];
const tab = (id: string, ai_account_id: string | null, machine_id = 'm1', kind = 'terminal') => ({ id, name: `aba ${id}`, project_id: 'p1', machine_id, kind, tmux_session: `th-${id}`, ai_account_id });
const tabs = [tab('t1', 'a1'), tab('t2', null), tab('t3', 'a2'), tab('t4', 'a1'), tab('t5', 'a1', 'm1', 'simulator')];

/** `viewer`: the signed-in user; `ownerId`: the scope (an admin "viewing as" u1 has viewer admin). */
function build(opts: { viewer?: string; prefix?: string } = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  const viewer = opts.viewer ?? 'u1';
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: viewer, role_id: 'r' } as never, viewAs: viewer === 'u1' ? { kind: 'self' } : ({ kind: 'user', user: { id: 'u1' } } as never), ownerId: 'u1', createAs: 'u1' };
  });
  const repos = {
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)), list: vi.fn(async () => machines) },
    aiAccounts: { findById: vi.fn(async (id: string) => accounts.find((a) => a.id === id)), list: vi.fn(async () => accounts) },
    tabs: { listByMachine: vi.fn(async (id: string) => tabs.filter((t) => t.machine_id === id)) },
  };
  app.register((a) => aiLoginRoutes(a, repos as never), { prefix: opts.prefix ?? '/ai-accounts' });
  return app;
}

const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=abc';

beforeEach(() => {
  rpc.mockReset();
  sendInput.mockClear();
  canAccess.mockReset().mockResolvedValue(true);
  online.clear();
  online.add('m1').add('m2');
  caps.clear();
  caps.set('m1', ['ai_login']).set('m2', ['ai_login']);
  screens.clear();
});
afterEach(() => {
  aiLogin.stop();
  vi.useRealTimers();
});

describe('POST /ai-accounts/:id/login', () => {
  it('starts the login in a hidden termhub-login-<id> session and answers the url', async () => {
    rpc.mockResolvedValueOnce({ url: CLAUDE_URL, user_code: null, needs_code: true });
    const res = await build().inject({ method: 'POST', url: '/ai-accounts/a2/login' });
    expect(res.statusCode).toBe(200);
    const body = aiLoginStartResponse.parse(res.json());
    expect(body).toMatchObject({ url: CLAUDE_URL, user_code: null, needs_code: true });
    expect(body.login_id).toMatch(/^[a-f0-9]{24}$/);
    expect(rpc).toHaveBeenCalledWith('m1', 'ai.login.start', { provider: 'claude', config_dir: '~/.claude-2', session: `termhub-login-${body.login_id}` });
  });

  it('the CLI finished on its own in the machine\'s browser: logged in, no flow left, stuck tabs listed (TER-1054)', async () => {
    aiLogin.markLoginRequired('a1');
    screens.set('th-t1', 'Please run /login');
    rpc.mockResolvedValueOnce({ url: null, user_code: null, needs_code: false, logged_in: true });
    const res = await build().inject({ method: 'POST', url: '/ai-accounts/a1/login' });
    expect(res.statusCode).toBe(200);
    expect(aiLoginStartResponse.parse(res.json())).toMatchObject({ url: null, logged_in: true, stuck_tabs: [{ id: 't1', name: 'aba t1', project_id: 'p1' }] });
    expect(aiLogin.loginStatusOf('a1').state).toBe('ok');
    expect(aiLogin.openFlows).toBe(0);
  });

  it('refuses an admin viewing as the owner: only the machine owner redoes the login', async () => {
    const res = await build({ viewer: 'admin' }).inject({ method: 'POST', url: '/ai-accounts/a1/login' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Só a dona da máquina pode refazer o login');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers 409 AGENT_OUTDATED when the agent does not claim ai_login', async () => {
    caps.set('m1', []);
    const res = await build().inject({ method: 'POST', url: '/ai-accounts/a1/login' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_OUTDATED');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses a machine without the agent, and a provider the agent cannot drive', async () => {
    const ssh = await build().inject({ method: 'POST', url: '/ai-accounts/s1/login' });
    expect(ssh.statusCode).toBe(400);
    expect(ssh.json().code).toBe('UNSUPPORTED_MACHINE');
    const gemini = await build().inject({ method: 'POST', url: '/ai-accounts/g1/login' });
    expect(gemini.statusCode).toBe(400);
    expect(gemini.json().code).toBe('UNSUPPORTED_PROVIDER');
    expect(gemini.json().error).toContain('Run `gemini`');
  });

  it('a new start cancels the account’s previous flow', async () => {
    rpc.mockResolvedValue({ url: CLAUDE_URL, user_code: null, needs_code: true });
    const app = build();
    const first = (await app.inject({ method: 'POST', url: '/ai-accounts/a1/login' })).json();
    rpc.mockClear();
    await app.inject({ method: 'POST', url: '/ai-accounts/a1/login' });
    expect(rpc).toHaveBeenCalledWith('m1', 'ai.login.cancel', { session: `termhub-login-${first.login_id}` });
    expect(aiLogin.openFlows).toBe(1);
  });
});

describe('POST /ai-accounts/:id/login/:loginId/submit', () => {
  it('Claude: sends the code, marks the account ok and lists the tabs stuck on the login error', async () => {
    rpc.mockResolvedValueOnce({ url: CLAUDE_URL, user_code: null, needs_code: true });
    const app = build();
    const { login_id } = (await app.inject({ method: 'POST', url: '/ai-accounts/a1/login' })).json();
    screens.set('th-t1', 'some output\nPlease run /login · API Error: 401');
    screens.set('th-t2', 'Login expired · Please run /login'); // the default login: a1 has no config dir
    screens.set('th-t3', 'Please run /login'); // another account
    screens.set('th-t4', 'all good');
    rpc.mockResolvedValueOnce({ logged_in: true, message: null });
    const res = await app.inject({ method: 'POST', url: `/ai-accounts/a1/login/${login_id}/submit`, payload: { code: '  abc#def  ' } });
    expect(res.statusCode).toBe(200);
    const body = aiLoginSubmitResponse.parse(res.json());
    expect(body).toEqual({ ok: true, message: null, stuck_tabs: [{ id: 't1', name: 'aba t1', project_id: 'p1' }, { id: 't2', name: 'aba t2', project_id: 'p1' }] });
    expect(rpc).toHaveBeenCalledWith('m1', 'ai.login.submit', { provider: 'claude', config_dir: null, session: `termhub-login-${login_id}`, code: 'abc#def' });
    expect(JSON.stringify(res.json())).not.toContain('abc#def');
    expect(aiLogin.loginStatusOf('a1').state).toBe('ok');
    expect(aiLogin.openFlows).toBe(0);
  });

  it('Claude: a submit without a code waits for a login finished in the machine\'s browser (TER-1054)', async () => {
    rpc.mockResolvedValueOnce({ url: CLAUDE_URL, user_code: null, needs_code: true });
    const app = build();
    const { login_id } = (await app.inject({ method: 'POST', url: '/ai-accounts/a1/login' })).json();
    rpc.mockResolvedValueOnce({ logged_in: true, message: null });
    const res = await app.inject({ method: 'POST', url: `/ai-accounts/a1/login/${login_id}/submit`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenLastCalledWith('m1', 'ai.login.submit', { provider: 'claude', config_dir: null, session: `termhub-login-${login_id}`, code: null });
    expect(aiLogin.loginStatusOf('a1').state).toBe('ok');
  });

  it('Claude: a wrong code ends the flow', async () => {
    rpc.mockResolvedValueOnce({ url: CLAUDE_URL, user_code: null, needs_code: true });
    const app = build();
    const { login_id } = (await app.inject({ method: 'POST', url: '/ai-accounts/a1/login' })).json();
    rpc.mockResolvedValueOnce({ logged_in: false, message: 'Invalid code' });
    const failed = await app.inject({ method: 'POST', url: `/ai-accounts/a1/login/${login_id}/submit`, payload: { code: 'wrong' } });
    expect(failed.json()).toEqual({ ok: false, message: 'Invalid code', stuck_tabs: [] });
    const again = await app.inject({ method: 'POST', url: `/ai-accounts/a1/login/${login_id}/submit`, payload: { code: 'wrong' } });
    expect(again.statusCode).toBe(404);
  });

  it('Codex: submits with a null code; a timeout keeps the flow so the person can submit again', async () => {
    rpc.mockResolvedValueOnce({ url: 'https://auth.openai.com/codex/device', user_code: 'LCWQ-WSPV8', needs_code: false });
    const app = build();
    const started = (await app.inject({ method: 'POST', url: '/ai-accounts/c1/login' })).json();
    expect(started).toMatchObject({ user_code: 'LCWQ-WSPV8', needs_code: false });
    rpc.mockResolvedValueOnce({ logged_in: false, message: 'Timed out waiting for the login to finish' });
    const waiting = await app.inject({ method: 'POST', url: `/ai-accounts/c1/login/${started.login_id}/submit`, payload: { code: null } });
    expect(waiting.json()).toEqual({ ok: false, message: 'Timed out waiting for the login to finish', stuck_tabs: [] });
    expect(rpc).toHaveBeenLastCalledWith('m2', 'ai.login.submit', { provider: 'chatgpt', config_dir: null, session: `termhub-login-${started.login_id}`, code: null });
    rpc.mockResolvedValueOnce({ logged_in: true, message: null });
    const done = await app.inject({ method: 'POST', url: `/ai-accounts/c1/login/${started.login_id}/submit` });
    expect(done.json().ok).toBe(true);
  });

  it('answers 404 for an expired flow, another account’s flow and an unknown id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    rpc.mockResolvedValue({ url: CLAUDE_URL, user_code: null, needs_code: true });
    const app = build();
    const { login_id } = (await app.inject({ method: 'POST', url: '/ai-accounts/a1/login' })).json();
    const other = await app.inject({ method: 'POST', url: `/ai-accounts/a2/login/${login_id}/submit`, payload: { code: 'x' } });
    expect(other.statusCode).toBe(404);
    const unknown = await app.inject({ method: 'POST', url: '/ai-accounts/a1/login/nope/submit', payload: { code: 'x' } });
    expect(unknown.statusCode).toBe(404);
    vi.setSystemTime(Date.now() + LOGIN_FLOW_TTL_MS + 1);
    rpc.mockClear();
    const expired = await app.inject({ method: 'POST', url: `/ai-accounts/a1/login/${login_id}/submit`, payload: { code: 'x' } });
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error).toBe('Login não encontrado ou expirado');
    expect(rpc).toHaveBeenCalledWith('m1', 'ai.login.cancel', { session: `termhub-login-${login_id}` });
  });
});

describe('DELETE /ai-accounts/:id/login/:loginId', () => {
  it('kills the hidden session and forgets the flow', async () => {
    rpc.mockResolvedValueOnce({ url: CLAUDE_URL, user_code: null, needs_code: true }).mockResolvedValueOnce({ cancelled: true });
    const app = build();
    const { login_id } = (await app.inject({ method: 'POST', url: '/ai-accounts/a1/login' })).json();
    const res = await app.inject({ method: 'DELETE', url: `/ai-accounts/a1/login/${login_id}` });
    expect(res.json()).toEqual({ cancelled: true });
    expect(rpc).toHaveBeenCalledWith('m1', 'ai.login.cancel', { session: `termhub-login-${login_id}` });
    expect(aiLogin.openFlows).toBe(0);
  });

  it('asks the machine again, so a login finished in the machine\'s browser clears the warning (TER-1054)', async () => {
    aiLogin.markLoginRequired('a1');
    rpc.mockResolvedValueOnce({ url: CLAUDE_URL, user_code: null, needs_code: true }).mockResolvedValueOnce({ cancelled: true }).mockResolvedValueOnce({ supported: true, logged_in: true });
    const app = build();
    const { login_id } = (await app.inject({ method: 'POST', url: '/ai-accounts/a1/login' })).json();
    await app.inject({ method: 'DELETE', url: `/ai-accounts/a1/login/${login_id}` });
    expect(rpc).toHaveBeenLastCalledWith('m1', 'ai.login.status', { provider: 'claude', config_dir: null });
    expect(aiLogin.loginStatusOf('a1').state).toBe('ok');
  });
});

describe('POST /ai-accounts/:id/login/resume', () => {
  it('types continue only into the asked tabs that are still stuck on that account', async () => {
    screens.set('th-t1', 'Please run /login');
    screens.set('th-t3', 'Please run /login'); // a2's tab: not this account's
    screens.set('th-t4', 'working fine');
    const res = await build().inject({ method: 'POST', url: '/ai-accounts/a1/login/resume', payload: { tab_ids: ['t1', 't3', 't4', 'nope'] } });
    expect(aiLoginResumeResponse.parse(res.json())).toEqual({ resumed: ['t1'] });
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith(expect.anything(), { tab_id: 't1', text: 'continue' });
  });

  it('needs the terminals:write grant and caps the list', async () => {
    canAccess.mockResolvedValue(false);
    const denied = await build().inject({ method: 'POST', url: '/ai-accounts/a1/login/resume', payload: { tab_ids: ['t1'] } });
    expect(denied.statusCode).toBe(403);
    const tooMany = await build().inject({ method: 'POST', url: '/ai-accounts/a1/login/resume', payload: { tab_ids: Array.from({ length: 51 }, (_, i) => `t${i}`) } });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('GET /ai-accounts/login-status', () => {
  it('lists every account with its state and whether the button works; refresh asks the machines', async () => {
    rpc.mockImplementation(async (_m: string, method: string, params: { config_dir: string | null }) =>
      method === 'ai.login.status' ? { supported: true, logged_in: params.config_dir !== null } : null,
    );
    caps.set('m2', []);
    const app = build({ prefix: '/api/m/v1/ai-accounts' });
    const before = aiLoginStatusResponse.parse((await app.inject({ method: 'GET', url: '/api/m/v1/ai-accounts/login-status' })).json());
    expect(before.accounts.every((a) => a.state === 'unknown' && a.checked_at === null)).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    const after = aiLoginStatusResponse.parse((await app.inject({ method: 'GET', url: '/api/m/v1/ai-accounts/login-status?refresh=1' })).json());
    const row = (id: string) => after.accounts.find((a) => a.account_id === id)!;
    expect(row('a1')).toMatchObject({ label: 'conta a1', provider: 'claude', machine_id: 'm1', machine_name: 'jarvis', state: 'login_required', supported: true });
    expect(row('a2')).toMatchObject({ state: 'ok', supported: true });
    expect(row('c1')).toMatchObject({ state: 'unknown', supported: false }); // outdated agent: never asked
    expect(row('g1')).toMatchObject({ state: 'unknown', supported: false });
    expect(row('s1')).toMatchObject({ state: 'unknown', supported: false, machine_name: 'ssh box' });
    expect(row('a1').checked_at).not.toBeNull();
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
