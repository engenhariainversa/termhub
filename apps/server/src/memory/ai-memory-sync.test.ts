import type { AiMemorySyncInput } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiMemoryPageRow } from '../db/repositories/ai-memory-pages.js';
import type { Machine } from '../db/repositories/types.js';
import { setupSchema } from '../setup/schema.js';
import { rulePages } from './ai-memory-rules.js';
import { clearAiMemorySkips, runAiMemoryRules, syncAiMemoryRules, type AiMemoryExec } from './ai-memory-sync.js';
import { ruleOf } from './current-rules.js';

const machine = (id: string, type: Machine['type'] = 'ssh'): Machine => ({ id, name: id, type } as Machine);

interface Note {
  id: string;
  title: string;
  text: string;
  project_id: string | null;
}

function world() {
  const state = {
    publish: true,
    owner: 'u1' as string | null,
    notes: [] as Note[],
    links: [{ machine_id: 'm1', cwd: '/repo' }] as { machine_id: string; cwd: string }[],
    machines: new Map<string, Machine>([['m1', machine('m1')], ['m2', machine('m2', 'agent')]]),
    pages: [] as AiMemoryPageRow[],
    notesFail: false,
  };
  const repos = {
    projects: {
      findById: async (id: string) => (id === 'p1' ? { id, owner_id: state.owner } : undefined),
      list: async () => [{ id: 'p1', owner_id: state.owner }],
    },
    projectSetup: {
      get: async () => ({ data: { ...setupSchema.parse({}), ai_memory: { publish_rules: state.publish } } }),
      listWithAiMemoryRules: async () => (state.publish ? ['p1'] : []),
    },
    projectMachines: {
      listByProject: async () => state.links.map((l, i) => ({ id: `l${i}`, project_id: 'p1', position: i, created_at: '', ...l })),
    },
    machines: { findById: async (id: string) => state.machines.get(id) },
    memoryItems: {
      currentNotes: async () => {
        if (state.notesFail) throw Object.assign(new Error('db down'), { code: 'P1001' });
        return state.notes;
      },
    },
    aiMemoryPages: {
      listByProject: async () => state.pages.map((p) => ({ ...p })),
      projectIds: async () => [...new Set(state.pages.map((p) => p.project_id))],
      upsert: async (row: AiMemoryPageRow) => {
        state.pages = state.pages.filter((p) => !(p.machine_id === row.machine_id && p.cwd === row.cwd && p.path === row.path));
        state.pages.push(row);
      },
      remove: async (_projectId: string, machineId: string, cwd: string, paths: string[]) => {
        state.pages = state.pages.filter((p) => !(p.machine_id === machineId && p.cwd === cwd && paths.includes(p.path)));
      },
    },
  };
  return { state, repos: repos as unknown as Parameters<typeof syncAiMemoryRules>[0] };
}

/** A fake exec that does what the script would, or answers `skip`. */
function fakeExec(opts: { skip?: string; reach?: Record<string, 'AGENT_OFFLINE' | 'AGENT_OUTDATED'>; failPaths?: string[]; throws?: boolean } = {}) {
  const calls: { machine: string; input: AiMemorySyncInput }[] = [];
  const exec: AiMemoryExec = {
    reach: (m) => opts.reach?.[m.id] ?? 'ok',
    sync: async (m, input) => {
      calls.push({ machine: m.id, input });
      if (opts.throws) throw Object.assign(new Error('x'), { code: 'MACHINE_UNREACHABLE' });
      if (opts.skip) return `skip ${opts.skip}\n`;
      const lines: string[] = [];
      if (input.writes.length > 0) lines.push('ok briefing');
      for (const w of input.writes) lines.push(`${opts.failPaths?.includes(w.path) ? 'fail' : 'ok'} write ${w.path}`);
      for (const d of input.deletes) lines.push(`ok delete ${d}`);
      return lines.join('\n') + '\n';
    },
  };
  return { exec, calls };
}

