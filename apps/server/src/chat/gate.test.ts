import { describe, expect, it } from 'vitest';
import {
  actionClass,
  BOARD_GRANT_TOOLS,
  boardGrantable,
  DEFAULT_ALLOW_BUDGETS,
  DEFAULT_ALLOW_KINDS,
  defaultGrantId,
  defaultKindOf,
  isDefaultGrantId,
  gateDecision,
  grantable,
  idempotencyKeyFor,
  standingKindOf,
  STANDING_BUDGET_WINDOW_MS,
  STANDING_GRANT_BUDGETS,
  terminalGrantable,
} from './gate.js';
import { TOOLS } from '../mcp/tools.js';

it('classifies every tool the MCP exposes, and defaults an unknown one to irreversible', () => {
  expect(actionClass('list_machines', {})).toBe('read');
  expect(actionClass('list_project_groups', {})).toBe('read');
  expect(actionClass('read_screen', { tab_id: 't1' })).toBe('read');
  expect(actionClass('read_last_answer', { tab_id: 't1', offset: 20_000 })).toBe('read');
  expect(actionClass('read_attachment', { id: 'abc123' })).toBe('read');
  expect(actionClass('send_input', { tab_id: 't1', text: 'oi' })).toBe('write');
  expect(actionClass('start_agent', {})).toBe('write');
  // TER-499: links a card to an open tab; it moves the card like move_task does, so it asks like one
  expect(actionClass('link_tab_task', { tab_id: 't1', task_id: 'k1' })).toBe('write');
  expect(actionClass('close_tab', { tab_id: 't1' })).toBe('irreversible');
  expect(actionClass('delete_task', { task_id: 'k1' })).toBe('irreversible');
  // a tool added later must not silently become auto-allowed
  expect(actionClass('drop_everything', {})).toBe('irreversible');
});

