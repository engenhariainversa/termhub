import type { TAutomationSetup } from '@/services/api/contract';
import { autonomyConfirmText, isChanged, needsConfirm, toggleType } from './automation';

const block = (over: Partial<TAutomationSetup> = {}): TAutomationSetup => ({ enabled: false, types: ['story', 'task', 'bug'], autonomy: 'pr', worktrees_dir: '~/wt', ...over });

describe('automation setup rules', () => {
  it('asks when turning on, and when raising to deploy or release only', () => {
    expect(needsConfirm(block(), block({ enabled: true }))).toBe(true);
    expect(needsConfirm(block({ enabled: true }), block({ enabled: true, autonomy: 'merge' }))).toBe(false);
    expect(needsConfirm(block({ enabled: true }), block({ enabled: true, autonomy: 'deploy' }))).toBe(true);
    expect(needsConfirm(block({ enabled: true, autonomy: 'deploy' }), block({ enabled: true, autonomy: 'release' }))).toBe(true);
  });

  it('never asks when lowering the level or turning off', () => {
    expect(needsConfirm(block({ enabled: true, autonomy: 'release' }), block({ enabled: true, autonomy: 'pr' }))).toBe(false);
    expect(needsConfirm(block({ enabled: true, autonomy: 'release' }), block({ enabled: false, autonomy: 'release' }))).toBe(false);
  });

  it('uses the same confirmation copy as the web', () => {
    expect(autonomyConfirmText('pr')).toBe('Os agentes vão pegar os cards marcados e abrir PRs sozinhos; o merge continua com você. Confirmar?');
    expect(autonomyConfirmText('release')).toContain('publicar (npm, OTA)');
  });

  it('toggles a card type but keeps at least one', () => {
    expect(toggleType(block(), 'spike').types).toEqual(['story', 'task', 'bug', 'spike']);
    expect(toggleType(block(), 'task').types).toEqual(['story', 'bug']);
    const one = block({ types: ['bug'] });
    expect(toggleType(one, 'bug')).toBe(one);
  });

  it('detects a change and keeps fields it does not edit', () => {
    const saved = block();
    expect(isChanged(saved, { ...saved })).toBe(false);
    const next = toggleType(saved, 'spike');
    expect(isChanged(saved, next)).toBe(true);
    expect(next.worktrees_dir).toBe('~/wt');
  });
});
