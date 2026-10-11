import { describe, expect, it } from 'vitest';
import { autonomyConfirmText, needsAutonomyConfirm, untaggedUnderEpic } from './automation';
import type { AutomationAutonomy, Task } from './types';

const st = (enabled: boolean, autonomy: AutomationAutonomy) => ({ enabled, autonomy });

describe('autonomyConfirmText', () => {
  it('uses the exact copy of each level', () => {
    expect(autonomyConfirmText('pr')).toBe('Os agentes vão pegar os cards marcados e abrir PRs sozinhos; o merge continua com você. Confirmar?');
    expect(autonomyConfirmText('merge')).toBe('Os agentes vão pegar os cards marcados, abrir PRs e fazer merge com CI verde sem perguntar. Confirmar?');
    expect(autonomyConfirmText('deploy')).toBe('Os agentes vão pegar os cards marcados, abrir PRs, fazer merge e deploy sem perguntar. Confirmar?');
    expect(autonomyConfirmText('release')).toBe('Os agentes vão pegar os cards marcados, abrir PRs, fazer merge, deploy e publicar (npm, OTA) sem perguntar. Confirmar?');
  });
});

describe('needsAutonomyConfirm', () => {
  it.each(['pr', 'merge', 'deploy', 'release'] as const)('asks when turning it on at %s', (level) => {
    expect(needsAutonomyConfirm(st(false, level), st(true, level))).toBe(true);
  });
  it('asks when raising to deploy or release while on', () => {
    expect(needsAutonomyConfirm(st(true, 'pr'), st(true, 'deploy'))).toBe(true);
    expect(needsAutonomyConfirm(st(true, 'merge'), st(true, 'deploy'))).toBe(true);
    expect(needsAutonomyConfirm(st(true, 'deploy'), st(true, 'release'))).toBe(true);
  });
  it('does not ask on pr to merge, on lowering, on no change or on turning off', () => {
    expect(needsAutonomyConfirm(st(true, 'pr'), st(true, 'merge'))).toBe(false);
    expect(needsAutonomyConfirm(st(true, 'release'), st(true, 'deploy'))).toBe(false);
    expect(needsAutonomyConfirm(st(true, 'deploy'), st(true, 'pr'))).toBe(false);
    expect(needsAutonomyConfirm(st(true, 'deploy'), st(true, 'deploy'))).toBe(false);
    expect(needsAutonomyConfirm(st(true, 'release'), st(false, 'release'))).toBe(false);
  });
  it('does not ask when raising the level while it stays off', () => {
    expect(needsAutonomyConfirm(st(false, 'pr'), st(false, 'release'))).toBe(false);
  });
});

describe('untaggedUnderEpic', () => {
  const card = (id: string, o: Partial<Task>): Task => ({ id, type: 'task', epic_id: 'e1', parent_id: null, auto: false, ...o }) as Task;
  const epic = card('e1', { type: 'epic', epic_id: null });

  it('counts untagged top-level cards of the epic plus the epic itself', () => {
    const tasks = [epic, card('a', {}), card('b', { type: 'bug' }), card('c', { auto: true }), card('d', { parent_id: 'a', type: 'subtask' }), card('x', { epic_id: 'e2' })];
    expect(untaggedUnderEpic(epic, tasks)).toBe(3);
  });
  it('does not count an already tagged epic', () => {
    const tagged = { ...epic, auto: true };
    expect(untaggedUnderEpic(tagged, [tagged, card('a', {})])).toBe(1);
  });
});