it('classifies link_project_machine and set_project_machine_cwd as write, and unlink_project_machine as write or irreversible depending on confirm', () => {
  expect(actionClass('link_project_machine', { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub' })).toBe('write');
  expect(actionClass('set_project_machine_cwd', { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub' })).toBe('write');
  expect(actionClass('unlink_project_machine', { project_id: 'p1', machine_id: 'm1' })).toBe('write');
  expect(actionClass('unlink_project_machine', { project_id: 'p1', machine_id: 'm1', confirm: true })).toBe('irreversible');
  expect(actionClass('unlink_project_machine', { project_id: 'p1', machine_id: 'm1', confirm: false })).toBe('write');
});

it('treats an interrupting key as irreversible and an ordinary one as a write', () => {
  expect(actionClass('send_key', { tab_id: 't1', key: 'C-c' })).toBe('irreversible');
  expect(actionClass('send_key', { tab_id: 't1', key: 'Escape' })).toBe('irreversible');
  expect(actionClass('send_key', { tab_id: 't1', key: 'Enter' })).toBe('write');
});

it('pause_automation is the brake: self-mediated alone, a write with interrupt (it sends Escape); resume asks', () => {
  expect(actionClass('pause_automation', {})).toBe('self_mediated');
  expect(actionClass('pause_automation', { project_id: 'p1', interrupt: false })).toBe('self_mediated');
  expect(actionClass('pause_automation', { project_id: 'p1', interrupt: true })).toBe('write');
  expect(actionClass('resume_automation', { project_id: 'p1' })).toBe('write');
  expect(actionClass('list_automation_events', { project_id: 'p1' })).toBe('read');
  expect(defaultKindOf('pause_automation', { interrupt: true })).toBeNull();
  expect(defaultKindOf('resume_automation', {})).toBeNull();
});

it('keys on the arguments, so a different command is a different question', () => {
  const a = idempotencyKeyFor('c1', 'send_input', { tab_id: 't1', text: 'npm test' });
  expect(idempotencyKeyFor('c1', 'send_input', { text: 'npm test', tab_id: 't1' })).toBe(a); // key order cannot matter
  expect(idempotencyKeyFor('c1', 'send_input', { tab_id: 't1', text: 'rm -rf /' })).not.toBe(a);
  expect(idempotencyKeyFor('c2', 'send_input', { tab_id: 't1', text: 'npm test' })).not.toBe(a);
});

it('canonical serialisation handles nested objects: key order does not matter in nested objects', () => {
  const a = idempotencyKeyFor('c1', 'update_task', { tab: { id: 't1', name: 'x' } });
  expect(idempotencyKeyFor('c1', 'update_task', { tab: { name: 'x', id: 't1' } })).toBe(a);
});

it('canonical serialisation preserves array order: array element order must matter', () => {
  const a = idempotencyKeyFor('c1', 'add_subtasks', { items: ['a', 'b'] });
  expect(idempotencyKeyFor('c1', 'add_subtasks', { items: ['b', 'a'] })).not.toBe(a);
});

it('decides from the row: nothing asks, pending waits, approved allows, denied refuses', () => {
  expect(gateDecision(undefined, 'read')).toBe('allow');
  expect(gateDecision(undefined, 'write')).toBe('ask');
  expect(gateDecision(undefined, 'irreversible')).toBe('ask');
  expect(gateDecision({ status: 'pending' } as never, 'write')).toBe('waiting');
  expect(gateDecision({ status: 'approved' } as never, 'write')).toBe('allow');
  expect(gateDecision({ status: 'denied' } as never, 'write')).toBe('refuse');
  expect(gateDecision({ status: 'expired' } as never, 'write')).toBe('refuse');
});

it('classifies the ticket tools', () => {
  expect(actionClass('list_tickets', {})).toBe('read');
  expect(actionClass('get_ticket', {})).toBe('read');
  expect(actionClass('sync_tickets', {})).toBe('write');
  expect(actionClass('import_tickets', {})).toBe('write');
  expect(actionClass('push_ticket_status', {})).toBe('irreversible');
});

it('classifies search_memory as read', () => {
  expect(actionClass('search_memory', {})).toBe('read');
});

it('classifies record_decision, answer_tab_question and record_lesson as self_mediated, and keeps close_tab/delete_task/an unknown tool irreversible', () => {
  expect(actionClass('record_decision', {})).toBe('self_mediated');
  expect(actionClass('answer_tab_question', {})).toBe('self_mediated');
  expect(actionClass('record_lesson', {})).toBe('self_mediated');
  expect(actionClass('close_tab', { tab_id: 't1' })).toBe('irreversible');
  expect(actionClass('delete_task', { task_id: 'k1' })).toBe('irreversible');
  expect(actionClass('some_future_tool', {})).toBe('irreversible');
});

describe('grantable', () => {
  it('is only send_input to a named tab that is not answering a permission', () => {
    expect(grantable('send_input', { tab_id: 't1', text: 'oi' })).toBe(true);
    expect(grantable('send_input', { tab_id: 't1', text: 'oi', answering_permission: false })).toBe(true);
    expect(grantable('send_input', { tab_id: 't1', text: '1', answering_permission: true })).toBe(false);
    expect(grantable('send_input', { text: 'oi' })).toBe(false);
    expect(grantable('send_input', { tab_id: '', text: 'oi' })).toBe(false);
    expect(grantable('send_input', { tab_id: 'x'.repeat(65), text: 'oi' })).toBe(false);
    expect(grantable('run_command', { tab_id: 't1', command: 'ls' })).toBe(false);
    expect(grantable('send_key', { tab_id: 't1', key: 'Enter' })).toBe(false);
  });

  it('close_tab stays irreversible and non-grantable: control/terminals.ts skips its ownership check on a gated token because every gated close_tab is asked here (TER-184)', () => {
    expect(actionClass('close_tab', { tab_id: 't1' })).toBe('irreversible');
    expect(grantable('close_tab', { tab_id: 't1' })).toBe(false);
    expect(grantable('close_tab', { tab_id: 't1', force: true })).toBe(false);
  });
});

describe('boardGrantable', () => {
  it.each(['create_task', 'add_subtasks', 'update_task', 'move_task'])('covers %s', (t) => expect(boardGrantable(t)).toBe(true));
  it.each(['delete_task', 'start_agent', 'send_input', 'run_command', 'list_tasks', 'close_tab', 'link_tab_task'])('never covers %s', (t) => expect(boardGrantable(t)).toBe(false));
  it('covered tools are all write-class', () => {
    for (const t of BOARD_GRANT_TOOLS) expect(actionClass(t, {})).toBe('write');
  });
});

it('classifies the integration and repository setup tools: reads are reads, writes always ask and are never grantable (spec D6)', () => {
  expect(actionClass('list_integrations', {})).toBe('read');
  expect(actionClass('get_project_setup', { project_id: 'p1' })).toBe('read');
  expect(actionClass('create_integration', { provider: 'github', name: 'x', secret_from: { machine_id: 'm1', source: 'gh_auth_token' } })).toBe('irreversible');
  expect(actionClass('set_project_repo', { project_id: 'p1', integration_id: 'g1', full_name: 'acme/api' })).toBe('irreversible');
  for (const tool of ['create_integration', 'set_project_repo']) {
    expect(grantable(tool, { tab_id: 't1' })).toBe(false);
    expect(boardGrantable(tool)).toBe(false);
  }
});

describe('terminalGrantable', () => {
  it.each([
    ['send_key', { tab_id: 't1', key: 'Enter' }, true],
    ['send_key', { tab_id: 't1', key: 'C-c' }, true],
    ['send_input', { tab_id: 't1', text: 'ls' }, true],
    ['send_input', { tab_id: 't1', text: 'y', answering_permission: true }, false],
    ['send_key', { key: 'Enter' }, false],
    ['send_key', { tab_id: '', key: 'Enter' }, false],
    ['run_command', { tab_id: 't1', command: 'ls' }, false],
    ['open_tab', { project_id: 'p1' }, false],
    ['close_tab', { tab_id: 't1' }, false],
  ])('%s %j → %s', (tool, args, ok) => expect(terminalGrantable(tool, args)).toBe(ok));
});

describe('standingKindOf', () => {
  it.each([
    ['open_tab', { project_id: 'p1' }, 'open_tab'],
    ['open_tab', {}, null],
    ['close_tab', { tab_id: 't1' }, 'close_tab'],
    ['close_tab', {}, null],
    ['start_agent', { project_id: 'p1', account_id: 'a1', prompt: 'oi' }, 'start_agent'],
    ['start_agent', {}, null],
    ['create_task', { project_id: 'p1' }, 'board'],
    ['add_subtasks', { task_id: 'k1' }, 'board'],
    ['update_task', { task_id: 'k1' }, 'board'],
    ['move_task', { task_id: 'k1' }, 'board'],
    ['send_input', { tab_id: 't1', text: 'ls' }, 'terminal'],
    ['send_input', { tab_id: 't1', text: 'y', answering_permission: true }, null],
    ['send_key', { tab_id: 't1', key: 'Enter' }, 'terminal'],
    ['run_command', { tab_id: 't1', command: 'ls' }, null],
    ['delete_task', { task_id: 'k1' }, null],
    ['link_tab_task', { tab_id: 't1', task_id: 'k1' }, null],
    ['push_ticket_status', {}, null],
    ['create_integration', {}, null],
    ['set_project_repo', {}, null],
    ['link_project_machine', { project_id: 'p1', machine_id: 'm1' }, null],
  ])('%s %j → %s', (tool, args, expected) => expect(standingKindOf(tool, args)).toBe(expected));
});

it('standing grant budgets and window match spec (TER-386)', () => {
  expect(STANDING_GRANT_BUDGETS).toEqual({ open_tab: 30, close_tab: 30, start_agent: 10, board: 30, terminal: 120 });
  expect(STANDING_BUDGET_WINDOW_MS).toBe(60 * 60 * 1000);
});

it('classifies list_tab_questions as read (TER-627): it only lists the tabs\' question cards', () => {
  expect(actionClass('list_tab_questions', {})).toBe('read');
});

describe('defaultKindOf (TER-627)', () => {
  it.each([
    ['open_tab', { project_id: 'p1' }, 'open_tab'],
    ['start_agent', { project_id: 'p1', prompt: 'oi' }, 'start_agent'],
    ['link_tab_task', { tab_id: 't1', task_id: 'k1' }, 'link_tab_task'],
    ['link_tab_task', { tab_id: 't1' }, null],
    ['create_task', { project_id: 'p1' }, 'board'],
    ['move_task', { task_id: 'k1' }, 'board'],
    ['send_input', { tab_id: 't1', text: 'ls' }, 'terminal'],
    ['send_key', { tab_id: 't1', key: 'Enter' }, 'terminal'],
    ['close_tab', { tab_id: 't1' }, 'close_tab'],
    // never a default: interrupting keys, answering a permission, and the tools that always ask
    ['send_key', { tab_id: 't1', key: 'C-c' }, null],
    ['send_key', { tab_id: 't1', key: 'Escape' }, null],
    ['send_input', { tab_id: 't1', text: 'y', answering_permission: true }, null],
    ['run_command', { tab_id: 't1', command: 'ls' }, null],
    ['delete_task', { task_id: 'k1' }, null],
    ['push_ticket_status', {}, null],
    ['create_integration', {}, null],
    ['set_project_repo', {}, null],
    ['link_project_machine', { project_id: 'p1', machine_id: 'm1' }, null],
    ['set_project_machine_cwd', { project_id: 'p1', machine_id: 'm1' }, null],
    ['unlink_project_machine', { project_id: 'p1', machine_id: 'm1' }, null],
    ['sync_tickets', {}, null],
    ['import_tickets', {}, null],
    ['resume_automation', {}, null],
  ])('%s %j → %s', (tool, args, expected) => expect(defaultKindOf(tool, args)).toBe(expected));

  it('every MCP tool is a read, self-mediated, a default kind, or on the list that always asks: a new tool is placed on purpose', () => {
    // report_card is a tab tool (agentic board F-8): only a tab with an active run lists it, never the concierge;
    // unclassified, it would ask like any unknown tool
    const alwaysAsks = new Set(['run_command', 'delete_task', 'push_ticket_status', 'create_integration', 'set_project_repo', 'link_project_machine', 'set_project_machine_cwd', 'unlink_project_machine', 'sync_tickets', 'import_tickets', 'resume_automation', 'report_card']);
    const sample: Record<string, Record<string, unknown>> = {
      open_tab: { project_id: 'p1' }, start_agent: { project_id: 'p1' }, link_tab_task: { tab_id: 't1', task_id: 'k1' }, close_tab: { tab_id: 't1' },
      send_input: { tab_id: 't1', text: 'x' }, send_key: { tab_id: 't1', key: 'Enter' },
    };
    for (const { name } of TOOLS) {
      const cls = actionClass(name, sample[name] ?? {});
      const placed = cls === 'read' || cls === 'self_mediated' || defaultKindOf(name, sample[name] ?? {}) !== null || alwaysAsks.has(name);
      expect(placed, name).toBe(true);
    }
  });

  it('budgets: the standing ones, plus link_tab_task', () => {
    expect(Object.keys(DEFAULT_ALLOW_BUDGETS).sort()).toEqual([...DEFAULT_ALLOW_KINDS].sort());
    expect(DEFAULT_ALLOW_BUDGETS).toMatchObject({ ...STANDING_GRANT_BUDGETS, link_tab_task: 30 });
  });

  it('the synthetic grant id names the user and the kind, and never looks like a real grant id', () => {
    expect(defaultGrantId('u1', 'board')).toBe('default:board:u1');
    expect(defaultGrantId('x'.repeat(24), 'link_tab_task').length).toBeLessThanOrEqual(64);
    expect(isDefaultGrantId('default:board:u1')).toBe(true);
    expect(isDefaultGrantId('sg1')).toBe(false);
    expect(isDefaultGrantId(null)).toBe(false);
  });
});
