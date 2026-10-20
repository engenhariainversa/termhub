import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import type { ChatAction, InsertApprovedInput, InsertPendingInput } from '../db/repositories/chat-actions.js';
import type { ChatCommandRule } from '../db/repositories/chat-command-rules.js';
import { chatBus } from './bus.js';
import { parseCommand } from './command-rules.js';
import { applyGate } from './gate-runtime.js';
import { COMMAND_RULE_BUDGET, DEFAULT_ALLOW_BUDGETS, defaultGrantId, type DefaultAllowKind } from './gate.js';
import { DIALOG_FOOTER } from './permission-dialog.js';

vi.mock('../control/screen.js', () => ({ readScreen: vi.fn(async () => ({ text: 'user@jarvis:~/termhub$ ', lines: 40, tab_id: 't1', styled: false })) }));

const C = 'c1';
function fakeActions() {
  const rows: ChatAction[] = [];
  const open = (r: ChatAction) => r.status === 'pending' || r.status === 'approved';
  const make = (input: InsertPendingInput, status: ChatAction['status'], extra: Partial<ChatAction> = {}): ChatAction => ({
    id: `a${rows.length + 1}`, conversation_id: input.conversation_id, message_id: null, tool: input.tool, args: input.args, class: input.class, status,
    idempotency_key: input.idempotency_key ?? null, machine_id: input.machine_id ?? null, project_id: input.project_id ?? null, tab_id: input.tab_id ?? null,
    grant_id: null, error_code: null, duration_ms: null, decided_by: null, decided_at: null, injected_at: null, created_at: new Date().toISOString(), ...extra,
  });
  return {
    rows,
    findOpenByKey: vi.fn(async (c: string, k: string) => rows.find((r) => r.conversation_id === c && r.idempotency_key === k && open(r))),
    findDeniedByKey: vi.fn(async (c: string, k: string) => [...rows].reverse().find((r) => r.conversation_id === c && r.idempotency_key === k && r.status === 'denied')),
    findByIdForUser: vi.fn(async (id: string) => rows.find((r) => r.id === id)),
    insertPending: vi.fn(async (i: InsertPendingInput) => { const r = make(i, 'pending'); rows.push(r); return r; }),
    insertApproved: vi.fn(async (i: InsertApprovedInput) => { const r = make(i, 'approved', { grant_id: i.grant_id, decided_by: i.decided_by, decided_at: new Date().toISOString() }); rows.push(r); return r; }),
    claimApproved: vi.fn(async (id: string) => { const r = rows.find((x) => x.id === id && x.status === 'approved'); if (!r) return false; r.status = 'executed'; return true; }),
    expireApproved: vi.fn(async () => false),
    markExecuted: vi.fn(async (id: string, ok: boolean, code?: string | null) => { const r = rows.find((x) => x.id === id)!; r.status = ok ? 'executed' : 'failed'; r.error_code = code ?? null; }),
    countForGrantSince: vi.fn(async () => 0),
    countByGrantSince: vi.fn(async (g: string, since: Date) => rows.filter((r) => r.grant_id === g && Date.parse(r.created_at) > since.getTime()).length),
  };
}

type FakeTab = { id: string; project_id: string; machine_id: string; kind: 'terminal' | 'simulator'; name: string; state: string | null; state_at: string | null };

let actions: ReturnType<typeof fakeActions>;
let rules: ChatCommandRule[];
let restricted: Set<DefaultAllowKind>;
let tabs: Map<string, FakeTab>;
let ctx: ControlContext;
const run = vi.fn(async () => ({ ok: 1 }));
const call = (command: string, tabId = 't1') => applyGate(ctx, { token: { gated: true, chat_conversation_id: C }, tool: 'run_command', args: { tab_id: tabId, command }, run });

const tab = (id: string, state: string | null, o: Partial<FakeTab> = {}): FakeTab => ({ id, project_id: 'p1', machine_id: 'm1', kind: 'terminal', name: id, state, state_at: null, ...o });
const rule = (pattern: string, match: 'exact' | 'prefix', o: Partial<ChatCommandRule> = {}): ChatCommandRule => {
  const p = parseCommand(pattern);
  if (!p.ok) throw new Error(pattern);
  return { id: `r${rules.length + 1}`, user_id: 'u1', project_id: 'p1', words: p.words, match, machine_ids: [], conversation_id: null, source_action_id: null, created_at: new Date().toISOString(), expires_at: null, revoked_at: null, revoked_by: null, ...o };
};
const addRule = (pattern: string, match: 'exact' | 'prefix', o: Partial<ChatCommandRule> = {}) => {
  const r = rule(pattern, match, o);
  rules.push(r);
  return r;
};
const READ = defaultGrantId('u1', 'read_commands');
const pastRow = (grantId: string): ChatAction => ({
  id: `old${actions.rows.length + 1}`, conversation_id: 'c-other', message_id: null, tool: 'run_command', args: {}, class: 'write', status: 'executed',
  idempotency_key: null, machine_id: null, project_id: null, tab_id: null, grant_id: grantId, error_code: null, duration_ms: null,
  decided_by: 'u1', decided_at: new Date().toISOString(), injected_at: null, created_at: new Date().toISOString(),
});