const note = (id: string, title: string, decision: string, project_id: string | null = 'p1'): Note => ({
  id,
  title,
  text: `Decisão: ${decision}\nMotivo: m\nFontes: -`,
  project_id,
});
const log = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  clearAiMemorySkips();
  log.info.mockReset();
  log.warn.mockReset();
});

describe('syncAiMemoryRules', () => {
  it('writes the current rules, then writes only what changed and deletes removed rules', async () => {
    const { state, repos } = world();
    state.notes = [note('a1', 'Usar pnpm', 'Sempre pnpm'), note('b1', 'Deploy', 'Nunca na sexta')];
    const f = fakeExec();
    expect(await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec })).toEqual({ written: 2, deleted: 0, ran: 1 });
    expect(f.calls[0]!.input).toMatchObject({ cwd: '/repo', server_url: 'http://127.0.0.1:49374', deletes: [] });
    expect(state.pages.map((p) => p.path).sort()).toEqual(['_rules/termhub-deploy-b1.md', '_rules/termhub-usar-pnpm-a1.md']);

    // nothing changed: the script does not run
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    expect(f.calls).toHaveLength(1);

    // a1 changed, b1 is no longer current
    state.notes = [note('a1', 'Usar pnpm', 'Sempre pnpm, nunca yarn')];
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    expect(f.calls[1]!.input.writes.map((w) => w.path)).toEqual(['_rules/termhub-usar-pnpm-a1.md']);
    expect(f.calls[1]!.input.deletes).toEqual(['_rules/termhub-deploy-b1.md']);
    expect(state.pages.map((p) => p.path)).toEqual(['_rules/termhub-usar-pnpm-a1.md']);
    expect(state.pages[0]!.hash).toBe(rulePages([ruleOf(note('a1', 'Usar pnpm', 'Sempre pnpm, nunca yarn'))])[0]!.hash);
  });

  it('deletes every page when the option is turned off', async () => {
    const { state, repos } = world();
    state.notes = [note('a1', 'A', 'x')];
    const f = fakeExec();
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    state.publish = false;
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    expect(f.calls[1]!.input).toMatchObject({ writes: [], deletes: ['_rules/termhub-a-a1.md'] });
    expect(state.pages).toEqual([]);
  });

  it('does nothing at all when the option is off and nothing was published', async () => {
    const { state, repos } = world();
    state.publish = false;
    state.notes = [note('a1', 'A', 'x')];
    const f = fakeExec();
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    expect(f.calls).toEqual([]);
  });

  it('keeps a failed write unrecorded so the next run retries it', async () => {
    const { state, repos } = world();
    state.notes = [note('a1', 'A', 'x'), note('b1', 'B', 'y')];
    const f = fakeExec({ failPaths: ['_rules/termhub-b-b1.md'] });
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    expect(state.pages.map((p) => p.path)).toEqual(['_rules/termhub-a-a1.md']);
  });

  it('skips an offline or outdated agent machine and an unreachable one, writing nothing', async () => {
    const { state, repos } = world();
    state.links = [{ machine_id: 'm2', cwd: '/repo' }];
    state.notes = [note('a1', 'A', 'x')];
    const off = fakeExec({ reach: { m2: 'AGENT_OFFLINE' } });
    await syncAiMemoryRules(repos, 'p1', { log, exec: off.exec });
    expect(off.calls).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm2', code: 'AGENT_OFFLINE' }), expect.any(String));
    const down = fakeExec({ throws: true });
    await syncAiMemoryRules(repos, 'p1', { log, exec: down.exec });
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ code: 'MACHINE_UNREACHABLE' }), expect.any(String));
    expect(state.pages).toEqual([]);
  });

  it('still cleans a machine that was unlinked, in the checkout it wrote to', async () => {
    const { state, repos } = world();
    state.notes = [note('a1', 'A', 'x')];
    const f = fakeExec();
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    state.links = [{ machine_id: 'm1', cwd: '/elsewhere' }];
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    const byCwd = Object.fromEntries(f.calls.slice(1).map((c) => [c.input.cwd, c.input]));
    expect(byCwd['/repo']).toMatchObject({ writes: [], deletes: ['_rules/termhub-a-a1.md'] });
    expect(byCwd['/elsewhere']!.writes.map((w) => w.path)).toEqual(['_rules/termhub-a-a1.md']);
    expect(state.pages.map((p) => p.cwd)).toEqual(['/elsewhere']);

    state.links = [];
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    expect(f.calls.at(-1)!.input).toMatchObject({ cwd: '/elsewhere', writes: [], deletes: ['_rules/termhub-a-a1.md'] });
    expect(state.pages).toEqual([]);
  });

  it('drops delete rows when the checkout has no ai-memory any more', async () => {
    const { state, repos } = world();
    state.pages = [{ project_id: 'p1', machine_id: 'm1', cwd: '/repo', path: '_rules/termhub-a-a1.md', hash: 'h' }];
    state.publish = false;
    const f = fakeExec({ skip: 'no_marker' });
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    expect(state.pages).toEqual([]);
  });

  it('keeps rows and backs off when a checkout without ai-memory has writes pending', async () => {
    const { state, repos } = world();
    state.notes = [note('a1', 'A', 'x')];
    const f = fakeExec({ skip: 'no_marker' });
    let t = 1_000;
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec, now: () => t });
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec, now: () => t });
    expect(f.calls).toHaveLength(1);
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec, now: () => t, fresh: true });
    expect(f.calls).toHaveLength(2);
    t += 2 * 60 * 60 * 1000;
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec, now: () => t });
    expect(f.calls).toHaveLength(3);
    expect(state.pages).toEqual([]);
  });

  it('never deletes pages when the rules cannot be read', async () => {
    const { state, repos } = world();
    state.pages = [{ project_id: 'p1', machine_id: 'm1', cwd: '/repo', path: '_rules/termhub-a-a1.md', hash: 'h' }];
    state.notesFail = true;
    const f = fakeExec();
    await expect(syncAiMemoryRules(repos, 'p1', { log, exec: f.exec })).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(state.pages).toHaveLength(1);
  });

  it('publishes nothing for a project without an owner', async () => {
    const { state, repos } = world();
    state.owner = null;
    state.notes = [note('a1', 'A', 'x')];
    const f = fakeExec();
    await syncAiMemoryRules(repos, 'p1', { log, exec: f.exec });
    expect(f.calls).toEqual([]);
  });

  it('never logs rule text', async () => {
    const { state, repos } = world();
    state.notes = [note('a1', 'Segredo do título', 'decisão secreta')];
    await syncAiMemoryRules(repos, 'p1', { log, exec: fakeExec().exec });
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toMatch(/Segredo|secreta|termhub-/);
  });
});

