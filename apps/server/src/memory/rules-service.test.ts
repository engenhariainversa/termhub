import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../chat/gate-runtime.js', () => ({ askForAutomation: vi.fn(async () => ({ id: 'a1' })) }));
vi.mock('../automation/setup-tools.js', () => ({ setAutomationPolicy: vi.fn(async () => ({})) }));
vi.mock('../chat/bus.js', () => ({ chatBus: { publish: vi.fn() } }));

import { askForAutomation } from '../chat/gate-runtime.js';
import { setAutomationPolicy } from '../automation/setup-tools.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { MemoryRule } from '../db/repositories/memory-rules.js';
import { applyPolicyCard, approveRule, policyCardKey, rejectRule, statementOf } from './rules-service.js';

const log = { info: vi.fn(), warn: vi.fn() };
const deps = { embedder: null, log, threshold: 0.9 };

const rule = (over: Partial<MemoryRule> = {}): MemoryRule => ({
  id: 'r1',
  owner_id: 'u1',
  project_id: null,
  project_name: null,
  kind: 'rule',
  status: 'proposed',
  text: 'Pode rodar os testes sem perguntar',
  policy: null,
  source_refs: ['note:a', 'note:b'],
  fingerprint: 'f',
  note_id: null,
  decided_at: null,
  decided_by: null,
  created_at: '2026-10-07T00:00:00.000Z',
  ...over,
});

const action = (over: Partial<ChatAction> = {}): ChatAction =>
  ({ id: 'a1', conversation_id: 'c1', tool: 'set_automation_policy', status: 'approved', idempotency_key: policyCardKey('r1', 'p1'), decided_at: '2026-10-07T00:00:00.000Z', ...over }) as ChatAction;

function fakeRepos(current: MemoryRule) {
  let row = current;
  const decide = vi.fn(async (_id: string, _owner: string, from: string[], to: string, by: string | null, extra: Partial<MemoryRule> = {}) => {
    if (!from.includes(row.status)) return null;
    row = { ...row, ...extra, status: to as MemoryRule['status'], decided_by: by, decided_at: '2026-10-07T01:00:00.000Z' };
    return row;
  });
  const repos = {
    memoryRules: {
      findForOwner: vi.fn(async () => row),
      findById: vi.fn(async () => row),
      decide,
      setPolicy: vi.fn(async (_id: string, policy: MemoryRule['policy']) => {
        row = { ...row, policy };
      }),
    },
    memoryItems: { upsertMany: vi.fn(async (items: { id: string }[]) => items), deleteNote: vi.fn() },
    projects: { findById: vi.fn(async (id: string) => ({ id, owner_id: id === 'px' ? 'u2' : 'u1' })) },
    users: { findById: vi.fn(async (id: string) => ({ id })) },
    chatActions: {
      claimApproved: vi.fn(async () => true),
      markExecuted: vi.fn(),
      findLatestByKeyInProject: vi.fn(async () => action({ status: 'executed' })),
    },
  } as unknown as Repositories;
  return { repos, decide, get: () => row };
}

beforeEach(() => vi.clearAllMocks());

describe('statementOf', () => {
  it('reads a note\'s decision line and a decision\'s question with its answer', () => {
    expect(statementOf({ ref: 'note:a', text: 'Decisão: Pode mesclar.\nMotivo: x\nFontes:', answer: null })).toBe('Pode mesclar.');
    expect(statementOf({ ref: 'decision:d', text: 'Pode mesclar?', answer: { labels: ['Sim'], text: 'com CI verde' } })).toBe('Pode mesclar? → Sim — com CI verde');
  });
});

describe('approveRule', () => {
  it('approves a rule and indexes it as the person\'s own note', async () => {
    const { repos, get } = fakeRepos(rule());
    await approveRule(repos, 'u1', 'r1', { text: 'Pode rodar os testes de banco' }, deps);
    expect(get()).toMatchObject({ status: 'approved', text: 'Pode rodar os testes de banco' });
    expect(get().note_id).toBeTruthy();
    const [items] = vi.mocked(repos.memoryItems.upsertMany).mock.calls[0]!;
    expect(items[0]).toMatchObject({ kind: 'note', trust: 'person', owner_id: 'u1' });
  });

  it('never changes the Setup for a policy: it asks one set_automation_policy card per project still the owner\'s', async () => {
    const { repos, get } = fakeRepos(rule({ kind: 'policy', policy: { autonomy: 'merge', project_ids: ['p1', 'p2', 'px'] } }));
    await approveRule(repos, 'u1', 'r1', {}, deps);
    expect(setAutomationPolicy).not.toHaveBeenCalled();
    expect(askForAutomation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(askForAutomation).mock.calls.map((c) => c[3])).toEqual([
      { tool: 'set_automation_policy', args: { project_id: 'p1', autonomy: 'merge' }, key: policyCardKey('r1', 'p1') },
      { tool: 'set_automation_policy', args: { project_id: 'p2', autonomy: 'merge' }, key: policyCardKey('r1', 'p2') },
    ]);
    expect(get()).toMatchObject({ status: 'awaiting_confirmation', policy: { project_ids: ['p1', 'p2'], applied: [] } });
  });

  it('refuses a proposal already decided', async () => {
    const { repos } = fakeRepos(rule({ status: 'rejected' }));
    await expect(approveRule(repos, 'u1', 'r1', {}, deps)).rejects.toMatchObject({ statusCode: 409, code: 'RULE_DECIDED' });
  });
});

describe('rejectRule', () => {
  it('stores the rejection with its time', async () => {
    const { repos, get } = fakeRepos(rule());
    await rejectRule(repos, 'u1', 'r1');
    expect(get()).toMatchObject({ status: 'rejected', decided_by: 'u1' });
    expect(get().decided_at).toBeTruthy();
  });
});

describe('applyPolicyCard', () => {
  const waiting = () => rule({ kind: 'policy', status: 'awaiting_confirmation', policy: { autonomy: 'merge', project_ids: ['p1'], applied: [] } });

  it('applies an approved card through set_automation_policy, with the card as the approval, then settles the rule', async () => {
    const { repos, get } = fakeRepos(waiting());
    await applyPolicyCard(repos, action(), deps);
    expect(setAutomationPolicy).toHaveBeenCalledTimes(1);
    const [ctx, input] = vi.mocked(setAutomationPolicy).mock.calls[0]!;
    expect(ctx.approval?.actionId).toBe('a1');
    expect(input).toEqual({ project_id: 'p1', autonomy: 'merge' });
    expect(get()).toMatchObject({ status: 'approved', policy: { applied: ['p1'] } });
  });

  it('leaves the concierge\'s own set_automation_policy cards alone', async () => {
    const { repos } = fakeRepos(waiting());
    await applyPolicyCard(repos, action({ idempotency_key: 'something-else' }), deps);
    expect(setAutomationPolicy).not.toHaveBeenCalled();
  });

  it('does nothing for a card that was not approved, or already claimed', async () => {
    const { repos } = fakeRepos(waiting());
    await applyPolicyCard(repos, action({ status: 'denied' }), deps);
    vi.mocked(repos.chatActions.claimApproved).mockResolvedValueOnce(false);
    await applyPolicyCard(repos, action(), deps);
    expect(setAutomationPolicy).not.toHaveBeenCalled();
  });
});