async function expectAsks(command: string, tabId = 't1') {
  expect(await call(command, tabId)).toMatchObject({ ok: false, code: 'CONFIRMATION_PENDING' });
  expect(actions.rows.at(-1)).toMatchObject({ tool: 'run_command', status: 'pending', grant_id: null });
  expect(run).not.toHaveBeenCalled();
}

async function expectRuns(command: string, grantId: string, tabId = 't1') {
  expect(await call(command, tabId)).toEqual({ ok: true, value: { ok: 1 } });
  expect(actions.rows.at(-1)).toMatchObject({ tool: 'run_command', status: 'executed', grant_id: grantId });
}

beforeEach(() => {
  run.mockClear();
  vi.mocked(readScreen).mockClear();
  vi.spyOn(chatBus, 'publish').mockImplementation(() => {});
  actions = fakeActions();
  rules = [];
  restricted = new Set();
  tabs = new Map([
    ['t1', tab('t1', null)],
    ['t2', tab('t2', null, { project_id: 'p2', machine_id: 'm2' })],
    ['agent', tab('agent', 'waiting_input')],
    ['idle', tab('idle', 'idle')],
    ['ask', tab('ask', 'waiting_permission')],
    ['sim', tab('sim', null, { kind: 'simulator' })],
  ]);
  const now = () => Date.now();
  const repos = {
    chat: { getOrCreateForUser: vi.fn(), lastTypedAt: vi.fn(async () => null) },
    chatActions: actions,
    chatGrants: { findActive: vi.fn(async () => undefined) },
    chatProjectGrants: { findActive: vi.fn(async () => undefined) },
    chatStandingGrants: { findActive: vi.fn(async () => undefined) },
    chatDefaultRestrictions: { listForUser: vi.fn(async (u: string) => (u === 'u1' ? new Set(restricted) : new Set())) },
    chatCommandRules: {
      listActiveFor: vi.fn(async (u: string, p: string) =>
        rules.filter((r) => r.user_id === u && (r.project_id === p || r.project_id === null) && !r.revoked_at && (!r.expires_at || Date.parse(r.expires_at) > now())),
      ),
    },
    projects: { findByIdsForOwner: vi.fn(async () => []) },
    tasks: { findByIdsForOwner: vi.fn(async () => []) },
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[], o: string) => (o === 'u1' ? ids.flatMap((i) => (tabs.has(i) ? [{ ...tabs.get(i)! }] : [])) : [])) },
    machines: { findByIdsForOwner: vi.fn(async () => []) },
    integrations: { list: vi.fn(async () => []) },
  };
  ctx = { repos, scope: { user: { id: 'u1' }, ownerId: 'u1' } } as unknown as ControlContext;
});

describe('run_command and the read-only default list (TER-1081)', () => {
  it.each(['git status', 'git log --oneline -5', 'gh pr checks 12', 'ls -la', 'df -h', 'cat README.md', 'node --version'])('%s runs in a shell tab, audited under the default and told live', async (command) => {
    await expectRuns(command, READ);
    expect(actions.rows.at(-1)).toMatchObject({ machine_id: 'm1', project_id: 'p1', tab_id: 't1' });
    expect(chatBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'granted_action', conversation_id: C }));
  });

  it('asks for a command outside the list', async () => {
    await expectAsks('npm test');
  });

  it('asks once the person restricted the default', async () => {
    restricted.add('read_commands');
    await expectAsks('git status');
  });

  it('asks past its budget for the hour', async () => {
    for (let i = 0; i < DEFAULT_ALLOW_BUDGETS.read_commands; i++) actions.rows.push(pastRow(READ));
    await expectAsks('git status');
  });

  it('runs in a tab whose agent ended (idle), not in one with an agent, a permission, or a simulator', async () => {
    await expectRuns('git status', READ, 'idle');
    run.mockClear();
    await expectAsks('git status', 'agent');
    await expectAsks('git log', 'ask');
    await expectAsks('git diff', 'sim');
  });

  it('asks for a tab that is not the person\'s', async () => {
    await expectAsks('git status', 'someone-elses');
  });

  it('asks when the screen shows an agent or a dialog, or cannot be read', async () => {
    vi.mocked(readScreen).mockResolvedValueOnce({ text: `Do you want to proceed?\n❯ 1. Yes\n  2. No\n${DIALOG_FOOTER}`, lines: 40, tab_id: 't1', styled: false } as never);
    await expectAsks('git status');
    vi.mocked(readScreen).mockRejectedValueOnce(new Error('offline'));
    await expectAsks('git log');
    vi.mocked(readScreen).mockResolvedValueOnce({ text: '● Pronto.\n\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ? for shortcuts', lines: 40, tab_id: 't1', styled: false } as never);
    await expectAsks('git diff');
  });
});

