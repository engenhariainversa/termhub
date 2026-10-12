import { describe, expect, it } from 'vitest';
import { autonomyOf, consolidate, fingerprintOf, isPermission, isSuppressed, type ExistingRule, type ProjectPolicy, type RuleSource } from './rules.js';

const now = new Date('2026-10-07T12:00:00.000Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const src = (ref: string, project_id: string | null, statement: string, created_at = daysAgo(1), title = 'Pergunta'): RuleSource => ({ ref, project_id, title, statement, created_at });
const rule = (r: Partial<ExistingRule> & Pick<ExistingRule, 'status' | 'source_refs'>): ExistingRule => ({
  id: 'r1',
  kind: 'rule',
  project_id: null,
  fingerprint: 'f',
  note_id: null,
  decided_at: null,
  ...r,
});
const noPolicies = new Map<string, ProjectPolicy>();

describe('isPermission / autonomyOf', () => {
  it('reads a grant, and not a refusal', () => {
    expect(isPermission('Pode rodar os testes de banco sem perguntar.')).toBe(true);
    expect(isPermission('Não precisa pedir confirmação para abrir abas.')).toBe(true);
    expect(isPermission('Nunca rodar docker na máquina.')).toBe(false);
    expect(isPermission('Usar o node 22 no CI.')).toBe(false);
  });

  it('takes the highest level the granting clauses name, and ignores a negated clause', () => {
    expect(autonomyOf('Pode mesclar com o CI verde e fazer o deploy sem perguntar.')).toEqual({ autonomy: 'deploy' });
    expect(autonomyOf('Pode mesclar sozinho. Nunca publicar no npm.')).toEqual({ autonomy: 'merge' });
    expect(autonomyOf('Pode rodar 3 cards em paralelo.')).toEqual({ max_parallel: 3 });
    expect(autonomyOf('Nunca mesclar sozinho.')).toBeNull();
    expect(autonomyOf('Pode abrir o PR.')).toBeNull();
  });
});

describe('consolidate', () => {
  it('turns the same permission saved in 4 projects into one proposal at the user level', () => {
    const sources = ['p1', 'p2', 'p3', 'p4'].map((p, i) =>
      src(`note:n${i}`, p, 'Pode rodar os testes de banco do servidor sem perguntar', daysAgo(i + 1), 'Os agentes podem rodar os testes de banco?'),
    );
    const out = consolidate({ sources, pairs: [], rules: [], policies: noPolicies, now });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'rule', project_id: null, policy: null, text: 'Pode rodar os testes de banco do servidor sem perguntar' });
    expect(out[0]!.source_refs).toEqual(['note:n0', 'note:n1', 'note:n2', 'note:n3']);
  });

  it('groups through the pgvector pairs when the words differ', () => {
    const sources = [src('note:a', 'p1', 'Pode instalar dependências sem perguntar'), src('decision:b', 'p2', 'Liberado: npm ci é permitido')];
    expect(consolidate({ sources, pairs: [], rules: [], policies: noPolicies, now })).toEqual([]);
    const out = consolidate({ sources, pairs: [['note:a', 'decision:b']], rules: [], policies: noPolicies, now });
    expect(out).toHaveLength(1);
    expect(out[0]!.project_id).toBeNull();
  });

  it('makes a project rule from two notes of one project, and nothing from a single note', () => {
    const one = [src('note:a', 'p1', 'Os commits do projeto usam inglês no título')];
    expect(consolidate({ sources: one, pairs: [], rules: [], policies: noPolicies, now })).toEqual([]);
    const two = [...one, src('note:b', 'p1', 'Os commits do projeto usam inglês no título e no corpo', daysAgo(0))];
    const out = consolidate({ sources: two, pairs: [], rules: [], policies: noPolicies, now });
    expect(out).toEqual([expect.objectContaining({ kind: 'rule', project_id: 'p1', text: 'Os commits do projeto usam inglês no título e no corpo' })]);
  });

  it('turns an autonomy permission into a policy proposal for the projects it widens only', () => {
    const sources = ['p1', 'p2'].map((p, i) => src(`note:m${i}`, p, 'Pode mesclar o PR sozinho com o CI verde', daysAgo(i + 1)));
    const policies = new Map<string, ProjectPolicy>([
      ['p1', { autonomy: 'pr', max_parallel: 1 }],
      ['p2', { autonomy: 'release', max_parallel: null }],
    ]);
    const out = consolidate({ sources, pairs: [], rules: [], policies, now });
    expect(out).toEqual([expect.objectContaining({ kind: 'policy', project_id: 'p1', policy: { autonomy: 'merge', project_ids: ['p1'] } })]);
  });

  it('falls back to a user rule when every project already allows the autonomy', () => {
    const sources = ['p1', 'p2'].map((p, i) => src(`note:m${i}`, p, 'Pode mesclar o PR sozinho com o CI verde', daysAgo(i + 1)));
    const policies = new Map<string, ProjectPolicy>([
      ['p1', { autonomy: 'deploy', max_parallel: null }],
      ['p2', { autonomy: 'merge', max_parallel: null }],
    ]);
    expect(consolidate({ sources, pairs: [], rules: [], policies, now })).toEqual([expect.objectContaining({ kind: 'rule', project_id: null })]);
  });

  it('leaves out the sources an approved rule supersedes', () => {
    const sources = ['p1', 'p2'].map((p, i) => src(`note:n${i}`, p, 'Pode rodar os testes sem perguntar'));
    const rules = [rule({ status: 'approved', source_refs: ['note:n0', 'note:n1'], note_id: 'r' })];
    expect(consolidate({ sources: [...sources, src('note:r', null, 'Pode rodar os testes sem perguntar')], pairs: [], rules, policies: noPolicies, now })).toEqual([]);
  });

  it('respects a rejection for 180 days, then proposes again', () => {
    const sources = ['p1', 'p2'].map((p, i) => src(`note:n${i}`, p, 'Pode rodar os testes sem perguntar'));
    const first = consolidate({ sources, pairs: [], rules: [], policies: noPolicies, now })[0]!;
    const rejected = (days: number) => [rule({ status: 'rejected', source_refs: first.source_refs, fingerprint: first.fingerprint, decided_at: daysAgo(days) })];
    expect(consolidate({ sources, pairs: [], rules: rejected(179), policies: noPolicies, now })).toEqual([]);
    // one more project saying the same does not bring it back
    const more = [...sources, src('note:n2', 'p3', 'Pode rodar os testes sem perguntar')];
    expect(consolidate({ sources: more, pairs: [], rules: rejected(10), policies: noPolicies, now })).toEqual([]);
    expect(consolidate({ sources, pairs: [], rules: rejected(180), policies: noPolicies, now })).toHaveLength(1);
  });
});

describe('isSuppressed / fingerprintOf', () => {
  it('only holds against the same kind and scope', () => {
    const rejected = [rule({ status: 'rejected', source_refs: ['note:a', 'note:b'], decided_at: daysAgo(1) })];
    expect(isSuppressed({ kind: 'rule', project_id: null, source_refs: ['note:a', 'note:b'] }, rejected, now)).toBe(true);
    expect(isSuppressed({ kind: 'policy', project_id: null, source_refs: ['note:a', 'note:b'] }, rejected, now)).toBe(false);
    expect(isSuppressed({ kind: 'rule', project_id: 'p1', source_refs: ['note:a', 'note:b'] }, rejected, now)).toBe(false);
    expect(isSuppressed({ kind: 'rule', project_id: null, source_refs: ['note:a', 'note:c', 'note:d'] }, rejected, now)).toBe(false);
  });

  it('does not depend on the order of the refs', () => {
    expect(fingerprintOf({ kind: 'rule', project_id: null, policy: null, source_refs: ['b', 'a'] })).toBe(fingerprintOf({ kind: 'rule', project_id: null, policy: null, source_refs: ['a', 'b'] }));
  });
});
