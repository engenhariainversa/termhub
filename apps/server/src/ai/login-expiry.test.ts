import { describe, expect, it, vi } from 'vitest';

vi.mock('../agent/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/registry.js')>()),
  agents: { isOnline: () => true, capabilities: () => [], rpc: vi.fn() },
}));

const { daysLeft, expiresSoon, isFreshClaudeStart, loginExpiryLine, parseLoginExpiryNotice, readLoginExpiry, warnDaysOf, warnLoginExpiry } = await import('./login-expiry.js');
const { LoginChecker } = await import('./login-checks.js');
const { AiLoginService } = await import('./login.js');

const DAY = 86_400_000;
const NOW = new Date('2026-10-13T12:00:00Z');
const inDays = (d: number, from = NOW) => new Date(from.getTime() + d * DAY).toISOString();

describe('parseLoginExpiryNotice (TER-1079)', () => {
  it('reads Claude Code\'s startup notice', () => {
    expect(parseLoginExpiryNotice('╭─ Claude Code ─╮\n  Your login expires in 3 days · run /login to renew\n> ')).toBe(3 * DAY);
    expect(parseLoginExpiryNotice('Your login expires in 1 day · run /login to renew')).toBe(DAY);
    expect(parseLoginExpiryNotice('your login expires in 5 hours - run /login to renew')).toBe(5 * 3_600_000);
    expect(parseLoginExpiryNotice('Your login expires today · run /login to renew')).toBe(DAY / 2);
    expect(parseLoginExpiryNotice('Your login expires tomorrow · run /login to renew')).toBe(DAY);
  });

  it('reads it across a wrapped line', () => {
    expect(parseLoginExpiryNotice('Your login expires in 2\n  days · run /login to renew')).toBe(2 * DAY);
  });

  it('is not fooled by the expired error, by talk about the notice or by an empty screen', () => {
    expect(parseLoginExpiryNotice('Login expired · Please run /login')).toBeNull();
    expect(parseLoginExpiryNotice('the card says the login expires in 3 days and we should warn the owner')).toBeNull();
    expect(parseLoginExpiryNotice('OAuth token has expired. Please run /login')).toBeNull();
    expect(parseLoginExpiryNotice('')).toBeNull();
  });
});

describe('the window', () => {
  it('warnDaysOf: the default is 3, and the CLI\'s own three days are the ceiling', () => {
    expect(warnDaysOf(null)).toBe(3);
    expect(warnDaysOf(undefined)).toBe(3);
    expect(warnDaysOf(0)).toBe(0);
    expect(warnDaysOf(2)).toBe(2);
    expect(warnDaysOf(30)).toBe(3);
    expect(warnDaysOf(-1)).toBe(0);
  });

  it('expiresSoon: inside the window, still in the future, and never with the warning off', () => {
    expect(expiresSoon(inDays(3), NOW, 3)).toBe(true);
    expect(expiresSoon(inDays(3.01), NOW, 3)).toBe(false);
    expect(expiresSoon(inDays(0.2), NOW, 3)).toBe(true);
    expect(expiresSoon(inDays(2), NOW, 1)).toBe(false);
    expect(expiresSoon(inDays(-0.1), NOW, 3)).toBe(false);
    expect(expiresSoon(inDays(1), NOW, 0)).toBe(false);
    expect(expiresSoon(null, NOW, 3)).toBe(false);
    expect(expiresSoon('not a date', NOW, 3)).toBe(false);
  });

  it('daysLeft rounds up and is null for an unknown or past date', () => {
    expect(daysLeft(inDays(3), NOW)).toBe(3);
    expect(daysLeft(inDays(2.1), NOW)).toBe(3);
    expect(daysLeft(inDays(0.1), NOW)).toBe(1);
    expect(daysLeft(inDays(-1), NOW)).toBeNull();
    expect(daysLeft(null, NOW)).toBeNull();
  });
});

describe('isFreshClaudeStart', () => {
  it('only a CLI that just started, never a /clear, a /compact or a resume', () => {
    expect(isFreshClaudeStart({ hook_event_name: 'SessionStart', source: 'startup' })).toBe(true);
    expect(isFreshClaudeStart({ hook_event_name: 'SessionStart' })).toBe(true);
    expect(isFreshClaudeStart({ hook_event_name: 'SessionStart', source: 'clear' })).toBe(false);
    expect(isFreshClaudeStart({ hook_event_name: 'SessionStart', source: 'resume' })).toBe(false);
    expect(isFreshClaudeStart({ hook_event_name: 'Stop' })).toBe(false);
    expect(isFreshClaudeStart(null)).toBe(false);
  });
});

