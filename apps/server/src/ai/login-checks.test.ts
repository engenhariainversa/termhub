import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const caps = new Map<string, string[]>();
vi.mock('../agent/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/registry.js')>()),
  agents: { rpc: (...a: unknown[]) => rpc(...a), isOnline: (id: string) => caps.has(id), capabilities: (id: string) => caps.get(id) ?? null },
}));

const { LoginChecker } = await import('./login-checks.js');
const { AiLoginService, LOGIN_STATE_TTL_MS } = await import('./login.js');

const machines = [
  { id: 'm1', name: 'jarvis', type: 'agent', owner_id: 'u1' },
  { id: 'm2', name: 'old', type: 'agent', owner_id: 'u2' },
  { id: 'ms', name: 'ssh', type: 'ssh', owner_id: 'u1' },
];
const acc = (id: string, machine_id: string, provider = 'claude') => ({ id, label: id, provider, machine_id, config_dir: null, exclusive_project: null, created_at: '' });
const accounts = [acc('a1', 'm1'), acc('g1', 'm1', 'gemini'), acc('a2', 'm2'), acc('s1', 'ms')];

function setup() {
  let now = 1_000_000;
  const service = new AiLoginService(() => now);
  const push = vi.fn(async () => undefined);
  const log = { info: vi.fn(), warn: vi.fn() };
  const repos = { machines: { list: vi.fn(async () => machines) }, aiAccounts: { list: vi.fn(async () => accounts) } };
  const checker = new LoginChecker({ repos: repos as never, log, push, service });
  return { checker, service, push, log, advance: (ms: number) => (now += ms) };
}

let loggedIn = true;
beforeEach(() => {
  loggedIn = true;
  rpc.mockReset().mockImplementation(async () => ({ supported: true, logged_in: loggedIn }));
  caps.clear();
  caps.set('m1', ['ai_login']).set('m2', []);
});

describe('LoginChecker (TER-1047)', () => {
  it('checks only Claude/Codex accounts of online agent machines with ai_login', async () => {
    const t = setup();
    await t.checker.run();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('m1', 'ai.login.status', { provider: 'claude', config_dir: null });
    expect(t.service.loginStatusOf('a1').state).toBe('ok');
    expect(t.push).not.toHaveBeenCalled();
  });

  it('pushes once to the machine owner when the login goes away, and again only after it came back', async () => {
    const t = setup();
    await t.checker.run();
    loggedIn = false;
    t.advance(LOGIN_STATE_TTL_MS + 1);
    await t.checker.run();
    expect(t.push).toHaveBeenCalledTimes(1);
    expect(t.push).toHaveBeenCalledWith('u1', { accountId: 'a1', machineName: 'jarvis', provider: 'claude' });
    t.advance(LOGIN_STATE_TTL_MS + 1);
    await t.checker.run();
    expect(t.push).toHaveBeenCalledTimes(1);
    loggedIn = true;
    t.advance(LOGIN_STATE_TTL_MS + 1);
    await t.checker.run();
    loggedIn = false;
    t.advance(LOGIN_STATE_TTL_MS + 1);
    await t.checker.run();
    expect(t.push).toHaveBeenCalledTimes(2);
  });

  it('a failed status call keeps the known state and never throws', async () => {
    const t = setup();
    await t.checker.run();
    rpc.mockRejectedValue(new Error('offline'));
    t.advance(LOGIN_STATE_TTL_MS + 1);
    await expect(t.checker.run()).resolves.toBeUndefined();
    expect(t.service.loginStatusOf('a1').state).toBe('ok');
    expect(t.push).not.toHaveBeenCalled();
  });

  it('markLoginRequired is picked up as an expiry (TER-1046 entry point)', async () => {
    const t = setup();
    t.service.markLoginRequired('a1');
    expect(t.service.loginStatusOf('a1').state).toBe('login_required');
    loggedIn = false;
    t.advance(LOGIN_STATE_TTL_MS + 1);
    await t.checker.run();
    expect(t.push).toHaveBeenCalledTimes(1);
  });
});