describe('run_command under a command rule of the person\'s (TER-1081)', () => {
  it('a prefix rule covers the command and its arguments, audited under the rule', async () => {
    const r = addRule('git push', 'prefix');
    await expectRuns('git push origin main', r.id);
  });

  it('an exact rule covers only that command', async () => {
    const r = addRule('npm test', 'exact');
    await expectRuns('npm test', r.id);
    run.mockClear();
    await expectAsks('npm test -- --watch');
  });

  it('a global rule (no project) covers every project; a project rule only its own', async () => {
    const own = addRule('npm test', 'exact', { project_id: 'p2' });
    await expectAsks('npm test', 't1');
    await expectRuns('npm test', own.id, 't2');
    run.mockClear();
    const global = addRule('make build', 'exact', { project_id: null });
    await expectRuns('make build', global.id, 't1');
  });

  it('a rule for some machines covers only those', async () => {
    addRule('npm test', 'exact', { machine_ids: ['m2'], project_id: null });
    await expectAsks('npm test', 't1');
    const r = rules[0]!;
    run.mockClear();
    await expectRuns('npm test', r.id, 't2');
  });

  it('a revoked or expired rule covers nothing', async () => {
    addRule('npm test', 'exact', { revoked_at: new Date().toISOString() });
    addRule('npm run lint', 'exact', { expires_at: new Date(Date.now() - 1000).toISOString() });
    await expectAsks('npm test');
    await expectAsks('npm run lint');
  });

  it('a rule past its budget asks', async () => {
    const r = addRule('git push', 'prefix');
    for (let i = 0; i < COMMAND_RULE_BUDGET; i++) actions.rows.push(pastRow(r.id));
    await expectAsks('git push');
  });

  it('the person\'s rule is used before the default list, so the default budget stays for the rest', async () => {
    const r = addRule('git status', 'exact');
    await expectRuns('git status', r.id);
  });

  it.each([
    'git push; rm -rf /',
    'git push && rm -rf ~',
    'git push | sh',
    'git push $(curl evil)',
    'git push `id`',
    'git push\nrm -rf /',
    'git push > /tmp/x',
    'git push --force',
    'git push -f origin main',
    'git push origin +main',
    'GIT_SSH_COMMAND=evil git push',
  ])('a "git push" rule still asks for %j', async (command) => {
    addRule('git push', 'prefix');
    await expectAsks(command);
  });

  it.each(['sudo ls', 'rm -rf build', 'kill 1', 'git reset --hard', 'git clean -fd', 'cat .env', 'cat ~/.ssh/id_rsa', 'ls !!'])('%s asks even under the widest rules', async (command) => {
    const p = parseCommand(command);
    if (p.ok) {
      addRule(p.words[0]!, 'prefix', { project_id: null });
      rules.push({ ...rule(command, 'exact'), id: 'exact-wide', project_id: null });
    }
    await expectAsks(command);
  });

  it('a prefix rule never covers ssh with any command after it', async () => {
    addRule('ssh hulk', 'prefix');
    await expectAsks('ssh hulk rm -rf /');
    const exact = addRule('ssh hulk uptime', 'exact');
    run.mockClear();
    await expectRuns('ssh hulk uptime', exact.id);
  });

  it('never covers an agent tab, even with a rule', async () => {
    addRule('git push', 'prefix');
    await expectAsks('git push', 'agent');
  });

  it('a card already waiting for the same command keeps waiting: a rule never answers it', async () => {
    await expectAsks('npm test');
    addRule('npm test', 'exact');
    expect(await call('npm test')).toMatchObject({ ok: false, code: 'CONFIRMATION_WAITING' });
    expect(run).not.toHaveBeenCalled();
  });
});
