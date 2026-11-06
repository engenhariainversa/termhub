import { describe, expect, it } from 'vitest';
import { actionClass } from './gate.js';
import { blockFor, openKindOf, type BlockShape } from './open-permissions.js';

const b = (o: Partial<BlockShape>): BlockShape => ({ kind: 'run_command', project_id: null, words: [], effect: 'ask', ...o });

describe('openKindOf (TER-1164)', () => {
  it('maps the routine tools to a kind and leaves the core out', () => {
    expect(openKindOf('send_key', { key: 'Enter' })).toBe('terminal');
    expect(openKindOf('send_key', { key: 'C-c' })).toBeNull();
    expect(openKindOf('move_task', {})).toBe('board');
    expect(openKindOf('unlink_project_machine', {})).toBe('machines');
    expect(openKindOf('unlink_project_machine', { confirm: true })).toBeNull();
    expect(openKindOf('set_machine_automation', { accept: true })).toBe('automation');
    for (const tool of ['delete_task', 'push_ticket_status', 'create_integration', 'set_project_repo', 'automation_merge', 'start_ai_login', 'submit_ai_login_code', 'set_ai_account_exclusive', 'set_project_ai_setup', 'set_automation_policy', 'admin_user_troubleshoot', 'propose_command_rule', 'unblock_action', 'brand_new_tool']) {
      expect(openKindOf(tool, { confirm: true })).toBeNull();
    }
  });

  it('block_action is a brake (self-mediated), unblock_action a write and list_blocks a read', () => {
    expect(actionClass('block_action', {})).toBe('self_mediated');
    expect(actionClass('unblock_action', {})).toBe('write');
    expect(actionClass('list_blocks', {})).toBe('read');
  });
});

describe('blockFor', () => {
  it('a block for every project applies everywhere; a project block only there', () => {
    expect(blockFor([b({ kind: 'board' })], 'board', 'p1', null)).toBeDefined();
    expect(blockFor([b({ kind: 'board', project_id: 'p2' })], 'board', 'p1', null)).toBeUndefined();
    expect(blockFor([b({ kind: 'board', project_id: 'p2' })], 'board', null, null)).toBeUndefined();
  });

  it('command words match as a whole-word prefix', () => {
    const push = [b({ words: ['git', 'push'] })];
    expect(blockFor(push, 'run_command', 'p1', ['git', 'push', 'origin'])).toBeDefined();
    expect(blockFor(push, 'run_command', 'p1', ['git', 'pushx'])).toBeUndefined();
    expect(blockFor(push, 'run_command', 'p1', ['git'])).toBeUndefined();
    expect(blockFor(push, 'run_command', 'p1', null)).toBeUndefined();
  });

  it('"nunca" wins over "pedir antes"', () => {
    expect(blockFor([b({ effect: 'ask' }), b({ effect: 'never', project_id: 'p1' })], 'run_command', 'p1', ['ls'])?.effect).toBe('never');
  });
});