it('the chat line names the CLI, the account, the machine and the days, in each language', () => {
  const info = { provider: 'claude' as const, label: 'pessoal', machineName: 'jarvis', days: 3 };
  expect(loginExpiryLine(info, 'pt-BR')).toBe('O login do Claude (pessoal) em jarvis expira em 3 dias. Refaça o login em Contas de IA, ou peça aqui, antes que os agentes parem.');
  expect(loginExpiryLine({ ...info, days: 1 }, 'pt-BR')).toContain('expira em 1 dia.');
  expect(loginExpiryLine(info, 'en')).toContain('expires in 3 days');
  expect(loginExpiryLine({ ...info, days: 1 }, 'en')).toContain('expires in 1 day.');
  expect(loginExpiryLine(info, 'es')).toContain('expira en 3 días');
});

/** The repositories the warning touches, with the columns of `ai_accounts` kept like the database keeps them. */
function world(opts: { warnDays?: number | null; listedIn?: string[] } = {}) {
  const row = { id: 'a1', provider: 'claude', label: 'pessoal', machine_id: 'm1', config_dir: null, exclusive_project: null, created_at: '', login_expires_at: null as string | null, warned_at: null as Date | null };
  const machine = { id: 'm1', name: 'jarvis', type: 'agent', owner_id: 'u1' };
  const tab = { id: 't1', kind: 'terminal', tmux_session: 'th-t1', machine_id: 'm1', project_id: 'p1', ai_account_id: null as string | null };
  let now = NOW;
  const messages: Array<{ conversation_id: string; text: string }> = [];
  const account = () => ({ id: row.id, provider: row.provider, label: row.label, machine_id: row.machine_id, config_dir: row.config_dir, exclusive_project: null, created_at: '', login_expires_at: row.login_expires_at });
  const repos = {
    tabs: { findById: async (id: string) => (id === tab.id ? tab : undefined) },
    machines: { findById: async () => machine, list: async () => [machine] },
    users: { aiLoginWarnDays: async () => opts.warnDays ?? null, findById: async () => ({ id: 'u1', locale: 'pt-BR' }) },
    projects: { list: async () => [{ id: 'p1', owner_id: 'u1' }, { id: 'p2', owner_id: 'u1' }], findById: async (id: string) => ({ id, owner_id: 'u1' }) },
    projectSetup: { get: async (id: string) => ({ data: { ai: { accounts: (opts.listedIn ?? []).includes(id) ? ['a1'] : [] } } }) },
    chat: {
      findLatestActiveForProject: async (projectId: string) => ({ id: `c-${projectId}` }),
      getOrCreateForUser: async () => ({ id: 'c-account' }),
      addMessage: async (m: { conversation_id: string; text: string }) => (messages.push(m), { id: `msg${messages.length}`, ...m }),
    },
    aiAccounts: {
      list: async () => [account()],
      findById: async () => account(),
      noteLoginExpiry: async (_id: string, expiresAt: Date, at: Date) => {
        const known = row.login_expires_at === null ? null : Date.parse(row.login_expires_at);
        if (known === null || known < at.getTime() || known < expiresAt.getTime() - DAY) row.warned_at = null;
        row.login_expires_at = expiresAt.toISOString();
      },
      claimLoginExpiryWarning: async (_id: string, at: Date) => {
        if (row.warned_at || row.login_expires_at === null || Date.parse(row.login_expires_at) <= at.getTime()) return false;
        row.warned_at = at;
        return true;
      },
      clearLoginExpiry: async () => {
        row.login_expires_at = null;
        row.warned_at = null;
      },
    },
  };
  const push = vi.fn(async () => undefined);
  const log = { info: vi.fn(), warn: vi.fn() };
  let screen = '';
  const deps = { repos: repos as never, log, push, now: () => now, capture: async () => screen, isOnline: () => true };
  return {
    deps, row, tab, machine, push, log, messages, account,
    show: (text: string) => (screen = text),
    advance: (days: number) => (now = new Date(now.getTime() + days * DAY)),
    at: () => now,
  };
}

const NOTICE = (n: number) => `Welcome back!\n  Your login expires in ${n} day${n === 1 ? '' : 's'} · run /login to renew\n`;

