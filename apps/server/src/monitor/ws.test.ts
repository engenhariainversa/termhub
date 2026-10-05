import { describe, expect, it } from 'vitest';
import type { Tab } from '../db/repositories/types.js';
import { automationFrame, lifecycleFrame, stateFrame } from './ws.js';

const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'Ana', kind: 'terminal' } as Tab;

describe('monitor WS frames', () => {
  it('keeps the state frame as it was', () => {
    expect(stateFrame('u1', { tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' })).toEqual({ type: 'tab', tab, project_id: 'p1', machine_id: 'm1' });
    expect(stateFrame('u1', { tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u2' })).toBeNull();
  });

  it('sends an opened/renamed tab as tab_upsert and a closed one as tab_removed', () => {
    expect(lifecycleFrame('u1', { kind: 'upsert', tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' })).toEqual({ type: 'tab_upsert', tab, project_id: 'p1', machine_id: 'm1' });
    expect(lifecycleFrame('u1', { kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' })).toEqual({ type: 'tab_removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1' });
  });

  it('filters lifecycle events by the machine owner, like state changes; "all" (null) sees everything', () => {
    const removed = { kind: 'removed' as const, tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u2' };
    expect(lifecycleFrame('u1', removed)).toBeNull();
    expect(lifecycleFrame('u1', { kind: 'upsert', tab, project_id: 'p1', machine_id: 'm1', owner_id: null })).toBeNull();
    expect(lifecycleFrame(null, removed)).toMatchObject({ type: 'tab_removed' });
  });

  it('sends an automation event to its owner only, without the owner id', () => {
    const e = { id: 'e1', project_id: 'p1', task_id: null, run_id: null, kind: 'paused' as const, payload: { scope: 'all', interrupt: false }, created_at: '2026-10-05T10:00:00.000Z', owner_id: 'u1' };
    const { owner_id: _o, ...event } = e;
    expect(automationFrame('u1', e)).toEqual({ type: 'automation', event });
    expect(automationFrame('u2', e)).toBeNull();
    expect(automationFrame(null, e)).toEqual({ type: 'automation', event });
  });
});
