import { describe, expect, it } from 'vitest';
import type { Machine, MonitorItem, Project, Tab } from '../lib/types';
import { groupMachineItems } from './NeedsYouList';

const T1 = '2026-01-01T00:00:00.000Z';

function machine(id: string, name = id): Machine {
  return {
    id,
    name,
    host: null,
    ssh_user: null,
    ssh_port: 22,
    type: 'agent',
    os: null,
    capabilities: [],
    checked_at: null,
    agent_version: null,
    agent_last_seen_at: null,
    agent_auto_update: false,
    claude_auto_swap: false,
    is_local: false,
    owner_id: 'u1',
    owner_name: null,
    created_at: T1,
  };
}

function project(id: string, machineId: string): Project {
  return { id, owner_id: 'u1', key: id.toUpperCase(), next_task_number: 1, name: id, status: 'active', description: null, last_terminal_at: null, created_at: T1, machines: [{ machine_id: machineId, cwd: '/tmp', position: 0 }] };
}

function tab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    project_id: 'p1',
    machine_id: 'm1',
    name: overrides.id,
    kind: 'terminal',
    tmux_session: `th-${overrides.id}`,
    simulator_udid: null,
    position: 0,
    state: null,
    state_text: null,
    state_tool: 'claude',
    state_at: null,
    state_seen_at: null,
    activity: null,
    activity_verb: null,
    created_at: T1,
    alive: true,
    ai_account_id: null,
    rate_limited_at: null,
    ...overrides,
  };
}

function item(t: Partial<Tab> & { id: string }, m: Machine): MonitorItem {
  const tb = tab(t);
  return { tab: tb, project: project(tb.project_id, m.id), machine: m };
}

describe('groupMachineItems', () => {
  const m1 = machine('m1');

  it('puts a seen-but-still-waiting tab in "seen", not "waiting" or "finished"', () => {
    const [g] = groupMachineItems([
      item({ id: 'a', state: 'waiting_input', state_at: T1 }, m1), // needs you
      item({ id: 'b', state: 'waiting_input', state_at: T1, state_seen_at: T1 }, m1), // seen
      item({ id: 'c', state: 'idle' }, m1),
    ]);
    expect(g.waiting.map((i) => i.tab.id)).toEqual(['a']);
    expect(g.seen.map((i) => i.tab.id)).toEqual(['b']);
    expect(g.finished.map((i) => i.tab.id)).toEqual(['c']);
  });

  it('also buckets a seen waiting_permission tab as "seen"', () => {
    const [g] = groupMachineItems([item({ id: 'a', state: 'waiting_permission', state_at: T1, state_seen_at: T1 }, m1)]);
    expect(g.seen.map((i) => i.tab.id)).toEqual(['a']);
    expect(g.waiting).toEqual([]);
    expect(g.finished).toEqual([]);
  });

  it('keeps every seen tab in its own bucket, untouched by the render-only 6-item cap on "finished"', () => {
    const finishedItems = Array.from({ length: 8 }, (_, n) => item({ id: `f${n}`, state: 'idle' }, m1));
    const seenItems = Array.from({ length: 3 }, (_, n) => item({ id: `s${n}`, state: 'waiting_permission', state_at: T1, state_seen_at: T1 }, m1));
    const [g] = groupMachineItems([...finishedItems, ...seenItems]);
    // groupMachineItems itself never truncates; MachineSection's `finished.slice(0, 6)` is a display-only concern.
    expect(g.finished).toHaveLength(8);
    expect(g.seen).toHaveLength(3);
  });

  it('counts working tabs and sorts machines by the oldest unseen wait, then by name', () => {
    const m2 = machine('m2', 'zzz');
    const groups = groupMachineItems([
      item({ id: 'w', state: 'working' }, m1),
      item({ id: 'x', state: 'waiting_input', state_at: '2026-01-01T00:05:00.000Z' }, m2),
      item({ id: 'y', state: 'waiting_input', state_at: '2026-01-01T00:01:00.000Z' }, m1),
    ]);
    expect(groups.map((g) => g.machine.id)).toEqual(['m1', 'm2']); // m1's wait (00:01) is older than m2's (00:05)
    expect(groups[0].working).toBe(1);
  });

  it('a tab that never reported (state null) falls into the "working" count, like before', () => {
    const [g] = groupMachineItems([item({ id: 'a', state: null }, m1)]);
    expect(g).toMatchObject({ waiting: [], seen: [], finished: [], working: 1 });
  });
});