describe('readLoginExpiry', () => {
  it('records the date for the tab\'s account and warns the owner once: push and a line in the account chat', async () => {
    const w = world();
    w.show(NOTICE(3));
    await readLoginExpiry(w.deps, 't1');
    expect(w.row.login_expires_at).toBe(inDays(3));
    expect(w.push).toHaveBeenCalledTimes(1);
    expect(w.push).toHaveBeenCalledWith('u1', { accountId: 'a1', machineName: 'jarvis', provider: 'claude', days: 3 });
    expect(w.messages).toEqual([{ conversation_id: 'c-account', role: 'assistant', text: expect.stringContaining('expira em 3 dias') }]);
    // nothing of the screen is logged
    expect(JSON.stringify(w.log.info.mock.calls)).not.toContain('Welcome');
  });

  it('does not repeat: other sessions starting, and the periodic check, find the warning already given', async () => {
    const w = world();
    w.show(NOTICE(3));
    await readLoginExpiry(w.deps, 't1');
    w.advance(0.5);
    await readLoginExpiry(w.deps, 't1');
    w.advance(0.6);
    w.show(NOTICE(2));
    await readLoginExpiry(w.deps, 't1');
    expect(await warnLoginExpiry(w.deps, w.account(), w.machine as never)).toBe(false);
    expect(w.push).toHaveBeenCalledTimes(1);
    expect(w.messages).toHaveLength(1);
  });

  it('warns again for the next login: after it was redone, or once the old date passed', async () => {
    const w = world();
    w.show(NOTICE(3));
    await readLoginExpiry(w.deps, 't1');
    // redone from the screen: the date and the claim go
    await w.deps.repos.aiAccounts.clearLoginExpiry('a1');
    w.advance(27);
    await readLoginExpiry(w.deps, 't1');
    expect(w.push).toHaveBeenCalledTimes(2);
    // redone on the machine by hand, which nothing here saw: a month later the notice is back
    w.advance(30);
    await readLoginExpiry(w.deps, 't1');
    expect(w.push).toHaveBeenCalledTimes(3);
  });

  it('the line goes to the projects that list the account, not to the account chat', async () => {
    const w = world({ listedIn: ['p2'] });
    w.show(NOTICE(2));
    await readLoginExpiry(w.deps, 't1');
    expect(w.messages.map((m) => m.conversation_id)).toEqual(['c-p2']);
  });

  it('a person who asked for one day is not warned at three, and is by the periodic check when one day is left', async () => {
    const w = world({ warnDays: 1 });
    w.show(NOTICE(3));
    await readLoginExpiry(w.deps, 't1');
    expect(w.row.login_expires_at).toBe(inDays(3));
    expect(w.push).not.toHaveBeenCalled();
    const checker = new LoginChecker({ repos: w.deps.repos, log: w.log, pushExpiring: w.push, service: new AiLoginService(() => w.at().getTime()), now: w.at });
    w.advance(1);
    await checker.run();
    expect(w.push).not.toHaveBeenCalled();
    w.advance(1.2);
    await checker.run();
    await checker.run();
    expect(w.push).toHaveBeenCalledTimes(1);
    expect(w.push).toHaveBeenCalledWith('u1', expect.objectContaining({ days: 1 }));
  });

  it('with the warning off the date is still kept and nobody is told', async () => {
    const w = world({ warnDays: 0 });
    w.show(NOTICE(1));
    await readLoginExpiry(w.deps, 't1');
    expect(w.row.login_expires_at).toBe(inDays(1));
    expect(w.push).not.toHaveBeenCalled();
    expect(w.messages).toHaveLength(0);
  });

  it('a screen without the notice changes nothing, and neither does a Codex account', async () => {
    const w = world();
    w.show('Welcome back!\n> ');
    await readLoginExpiry(w.deps, 't1');
    expect(w.row.login_expires_at).toBeNull();
    w.row.provider = 'chatgpt';
    w.tab.ai_account_id = 'a1';
    w.show(NOTICE(3));
    await readLoginExpiry(w.deps, 't1');
    expect(w.row.login_expires_at).toBeNull();
    expect(w.push).not.toHaveBeenCalled();
  });

  it('never throws: a failing capture is logged by id only', async () => {
    const w = world();
    await expect(readLoginExpiry({ ...w.deps, capture: async () => Promise.reject(new Error('secret screen')) }, 't1')).resolves.toBeUndefined();
    expect(w.log.warn).toHaveBeenCalledWith({ tabId: 't1', code: 'ERROR' }, 'ai login expiry read failed');
  });
});

describe('LoginChecker and the expiry date', () => {
  it('forgets a date that passed and does not warn about a login already gone', async () => {
    const w = world();
    const service = new AiLoginService(() => w.at().getTime());
    const checker = new LoginChecker({ repos: w.deps.repos, log: w.log, pushExpiring: w.push, service, now: w.at });
    w.row.login_expires_at = inDays(2);
    service.markLoginRequired('a1');
    await checker.run();
    expect(w.push).not.toHaveBeenCalled();
    w.advance(3);
    await checker.run();
    expect(w.row.login_expires_at).toBeNull();
  });
});
