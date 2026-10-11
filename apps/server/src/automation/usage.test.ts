import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Tab } from '../db/repositories/types.js';
import type { UsageCursor, UsageWrite } from '../db/repositories/tab-usage.js';
import { dayIn, meterTab, RUN_END_GRACE_MS, sumTranscriptUsage, type UsageDeps } from './usage.js';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SECRET = 'TOP SECRET TRANSCRIPT TEXT';

function assistant(id: string, model: string, usage: Record<string, number>, text = SECRET): string {
  return JSON.stringify({ type: 'assistant', uuid: `u-${id}-${Math.random()}`, message: { id, model, role: 'assistant', content: [{ type: 'text', text }], usage } });
}

/** A transcript on the "machine": lines appended over time, read forward from a byte offset like the agent. */
class FakeTranscript {
  lines: string[] = [];
  calls: Array<{ offset: number | null; types: string[] }> = [];
  append(...l: string[]) {
    this.lines.push(...l);
  }
  private bytes(upTo: number) {
    return this.lines.slice(0, upTo).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  }
  rpc = vi.fn(async (_m: Machine, p: { offset: number | null; types: string[] }) => {
    this.calls.push({ offset: p.offset, types: p.types });
    const size = this.bytes(this.lines.length);
    let i = 0;
    while (i < this.lines.length && this.bytes(i) < (p.offset ?? 0)) i++;
    const out = this.lines.slice(i).filter((l) => p.types.includes(JSON.parse(l).type));
    return { status: 'ok' as const, lines: out, start: p.offset ?? 0, end: size, size };
  });
}

const machine = { id: 'm1', type: 'agent', owner_id: 'u1' } as unknown as Machine;
const baseTab = {
  id: 't1',
  project_id: 'p1',
  machine_id: 'm1',
  state_tool: 'claude',
  agent_session_id: SESSION,
  agent_transcript_path: `~/.claude/projects/x/${SESSION}.jsonl`,
  ai_account_id: 'acc1',
} as unknown as Tab;

type FakeRun = { id: string; task_id: string; account_id: string; status: string; ended_at: Date | null };

function setup(opts: { run?: boolean | Partial<FakeRun>; capabilities?: string[]; zone?: string | null } = {}) {
  const transcript = new FakeTranscript();
  let cursor: UsageCursor | null = null;
  const noteUnmetered = vi.fn(async () => undefined);
  const record = vi.fn(async (w: UsageWrite) => {
    const same = cursor === null ? w.from === null : w.from !== null && w.from.session_id === cursor.session_id && w.from.offset === cursor.offset;
    if (!same) return false;
    cursor = w.to;
    return true;
  });
  const deps: UsageDeps = {
    repos: {
      tabUsage: { cursor: async () => cursor, record, noteUnmetered, ownerTimeZone: async () => (opts.zone === undefined ? 'America/Sao_Paulo' : opts.zone) },
      automationRuns: {
        latestByTab: async () =>
          opts.run === false ? null : ({ id: 'r1', task_id: 'card1', account_id: 'acc-run', status: 'running', ended_at: null, ...(typeof opts.run === 'object' ? opts.run : {}) } as never),
      },
      machines: { findById: async () => machine },
    },
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    rpc: transcript.rpc as never,
    agents: { isOnline: () => true, capabilities: () => opts.capabilities ?? ['claude', 'transcript'] },
    now: () => new Date('2026-10-05T02:30:00Z'),
  };
  return { deps, transcript, record, noteUnmetered };
}

