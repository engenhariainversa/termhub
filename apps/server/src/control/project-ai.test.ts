import { CAPABILITY_CLAUDE, CAPABILITY_CLAUDE_SYSTEM_PROMPT } from '@termhub/agent-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccountUsage } from '../ai/index.js';
import { Scoped } from '../auth/scope.js';
import { clearLimited, isLimited, markLimited } from '../chat/host.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount } from '../db/repositories/types.js';
import { normalizeSetup } from '../setup/schema.js';
import type { ControlContext, ControlToken } from './context.js';
import { getProjectAiSetup, setProjectAiSetup, unstickProjectChat } from './project-ai.js';

const usage = new Map<string, AiAccountUsage>();
const getAccountUsage = vi.fn(async (account: AiAccount, _machine: unknown, _refresh?: boolean) => usage.get(account.id) ?? { account_id: account.id, fetched_at: '', ok: false, plan: null, windows: [], error: 'sem leitura', hint: null });
vi.mock('../ai/index.js', () => ({ getAccountUsage: (...a: Parameters<typeof getAccountUsage>) => getAccountUsage(...a) }));

const reading = (id: string, utilization: number, resets_at: string | null = '2026-10-28T18:00:00.000Z', extra: AiAccountUsage['windows'] = []): AiAccountUsage => ({
  account_id: id,
  fetched_at: '',
  ok: true,
  plan: 'max',
  windows: [{ key: 'five_hour', label: '5 h', utilization, resets_at }, ...extra],
  error: null,
  hint: null,
});

const machine = (id: string, name: string) => ({ id, name, owner_id: 'u1', type: 'agent' });
const machines = [machine('m1', 'jarvis'), machine('m2', 'hulk'), machine('m3', 'capitão')];
const acc = (id: string, machine_id: string, provider = 'claude', exclusive_project: { id: string; name: string } | null = null): AiAccount =>
  ({ id, label: `Claude ${id}`, provider, machine_id, config_dir: id === 'a1' ? null : `~/.claude-${id}`, exclusive_project, created_at: '' }) as AiAccount;

function world(opts: { accounts?: string[]; chatMachine?: string | null; token?: ControlToken; approval?: boolean; online?: string[]; conversation?: { id: string; model: string | null; ai_account_id: string | null } | null } = {}) {
  const accounts = [acc('a1', 'm1'), acc('a2', 'm2'), acc('a3', 'm2'), acc('c1', 'm1', 'chatgpt'), acc('x1', 'm1', 'claude', { id: 'p9', name: 'Cliente' }), acc('u3', 'm3')];
  let stored = normalizeSetup({ ai: { accounts: opts.accounts ?? ['a1', 'a2', 'c1'], models: { claude: 'opus', chatgpt: null }, chat_machine_id: opts.chatMachine ?? null } }, 2);
  const conversation = opts.conversation === undefined ? { id: 'cv1', model: null, ai_account_id: 'a1' } : opts.conversation;
  const repos = {
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id, name: 'Opa Pingou', owner_id: 'u1' } : undefined)) },
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)), list: vi.fn(async () => machines) },
    aiAccounts: { findById: vi.fn(async (id: string) => accounts.find((a) => a.id === id)), list: vi.fn(async () => accounts) },
    projectMachines: {
      listByProject: vi.fn(async () => [{ project_id: 'p1', machine_id: 'm1' }, { project_id: 'p1', machine_id: 'm2' }]),
      find: vi.fn(async (_p: string, m: string) => (m === 'm1' || m === 'm2' ? { project_id: 'p1', machine_id: m } : undefined)),
    },
    projectSetup: {
      get: vi.fn(async () => ({ project_id: 'p1', version: 2, data: stored, updated_at: null })),
      save: vi.fn(async (_p: string, data: typeof stored) => {
        stored = data;
        return { project_id: 'p1', version: 2, data, updated_at: 'now' };
      }),
    },
    chat: { findLatestActiveForProject: vi.fn(async () => conversation ?? undefined), setRunAccount: vi.fn(async () => undefined) },
    automationEvents: { insert: vi.fn(async () => ({})) },
  };
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  const ctx: ControlContext = {
    repos: repos as unknown as Repositories,
    scope,
    scoped: new Scoped(repos as unknown as Repositories, scope),
    can: async () => true,
    token: opts.token,
    approval: opts.approval ? { actionId: 'act1', approvedAt: new Date() } : undefined,
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const online = new Set(opts.online ?? ['m1', 'm2']);
  const agents = { capabilities: (id: string) => (online.has(id) ? [CAPABILITY_CLAUDE, CAPABILITY_CLAUDE_SYSTEM_PROMPT] : null) };
  return { ctx, repos, agents, stored: () => stored };
}

