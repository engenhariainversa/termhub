import { describe, expect, it } from 'vitest';
import { automationSchema } from '../setup/schema.js';
import { eligibilityOf, REASON_TEXT, type EligibilityInput } from './eligibility.js';

const input = (card: Partial<EligibilityInput['card']> = {}, project: Partial<EligibilityInput['project']> = {}, automation: Record<string, unknown> = {}): EligibilityInput => ({
  card: { type: 'task', parent_id: null, auto: true, column_category: 'todo', description: 'Do it', subtask_count: 0, tab_alive: false, active_run: false, ...card },
  project: { automation: automationSchema.parse({ enabled: true, ...automation }), paused: false, repo_ready: true, capable_machines: 1, ...project },
});
const reason = (i: EligibilityInput) => {
  const r = eligibilityOf(i);
  return r && !r.eligible ? r.reason : r;
};

describe('eligibilityOf', () => {
  it('a tagged card that passes every check is eligible', () => {
    expect(eligibilityOf(input())).toEqual({ eligible: true });
  });
  it('untagged cards and subtasks are not in the queue', () => {
    expect(eligibilityOf(input({ auto: false }))).toBeNull();
    expect(eligibilityOf(input({ type: 'subtask', parent_id: 'k1' }))).toBeNull();
  });
  it('reads each reason of spec 5 in order, the first failing check winning', () => {
    const all = input({ type: 'spike', column_category: 'doing', description: null, tab_alive: true }, { paused: true, repo_ready: false, capable_machines: 0 }, { enabled: false });
    expect(reason(all)).toBe('automation_off');
    all.project.automation.enabled = true;
    expect(reason(all)).toBe('paused');
    all.project.paused = false;
    expect(reason(all)).toBe('type_not_allowed');
    all.card.type = 'task';
    expect(reason(all)).toBe('not_in_todo');
    all.card.column_category = 'todo';
    expect(reason(all)).toBe('no_description');
    all.card.description = 'x';
    expect(reason(all)).toBe('has_agent');
    all.card.tab_alive = false;
    expect(reason(all)).toBe('no_capable_machine');
    all.project.capable_machines = 1;
    expect(reason(all)).toBe('repo_missing');
    all.project.repo_ready = true;
    expect(eligibilityOf(all)).toEqual({ eligible: true });
  });
  it('a spike runs only when the project lists it', () => {
    expect(reason(input({ type: 'spike' }))).toBe('type_not_allowed');
    expect(eligibilityOf(input({ type: 'spike' }, {}, { types: ['spike'] }))).toEqual({ eligible: true });
  });
  it('a card in doing, in the backlog or done is not in todo', () => {
    expect(reason(input({ column_category: 'doing' }))).toBe('not_in_todo');
    expect(reason(input({ column_category: null }))).toBe('not_in_todo');
    expect(reason(input({ column_category: 'done' }))).toBe('not_in_todo');
  });
  it('subtasks stand in for a description; an active run counts as an agent', () => {
    expect(eligibilityOf(input({ description: ' ', subtask_count: 2 }))).toEqual({ eligible: true });
    expect(reason(input({ description: null }))).toBe('no_description');
    expect(reason(input({ active_run: true }))).toBe('has_agent');
  });
  it('has pt-BR text for every reason', () => {
    expect(REASON_TEXT.no_capable_machine).toBe('Nenhuma máquina com agente 0.19 ligada ao projeto; atualize o agente');
    expect(REASON_TEXT.paused).toBe('Automático pausado');
  });
});
