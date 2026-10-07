import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { feedLine } from './automation-feed';
import type { AutomationFeedEvent } from './types';

const ev = (over: Partial<AutomationFeedEvent>): AutomationFeedEvent => ({
  id: 'x', kind: 'run_started', created_at: '2026-10-05T10:00:00.000Z', project_id: 'p', task_id: 't', run_id: 'r', tab_id: 'tab', ref: 'TER-9', epic: 'Épico',
  machine: 'jarvis', account: 'pessoal', branch: null, workflow: null, version: null, pr: null, url: null, until: null, reason_text: null, paused: null, tool: null, ...over,
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

describe('auto-approved and guard-blocked lines (TER-993)', () => {
  it('names the tool, in pt-BR and en, and falls back without one', () => {
    expect(feedLine(ev({ kind: 'permission_auto_approved', tool: 'Bash' }))).toBe('TER-9: Bash liberado sozinho');
    expect(feedLine(ev({ kind: 'permission_auto_approved', tool: 'mcp__termhub__create_task' }))).toBe('TER-9: create_task liberado sozinho');
    expect(feedLine(ev({ kind: 'permission_auto_approved', tool: null }))).toBe('TER-9: permissão liberada sozinha');
    expect(feedLine(ev({ kind: 'guard_blocked', tool: 'Bash' }))).toBe('TER-9: Bash bloqueado pela trava');
    expect(feedLine(ev({ kind: 'guard_blocked', tool: null }))).toBe('TER-9: ação bloqueada pela trava');
  });
  it('has the English copy', async () => {
    await i18n.changeLanguage('en');
    expect(feedLine(ev({ kind: 'permission_auto_approved', tool: 'mcp__termhub__create_task' }))).toBe('TER-9: create_task allowed automatically');
    expect(feedLine(ev({ kind: 'guard_blocked', tool: 'Bash' }))).toBe('TER-9: Bash blocked by the guard');
  });
});

describe('a start that failed (TER-987)', () => {
  it('says why it did not start, and keeps the plain line for any other block', async () => {
    expect(feedLine(ev({ kind: 'run_blocked', reason_text: 'A máquina não respondeu' }))).toBe('TER-9 não começou: A máquina não respondeu');
    expect(feedLine(ev({ kind: 'run_blocked' }))).toBe('TER-9: parou e espera você');
    await i18n.changeLanguage('en');
    expect(feedLine(ev({ kind: 'run_blocked', reason_text: 'The machine did not answer' }))).toBe('TER-9 did not start: The machine did not answer');
  });
});
