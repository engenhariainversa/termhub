import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { feedLine } from './automation-feed';
import type { AutomationFeedEvent } from './types';

const ev = (over: Partial<AutomationFeedEvent>): AutomationFeedEvent => ({
  id: 'x', kind: 'run_started', created_at: '2026-10-05T10:00:00.000Z', project_id: 'p', task_id: 't', run_id: 'r', tab_id: 'tab', ref: 'TER-9', epic: 'Épico',
  machine: 'jarvis', account: 'pessoal', branch: null, workflow: null, version: null, pr: null, url: null, until: null, reason_text: null, paused: null, ...over,
});

afterEach(() => {
  void i18n.changeLanguage('pt-BR');
});

describe('feed lines for changes to automatic work (TER-975)', () => {
  it('writes each kind in pt-BR', () => {
    expect(feedLine(ev({ kind: 'automation_on' }))).toBe('Automático ligado no projeto');
    expect(feedLine(ev({ kind: 'automation_off' }))).toBe('Automático desligado no projeto');
    expect(feedLine(ev({ kind: 'setup_changed' }))).toBe('Setup do automático alterado');
    expect(feedLine(ev({ kind: 'tagged' }))).toBe('TER-9: marcado como automático');
    expect(feedLine(ev({ kind: 'untagged' }))).toBe('TER-9: tirado do automático');
    expect(feedLine(ev({ kind: 'machine_opt_in' }))).toBe('jarvis passou a aceitar trabalho automático');
    expect(feedLine(ev({ kind: 'machine_opt_out', machine: null }))).toBe('Uma máquina deixou de aceitar trabalho automático');
  });

  it('has the English copy', async () => {
    await i18n.changeLanguage('en');
    expect(feedLine(ev({ kind: 'automation_on' }))).toBe('Automatic work turned on for the project');
    expect(feedLine(ev({ kind: 'untagged' }))).toBe('TER-9: removed from automatic work');
    expect(feedLine(ev({ kind: 'machine_opt_out' }))).toBe('jarvis no longer accepts automatic work');
  });
});