describe('runAiMemoryRules', () => {
  it('serialises runs per project and reruns once for calls made meanwhile', async () => {
    const { state, repos } = world();
    state.notes = [note('a1', 'A', 'x')];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let active = 0;
    let maxActive = 0;
    const base = fakeExec();
    const exec: AiMemoryExec = {
      reach: base.exec.reach,
      sync: async (m, input) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate;
        active--;
        return base.exec.sync(m, input);
      },
    };
    const first = runAiMemoryRules(repos, 'p1', { log, exec });
    const second = runAiMemoryRules(repos, 'p1', { log, exec });
    const third = runAiMemoryRules(repos, 'p1', { log, exec });
    expect(second).toBe(first);
    expect(third).toBe(first);
    await new Promise((r) => setTimeout(r, 10));
    state.notes = [note('a1', 'A', 'changed')];
    release();
    await first;
    expect(maxActive).toBe(1);
    // the first run and exactly one rerun, which picked up the change
    expect(base.calls).toHaveLength(2);
    expect(base.calls[1]!.input.writes[0]!.body).toContain('changed');
  });

  it('never rejects', async () => {
    const { state, repos } = world();
    state.notesFail = true;
    await expect(runAiMemoryRules(repos, 'p1', { log, exec: fakeExec().exec })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith({ projectId: 'p1', code: 'P1001' }, expect.any(String));
  });
});
