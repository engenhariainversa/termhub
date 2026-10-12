import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../agent/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/registry.js')>()),
  agents: { rpc: (...a: unknown[]) => rpc(...a), awaitAgent: async () => true, isOnline: () => true, capabilities: () => ['ai_login'], info: () => null },
}));
vi.mock('../agent/screen.js', () => ({ captureScreen: vi.fn(async () => '') }));

const { TOOLS } = await import('../mcp/tools.js');
const { Scoped } = await import('../auth/scope.js');
const { aiLogin } = await import('../ai/login.js');

const machine = { id: 'm1', name: 'jarvis', type: 'agent', owner_id: 'u1' };
const account = { id: 'a1', label: 'pessoal', provider: 'claude', machine_id: 'm1', config_dir: null, exclusive_project: null, created_at: '' };

function ctx(token?: { id: string; scopes: string[]; tab?: { id: string; project_id: string } }) {
  const repos = {
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? machine : undefined)) },
    aiAccounts: { findById: vi.fn(async (id: string) => (id === 'a1' ? account : undefined)) },
    tabs: { listByMachine: vi.fn(async () => []) },
  };
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' as const }, ownerId: 'u1', createAs: 'u1' };
  return { repos: repos as never, scope, scoped: new Scoped(repos as never, scope), can: async () => true, token: token as never };
}
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const signal = new AbortController().signal;

beforeEach(() => rpc.mockReset());
afterEach(() => aiLogin.stop());

describe('start_ai_login / submit_ai_login_code (TER-1047)', () => {
  it('are update tools of ai_accounts', () => {
    expect(tool('start_ai_login')).toMatchObject({ resource: 'ai_accounts', action: 'update', scope: 'terminals' });
    expect(tool('submit_ai_login_code')).toMatchObject({ resource: 'ai_accounts', action: 'update', scope: 'terminals', strict: true });
  });

  it('answers the url and what to do next, and the submit never echoes the code', async () => {
    rpc.mockResolvedValueOnce({ url: 'https://claude.com/cai/oauth/authorize?x=1', user_code: null, needs_code: true });
    const started = (await tool('start_ai_login').run(ctx(), { account_id: 'a1' }, signal)) as { login_id: string; url: string; instruction: string };
    expect(started.url).toBe('https://claude.com/cai/oauth/authorize?x=1');
    expect(started.instruction).toContain('submit_ai_login_code');
    rpc.mockResolvedValueOnce({ logged_in: true, message: null });
    const done = await tool('submit_ai_login_code').run(ctx(), { login_id: started.login_id, code: 'SECRET-CODE-123' }, signal);
    expect(done).toEqual({ ok: true, message: null, stuck_tabs: [] });
    expect(JSON.stringify(done)).not.toContain('SECRET-CODE-123');
    expect(rpc).toHaveBeenLastCalledWith('m1', 'ai.login.submit', expect.objectContaining({ code: 'SECRET-CODE-123' }));
  });

  it('an agent tab token cannot start or continue a login', async () => {
    const tabCtx = ctx({ id: 'k1', scopes: ['terminals'], tab: { id: 't1', project_id: 'p1' } });
    await expect(tool('start_ai_login').run(tabCtx, { account_id: 'a1' }, signal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    rpc.mockResolvedValueOnce({ url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-EFGH1', needs_code: false });
    const started = (await tool('start_ai_login').run(ctx(), { account_id: 'a1' }, signal)) as { login_id: string };
    await expect(tool('submit_ai_login_code').run(tabCtx, { login_id: started.login_id }, signal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
