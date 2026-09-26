import { describe, expect, it } from 'vitest';
import { actionClass, gateDecision, grantable, idempotencyKeyFor } from './gate.js';

it('classifies every tool the MCP exposes, and defaults an unknown one to irreversible', () => {
  expect(actionClass('list_machines', {})).toBe('read');
  expect(actionClass('read_screen', { tab_id: 't1' })).toBe('read');
  expect(actionClass('send_input', { tab_id: 't1', text: 'oi' })).toBe('write');
  expect(actionClass('start_agent', {})).toBe('write');
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
