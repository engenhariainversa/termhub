import { describe, expect, it, vi } from 'vitest';

vi.mock('../automation/pause.js', () => ({ isPaused: vi.fn(async () => false) }));
vi.mock('../automation/queue.js', () => ({ automationQueue: vi.fn(async () => []) }));
vi.mock('../automation/merge-wait.js', () => ({ baseReadingOf: vi.fn(() => null), mergeWaitOf: vi.fn(() => null) }));
vi.mock('../control/context.js', () => ({ controlContextFor: vi.fn(() => ({})) }));

import type { Repositories } from '../db/repositories/index.js';
import type { Project, User } from '../db/repositories/types.js';
import { setupSchema } from '../setup/schema.js';
import { buildSnapshot } from './snapshot.js';

const card = (id: string, column_id: string) => ({ id, ref: `TER-${id}`, title: id, status: 'doing', parent_id: null, type: 'task', column_id, tab_id: null, auto: true, updated_at: '2026-10-27T10:00:00.000Z' });

describe('buildSnapshot (TER-1134)', () => {
  it('leaves the cards of a waiting column out of Doing: they are never orphans', async () => {
    const repos = {
      tasks: { listByProject: vi.fn(async () => [card('1', 'doing'), card('2', 'wait')]) },
      taskColumns: { list: vi.fn(async () => [{ id: 'doing', category: 'doing', waiting: false }, { id: 'wait', category: 'doing', waiting: true }]) },
      tabs: { listByProject: vi.fn(async () => []) },
      automationRuns: { activeByProject: vi.fn(async () => []), lastStartedAt: vi.fn(async () => null), latestOfTask: vi.fn(async () => null) },
      projectMachines: { listByProject: vi.fn(async () => []) },
      taskPullRequests: { listForHealth: vi.fn(async () => []) },
    } as unknown as Repositories;
    const setup = setupSchema.parse({ automation: { enabled: true } });
    const s = await buildSnapshot(repos, { id: 'p1', owner_id: 'u1' } as Project, { id: 'u1', locale: 'pt-BR' } as User, setup, new Date('2026-10-27T12:00:00Z'));
    expect(s.doing.map((c) => c.ref)).toEqual(['TER-1']);
  });
});