const CHAT: ControlToken = { id: 't', scopes: ['read', 'terminals'], gated: true };

beforeEach(() => {
  usage.clear();
  clearLimited();
  getAccountUsage.mockClear();
});
afterEach(() => clearLimited());

describe('get_project_ai_setup (TER-1147)', () => {
  it('lists the accounts in order with machine, usage and limit mark, the models and who answers the chat', async () => {
    const w = world();
    usage.set('a1', reading('a1', 100, '2026-10-28T18:00:00.000Z', [{ key: 'seven_day_fable', label: '7 d Fable', utilization: 40, resets_at: null, model: 'fable' }]));
    usage.set('a2', reading('a2', 20));
    markLimited('a1', '2099-01-01T00:00:00.000Z');
    const r = await getProjectAiSetup(w.ctx, { project_id: 'p1' }, w.agents);
    expect(r.project).toEqual({ id: 'p1', name: 'Opa Pingou' });
    expect(r.accounts.map((a) => [a.position, a.id, a.machine.name, a.machine.online, a.usable, a.limited_until])).toEqual([
      [1, 'a1', 'jarvis', true, true, '2099-01-01T00:00:00.000Z'],
      [2, 'a2', 'hulk', true, true, null],
      [3, 'c1', 'jarvis', true, true, null],
    ]);
    expect(r.accounts[0].usage.windows).toEqual([
      { label: '5 h', model: null, utilization: 100, resets_at: '2026-10-28T18:00:00.000Z' },
      { label: '7 d Fable', model: 'fable', utilization: 40, resets_at: null },
    ]);
    expect(r.accounts[2].usage).toMatchObject({ ok: false, error: 'sem leitura' });
    expect(r.models).toEqual({ claude: 'opus', chatgpt: null });
    expect(r.available.map((o) => o.id)).toEqual(['x1', 'a3']);
    expect(r.concierge).toMatchObject({ account: { id: 'a2' }, machine: { id: 'm2', name: 'hulk' }, model: 'opus', reason: 'first_with_room' });
  });

  it('says when every Claude account met its limit, and when the project lists none', async () => {
    const w = world();
    markLimited('a1', null);
    markLimited('a2', null);
    expect((await getProjectAiSetup(w.ctx, { project_id: 'p1' }, w.agents)).concierge).toMatchObject({ account: { id: 'a1' }, reason: 'all_limited_picked' });
    const none = world({ accounts: ['c1'] });
    expect((await getProjectAiSetup(none.ctx, { project_id: 'p1' }, none.agents)).concierge).toMatchObject({ account: null, reason: 'no_claude_account' });
  });

  it('follows the person\'s pick for the conversation, then the concierge machine (TER-1144)', async () => {
    const onHulk = world({ chatMachine: 'm2', conversation: { id: 'cv1', model: null, ai_account_id: null } });
    const r = await getProjectAiSetup(onHulk.ctx, { project_id: 'p1' }, onHulk.agents);
    expect(r.chat_machine).toEqual({ id: 'm2', name: 'hulk' });
    expect(r.concierge).toMatchObject({ account: { id: 'a2' }, reason: 'machine' });
    const picked = world({ chatMachine: 'm2' });
    expect((await getProjectAiSetup(picked.ctx, { project_id: 'p1' }, picked.agents)).concierge).toMatchObject({ account: { id: 'a1' }, reason: 'conversation' });
  });

  it('is a 404 outside the scope', async () => {
    const w = world();
    await expect(getProjectAiSetup(w.ctx, { project_id: 'px' }, w.agents)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('set_project_ai_setup (TER-1147)', () => {
  it('without confirm, answers before and after and saves nothing', async () => {
    const w = world({ token: CHAT });
    const r = await setProjectAiSetup(w.ctx, { project_id: 'p1', accounts: ['a2', 'a1', 'c1'], chat_machine_id: 'm2', models: { claude: 'sonnet' } }, w.agents);
    expect(r).toMatchObject({
      changed: false,
      confirm_required: true,
      before: '1. Claude a1 · jarvis, 2. Claude a2 · hulk, 3. Claude c1 · jarvis; modelos: Claude opus, Codex padrão do CLI; máquina do concierge: automática',
      after: '1. Claude a2 · hulk, 2. Claude a1 · jarvis, 3. Claude c1 · jarvis; modelos: Claude sonnet, Codex padrão do CLI; máquina do concierge: hulk',
    });
    expect(w.repos.projectSetup.save).not.toHaveBeenCalled();
  });

  it('with confirm on the approved card, saves the order and the model and says who answers the chat now', async () => {
    const w = world({ token: CHAT, approval: true, conversation: { id: 'cv1', model: null, ai_account_id: null } });
    const r = await setProjectAiSetup(w.ctx, { project_id: 'p1', remove: ['c1'], add: ['a3'], chat_machine_id: 'm2', models: { chatgpt: 'gpt-5-codex' }, confirm: true }, w.agents);
    expect(r.changed).toBe(true);
    expect(w.stored().ai).toEqual({ accounts: ['a1', 'a2', 'a3'], models: { claude: 'opus', chatgpt: 'gpt-5-codex' }, chat_machine_id: 'm2' });
    expect(r.concierge).toMatchObject({ account: { id: 'a2' }, machine: { name: 'hulk' }, reason: 'machine' });
    await setProjectAiSetup(w.ctx, { project_id: 'p1', chat_machine_id: null, confirm: true }, w.agents);
    expect(w.stored().ai.chat_machine_id).toBeNull();
  });

  it('replaces the whole order, and changes nothing when the result is the same', async () => {
    const w = world({ token: { id: 't', scopes: ['terminals'] } });
    await setProjectAiSetup(w.ctx, { project_id: 'p1', accounts: ['c1', 'a1'], confirm: true }, w.agents);
    expect(w.stored().ai.accounts).toEqual(['c1', 'a1']);
    w.repos.projectSetup.save.mockClear();
    expect(await setProjectAiSetup(w.ctx, { project_id: 'p1', accounts: ['c1', 'a1'], confirm: true }, w.agents)).toMatchObject({ changed: false, confirm_required: false });
    expect(w.repos.projectSetup.save).not.toHaveBeenCalled();
  });

  it('on the concierge token, refuses confirm without the approved card', async () => {
    const w = world({ token: CHAT });
    await expect(setProjectAiSetup(w.ctx, { project_id: 'p1', remove: ['c1'], confirm: true }, w.agents)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(w.repos.projectSetup.save).not.toHaveBeenCalled();
  });

  it('refuses an account exclusive to another project, one on an unlinked machine, an unlinked machine and an agent tab', async () => {
    const w = world({ token: CHAT, approval: true });
    await expect(setProjectAiSetup(w.ctx, { project_id: 'p1', add: ['x1'], confirm: true }, w.agents)).rejects.toMatchObject({ statusCode: 400 });
    await expect(setProjectAiSetup(w.ctx, { project_id: 'p1', add: ['u3'], confirm: true }, w.agents)).rejects.toMatchObject({ statusCode: 400 });
    await expect(setProjectAiSetup(w.ctx, { project_id: 'p1', chat_machine_id: 'm3', confirm: true }, w.agents)).rejects.toMatchObject({ code: 'MACHINE_NOT_LINKED' });
    expect(w.repos.projectSetup.save).not.toHaveBeenCalled();
    const tab = world({ token: { id: 't', scopes: ['terminals'], tab: { id: 'tb', project_id: 'p1' } } });
    await expect(setProjectAiSetup(tab.ctx, { project_id: 'p1', remove: ['c1'], confirm: true }, tab.agents)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('unstick_project_chat (TER-1147)', () => {
  it('forgets the limit marks, reads usage fresh and the chat\'s next message goes to the first account with room', async () => {
    const w = world({ token: CHAT });
    markLimited('a1', null);
    markLimited('a2', null);
    usage.set('a1', reading('a1', 100));
    usage.set('a2', reading('a2', 30));
    const r = await unstickProjectChat(w.ctx, { project_id: 'p1' }, w.agents);
    expect(r).toMatchObject({ unstuck: true, account: { id: 'a2' }, machine: { id: 'm2', name: 'hulk' }, model: 'opus' });
    expect(r.accounts.map((a) => [a.id, a.state])).toEqual([
      ['a1', 'full'],
      ['a2', 'room'],
    ]);
    expect(getAccountUsage).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), expect.anything(), true);
    expect(isLimited('a1')).toBe(true);
    expect(isLimited('a2')).toBe(false);
    // the conversation's pick (TER-1144) is the person's: never written here
    expect(w.repos.chat.setRunAccount).not.toHaveBeenCalled();
  });

  it('a window that caps another model does not keep the account aside', async () => {
    const w = world({ token: CHAT });
    markLimited('a1', null);
    usage.set('a1', reading('a1', 10, null, [{ key: 'seven_day_fable', label: '7 d Fable', utilization: 100, resets_at: null, model: 'fable' }]));
    const r = await unstickProjectChat(w.ctx, { project_id: 'p1' }, w.agents);
    expect(r).toMatchObject({ unstuck: true, account: { id: 'a1' } });
    expect(w.repos.chat.setRunAccount).not.toHaveBeenCalled();
  });

  it('says when every account is still full, with the first reset, and moves nothing', async () => {
    const w = world({ token: CHAT });
    usage.set('a1', reading('a1', 100, '2026-10-28T19:00:00.000Z'));
    usage.set('a2', reading('a2', 95, '2026-10-28T18:00:00.000Z'));
    const r = await unstickProjectChat(w.ctx, { project_id: 'p1' }, w.agents);
    expect(r).toMatchObject({ unstuck: false, account: null });
    expect(r.text).toContain('a primeira volta em 2026-10-28T18:00:00.000Z');
    expect(w.repos.chat.setRunAccount).not.toHaveBeenCalled();
  });

  it('skips an offline machine and tries an account whose usage cannot be read', async () => {
    const w = world({ token: CHAT, online: ['m2'] });
    const r = await unstickProjectChat(w.ctx, { project_id: 'p1' }, w.agents);
    expect(r.accounts.map((a) => [a.id, a.state])).toEqual([
      ['a1', 'offline'],
      ['a2', 'unknown'],
    ]);
    expect(r).toMatchObject({ unstuck: true, account: { id: 'a2' } });
  });

  it('with no Claude account listed, says the account-wide host decides; an agent tab is refused', async () => {
    const w = world({ token: CHAT, accounts: ['c1'] });
    expect(await unstickProjectChat(w.ctx, { project_id: 'p1' }, w.agents)).toMatchObject({ unstuck: false, accounts: [] });
    const tab = world({ token: { id: 't', scopes: ['terminals'], tab: { id: 'tb', project_id: 'p1' } } });
    await expect(unstickProjectChat(tab.ctx, { project_id: 'p1' }, tab.agents)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