describe('meterTab', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('reads only the new range on the second Stop and adds only its counts', async () => {
    s.transcript.append(assistant('msg1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }));
    await meterTab(s.deps, baseTab);
    s.transcript.append(JSON.stringify({ type: 'user', message: { content: SECRET } }), assistant('msg2', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }));
    await meterTab(s.deps, baseTab);

    expect(s.transcript.calls.map((c) => c.offset)).toEqual([0, Buffer.byteLength(s.transcript.lines[0]!) + 1]);
    expect(s.transcript.calls.every((c) => c.types.length === 1 && c.types[0] === 'assistant')).toBe(true);
    expect(s.record).toHaveBeenCalledTimes(2);
    const [first, second] = s.record.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({ from: null, tokens: { input: 10, output: 100, cacheRead: 1000, cacheWrite: 50 } });
    expect(second).toMatchObject({ from: first!.to, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
    expect(second!.to.offset).toBe(Buffer.byteLength(s.transcript.lines.join('\n')) + 1);
    expect(first!.cost_usd).toBeCloseTo((10 * 4 + 100 * 20 + 1000 * 0.2 + 50 * 5) / 1e6);
  });

  it('does not write when nothing new was read', async () => {
    s.transcript.append(assistant('msg1', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 }));
    await meterTab(s.deps, baseTab);
    await meterTab(s.deps, baseTab);
    expect(s.record).toHaveBeenCalledTimes(1);
  });

  it('starts over at byte 0 when the tab runs another session', async () => {
    s.transcript.append(assistant('msg1', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 }));
    await meterTab(s.deps, baseTab);
    const other = 'a1b2c3d4-0000-4000-8000-000000000000';
    await meterTab(s.deps, { ...baseTab, agent_session_id: other });
    expect(s.transcript.calls[1]!.offset).toBe(0);
    expect(s.record.mock.calls[1]![0]).toMatchObject({ from: { session_id: SESSION }, to: { session_id: other } });
  });

  it('stores a null cost for an unknown model, with the counts', async () => {
    s.transcript.append(assistant('msg1', 'claude-fable-5-1', { input_tokens: 5, output_tokens: 7 }));
    await meterTab(s.deps, baseTab);
    expect(s.record.mock.calls[0]![0]).toMatchObject({ model: 'claude-fable-5-1', cost_usd: null, tokens: { input: 5, output: 7 } });
  });

  it('passes nothing but ids, counts, the day and the offset to the repository', async () => {
    s.transcript.append(assistant('msg1', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 7 }));
    await meterTab(s.deps, baseTab);
    const [w] = s.record.mock.calls[0]!;
    expect(Object.keys(w).sort()).toEqual(['account_id', 'cost_usd', 'day', 'from', 'model', 'project_id', 'tab_id', 'task_id', 'to', 'tokens']);
    expect(w).toMatchObject({ tab_id: 't1', project_id: 'p1', task_id: 'card1', account_id: 'acc1', day: '2026-10-04', model: 'claude-sonnet-5-5' });
    expect(Object.keys(w.tokens).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
    expect(Object.keys(w.to).sort()).toEqual(['offset', 'session_id']);
    expect(JSON.stringify(s.record.mock.calls)).not.toContain(SECRET);
    const logged = JSON.stringify([(s.deps.log.info as ReturnType<typeof vi.fn>).mock.calls, (s.deps.log.debug as ReturnType<typeof vi.fn>).mock.calls]);
    expect(logged).not.toContain(SECRET);
  });

  it('skips a tab with no automation run, a Codex tab and an agent without the transcript capability', async () => {
    s.transcript.append(assistant('msg1', 'claude-opus-5-5', { input_tokens: 1 }));
    const manual = setup({ run: false });
    manual.transcript.append(...s.transcript.lines);
    await meterTab(manual.deps, baseTab);
    await meterTab(s.deps, { ...baseTab, state_tool: 'codex' } as Tab);
    const old = setup({ capabilities: ['claude'] });
    old.transcript.append(...s.transcript.lines);
    await meterTab(old.deps, baseTab);
    expect(manual.transcript.rpc).not.toHaveBeenCalled();
    expect(s.transcript.rpc).not.toHaveBeenCalled();
    expect(old.transcript.rpc).not.toHaveBeenCalled();
  });

  it('notes a Codex tab of a run without reading anything, so its card shows "—"', async () => {
    await meterTab(s.deps, { ...baseTab, state_tool: 'codex', agent_session_id: null, agent_transcript_path: null } as Tab);
    expect(s.transcript.rpc).not.toHaveBeenCalled();
    expect(s.record).not.toHaveBeenCalled();
    expect(s.noteUnmetered).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', task_id: 'card1', account_id: 'acc1', day: '2026-10-04' });
    const manual = setup({ run: false });
    await meterTab(manual.deps, { ...baseTab, state_tool: 'codex' } as Tab);
    expect(manual.noteUnmetered).not.toHaveBeenCalled();
  });

  it('meters while the run owns the tab: active, or ended within the grace; not after a person took it over', async () => {
    const line = assistant('msg1', 'claude-opus-5-5', { input_tokens: 1 });
    const now = new Date('2026-10-05T02:30:00Z').getTime();
    const ended = (ago: number) => setup({ run: { status: 'done', ended_at: new Date(now - ago) } });
    const recent = ended(RUN_END_GRACE_MS - 1000);
    const old = ended(RUN_END_GRACE_MS + 1000);
    const waiting = setup({ run: { status: 'waiting' } });
    for (const x of [recent, old, waiting]) {
      x.transcript.append(line);
      await meterTab(x.deps, baseTab);
    }
    expect(recent.record).toHaveBeenCalledTimes(1);
    expect(waiting.record).toHaveBeenCalledTimes(1);
    expect(old.transcript.rpc).not.toHaveBeenCalled();
    expect(old.record).not.toHaveBeenCalled();
  });

  it('counts two Stops at once only once', async () => {
    s.transcript.append(assistant('msg1', 'claude-opus-5-5', { input_tokens: 10 }));
    await Promise.all([meterTab(s.deps, baseTab), meterTab(s.deps, baseTab)]);
    expect(s.record).toHaveBeenCalledTimes(1);
    expect(s.record.mock.calls[0]![0].tokens.input).toBe(10);
  });

  it('writes nothing when another pass moved the cursor first (the other colour)', async () => {
    s.transcript.append(assistant('msg1', 'claude-opus-5-5', { input_tokens: 10 }));
    s.record.mockResolvedValueOnce(false);
    await meterTab(s.deps, baseTab);
    expect(s.deps.log.warn).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    s.transcript.rpc.mockRejectedValueOnce(new Error('offline'));
    await expect(meterTab(s.deps, baseTab)).resolves.toBeUndefined();
    expect(s.deps.log.warn).toHaveBeenCalled();
  });
});

describe('sumTranscriptUsage', () => {
  it('counts a message split over several lines once, keeping the largest counts', () => {
    const lines = [
      assistant('m1', 'claude-opus-5-5', { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 9 }),
      assistant('m1', 'claude-opus-5-5', { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 9 }),
      assistant('m2', 'claude-haiku-4-5', { input_tokens: 2, output_tokens: 2 }),
      assistant('m3', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
      'not json',
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }),
    ];
    const s = sumTranscriptUsage(lines);
    expect(s.byModel.get('claude-opus-5-5')).toEqual({ input: 3, output: 40, cacheRead: 9, cacheWrite: 0 });
    expect(s.byModel.get('claude-haiku-4-5')).toEqual({ input: 2, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(s.byModel.has('<synthetic>')).toBe(false);
    expect(s.lastModel).toBe('claude-haiku-4-5');
  });
});

describe('dayIn', () => {
  it('is the day in the zone, UTC when unknown or invalid', () => {
    const at = new Date('2026-10-05T02:30:00Z');
    expect(dayIn('America/Sao_Paulo', at)).toBe('2026-10-04');
    expect(dayIn(null, at)).toBe('2026-10-05');
    expect(dayIn('Not/AZone', at)).toBe('2026-10-05');
  });
});
