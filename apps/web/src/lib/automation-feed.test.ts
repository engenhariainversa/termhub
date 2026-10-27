import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { feedLine, feedWhy } from './automation-feed';
import type { AutomationFeedEvent } from './types';

const ev = (over: Partial<AutomationFeedEvent>): AutomationFeedEvent => ({
  id: 'x', kind: 'run_started', created_at: '2026-10-05T10:00:00.000Z', project_id: 'p', task_id: 't', run_id: 'r', tab_id: 'tab', ref: 'TER-9', epic: 'Épico',
  machine: 'jarvis', account: 'pessoal', branch: null, workflow: null, version: null, pr: null, url: null, until: null, reason_text: null, paused: null, tool: null, why_text: null, rule_ref: null, score: null, ...over,
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

describe('the folder trust dialog answered alone (TER-1025, TER-1117)', () => {
  it("names the run's card, or shows the server's line for a tab in the project's own folder", () => {
    expect(feedLine(ev({ kind: 'trust_auto_accepted' }))).toBe('TER-9: confiança da pasta confirmada sozinha');
    expect(feedLine(ev({ kind: 'trust_auto_accepted', task_id: null, run_id: null, ref: null, reason_text: 'Aba api: pasta do projeto confiada sozinha' }))).toBe('Aba api: pasta do projeto confiada sozinha');
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

describe('decisions taken alone (TER-1043)', () => {
  it('shows the agent\'s summary, or the nudge line without one, in pt-BR and en', async () => {
    expect(feedLine(ev({ kind: 'decided_by_recommendation', summary: 'Cor do botão? → Azul' }))).toBe('TER-9 decidiu sozinho: Cor do botão? → Azul');
    expect(feedLine(ev({ kind: 'decided_by_recommendation' }))).toBe('TER-9: seguiu a própria recomendação (registrada no PR)');
    await i18n.changeLanguage('en');
    expect(feedLine(ev({ kind: 'decided_by_recommendation', summary: 'x → y' }))).toBe('TER-9 decided alone: x → y');
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

describe('why an automatic answer or escalation happened (TER-1011)', () => {
  it('is null without a reason', () => {
    expect(feedWhy(ev({ kind: 'question_answered' }))).toBeNull();
    expect(feedWhy({})).toBeNull();
  });
  it('names a precedent with its similarity', () => {
    expect(feedWhy(ev({ kind: 'question_answered', why_text: 'respondida com uma decisão sua de antes', rule_ref: 'decision:abc', score: 0.874 }))).toBe(
      'Motivo: respondida com uma decisão sua de antes · Precedente: decision:abc · Similaridade: 87%',
    );
    expect(feedWhy(ev({ rule_ref: 'note:n1' }))).toBe('Precedente: note:n1');
  });
  it('names an allow rule', () => {
    expect(feedWhy(ev({ kind: 'permission_auto_approved', rule_ref: 'Bash(npm test:*)' }))).toBe('Regra: Bash(npm test:*)');
  });
  it('gives the reason alone', () => {
    expect(feedWhy(ev({ kind: 'escalated', why_text: 'nenhuma regra vigente cobre' }))).toBe('Motivo: nenhuma regra vigente cobre');
  });
  it('has the English copy', async () => {
    await i18n.changeLanguage('en');
    expect(feedWhy(ev({ why_text: 'x', rule_ref: 'decision:abc', score: 0.5 }))).toBe('Why: x · Precedent: decision:abc · Similarity: 50%');
    expect(feedWhy(ev({ rule_ref: 'mcp__termhub__create_task' }))).toBe('Rule: mcp__termhub__create_task');
  });
});
describe('a cancelled run (TER-974)', () => {
  it('says why when the server knows', async () => {
    expect(feedLine(ev({ kind: 'run_cancelled', reason_text: 'a aba foi fechada' }))).toBe('TER-9: cancelado — a aba foi fechada');
    expect(feedLine(ev({ kind: 'run_cancelled' }))).toBe('TER-9: cancelado');
    await i18n.changeLanguage('en');
    expect(feedLine(ev({ kind: 'run_cancelled', reason_text: 'the tab was closed' }))).toBe('TER-9: cancelled — the tab was closed');
  });
});

describe('a blocked run a PR took over (TER-1049)', () => {
  it('says so on its run_done line, and keeps the plain line for any other', () => {
    expect(feedLine(ev({ kind: 'run_done', reason_text: 'PR aberto depois do bloqueio; o automático acompanha até o merge' }))).toBe('TER-9: PR aberto depois do bloqueio; o automático acompanha até o merge');
    expect(feedLine(ev({ kind: 'run_done' }))).toBe('TER-9: agente terminou');  });
});
