import { setLocale } from '@/i18n';
import type { TAutomationFeedEvent } from '@/services/api/contract';
import { feedLine } from './feed';

const ev = (over: Partial<TAutomationFeedEvent>): TAutomationFeedEvent => ({
  id: 'x', kind: 'run_started', created_at: '2026-10-05T10:00:00.000Z', project_id: 'p', task_id: 't', run_id: 'r', tab_id: 'tab', ref: 'TER-9', epic: 'Épico',
  machine: 'jarvis', account: 'pessoal', branch: null, workflow: null, version: null, pr: null, url: null, until: null, reason_text: null, paused: null, ...over,
});

describe('feedLine', () => {
  it('writes the copy of the spec for each kind', () => {
    expect(feedLine(ev({}))).toBe('TER-9 iniciado em jarvis (pessoal)');
    expect(feedLine(ev({ kind: 'pr_opened' }))).toBe('TER-9: PR aberto');
    expect(feedLine(ev({ kind: 'merged', branch: 'main' }))).toBe('TER-9: merge feito na main');
    expect(feedLine(ev({ kind: 'deploy_ok' }))).toBe('Deploy concluído (Épico)');
    expect(feedLine(ev({ kind: 'deploy_failed', paused: true }))).toBe('Deploy falhou (Épico) — automático pausado no projeto');
    expect(feedLine(ev({ kind: 'deploy_failed', paused: false }))).toBe('Deploy falhou (Épico)');
    expect(feedLine(ev({ kind: 'release_ok', workflow: 'npm', version: '1.2.0' }))).toBe('Publicado npm 1.2.0');
    expect(feedLine(ev({ kind: 'escalated', reason_text: 'Confirme na aba.' }))).toBe('TER-9 precisa de você: Confirme na aba.');
  });

  it('has a line for every kind the server records and none for an unknown one', () => {
    const kinds = ['run_started', 'run_resumed', 'run_done', 'run_blocked', 'question_answered', 'escalated', 'pr_opened', 'merged', 'merge_needs_approval', 'deploy_ok', 'deploy_failed', 'release_ok', 'release_failed', 'quota_hit', 'quota_reset', 'paused', 'resumed', 'budget_hit', 'ci_fix_requested', 'worktree_cleanup'];
    for (const kind of kinds) expect(feedLine(ev({ kind }))).toBeTruthy();
    expect(feedLine(ev({ kind: 'from_the_future' }))).toBeNull();
  });

  it('in English', () => {
    setLocale('en');
    try {
      expect(feedLine(ev({ kind: 'merged', branch: 'main' }))).toBe('TER-9: merged into main');
    } finally {
      setLocale(null);
    }
  });
});
