import { describe, expect, it, vi } from 'vitest';
import type { Machine, Tab } from '../db/repositories/types.js';
import { availabilityOf, decodeCursor, encodeCursor, readForward, readPage, type Rpc } from './reader.js';
import { TRANSCRIPT_TYPES } from './transcript.js';

const SID = '11111111-2222-4333-8444-555555555555';
const OTHER_SID = '99999999-2222-4333-8444-555555555555';
const tab = (o: Partial<Tab> = {}) =>
  ({ id: 't1', kind: 'terminal', tmux_session: 's', state: 'working', state_tool: 'claude', agent_session_id: SID, agent_transcript_path: `/h/.claude/projects/-w/${SID}.jsonl`, ...o }) as Tab;
const agentOf = (online: boolean, caps: string[] | null) => ({ isOnline: () => online, capabilities: () => caps });
const machine = { id: 'm1', type: 'agent' } as Machine;
const userLine = (text: string) => JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00.000Z', message: { content: text } });
const ok = (o: { lines?: string[]; start: number; end: number; size: number }) => ({ status: 'ok' as const, lines: o.lines ?? [], start: o.start, end: o.end, size: o.size });

describe('availabilityOf', () => {
  it.each([
    ['unsupported_machine', tab(), { type: 'ssh' }, agentOf(true, ['transcript'])],
    ['offline', tab(), { type: 'agent' }, agentOf(false, null)],
    ['agent_outdated', tab(), { type: 'agent' }, agentOf(true, ['claude'])],
    ['agent_outdated', tab(), { type: 'agent' }, agentOf(true, null)],
    ['unsupported_tool', tab({ state_tool: 'codex' }), { type: 'agent' }, agentOf(true, ['transcript'])],
    ['no_session', tab({ agent_transcript_path: null }), { type: 'agent' }, agentOf(true, ['transcript'])],
    ['no_session', tab({ agent_session_id: null }), { type: 'agent' }, agentOf(true, ['transcript'])],
    ['no_session', tab({ agent_session_id: 'not-a-uuid' }), { type: 'agent' }, agentOf(true, ['transcript'])],
    ['ready', tab(), { type: 'agent' }, agentOf(true, ['transcript'])],
    ['ready', tab({ state_tool: null }), { type: 'agent' }, agentOf(true, ['transcript'])],
  ])('availability %s', (want, t, m, a) => expect(availabilityOf(t, m as Machine, a)).toBe(want));
});

describe('cursors', () => {
  it('round-trip and refuse garbage', () => {
    expect(decodeCursor(encodeCursor({ session: SID, offset: 42 }))).toEqual({ session: SID, offset: 42 });
    for (const bad of [null, undefined, '', 'x', `${SID}.-1`, `${SID}.1.5`, `nope.3`, `${SID}.`, `${SID}.1e3`]) expect(decodeCursor(bad)).toBeNull();
  });
});

describe('readPage', () => {
  it('the first page reads backward from the end and returns both cursors', async () => {
    const rpc = vi.fn<Rpc>(async () => ok({ lines: [userLine('oi')], start: 100, end: 400, size: 400 }));
    const page = await readPage(machine, tab(), null, rpc);
    expect(rpc).toHaveBeenCalledWith(
      machine,
      expect.objectContaining({
        transcript_path: `/h/.claude/projects/-w/${SID}.jsonl`,
        session_id: SID,
        direction: 'backward',
        offset: null,
        max_bytes: 262_144,
        max_string: 4000,
        types: [...TRANSCRIPT_TYPES],
      }),
    );
    expect(page).toMatchObject({ before: `${SID}.100`, live: `${SID}.400`, missing: false, degraded: false });
    expect(page.items).toEqual([{ kind: 'user', id: 'u1', at: '2026-10-01T10:00:00.000Z', text: 'oi', images: 0 }]);
  });

  it('an earlier page reads backward from its cursor', async () => {
    const rpc = vi.fn<Rpc>(async () => ok({ start: 0, end: 100, size: 400 }));
    await readPage(machine, tab(), `${SID}.100`, rpc);
    expect(rpc).toHaveBeenCalledWith(machine, expect.objectContaining({ direction: 'backward', offset: 100 }));
  });

  it('a page that reached byte 0 has no earlier page', async () => {
    expect((await readPage(machine, tab(), null, async () => ok({ start: 0, end: 10, size: 10 }))).before).toBeNull();
  });

  it('a before cursor of another session is ignored: the page is the end of the current one', async () => {
    const rpc = vi.fn<Rpc>(async () => ok({ start: 0, end: 0, size: 0 }));
    await readPage(machine, tab(), `${OTHER_SID}.50`, rpc);
    expect(rpc).toHaveBeenCalledWith(machine, expect.objectContaining({ offset: null }));
  });

  it('a missing transcript is an empty page', async () => {
    expect(await readPage(machine, tab(), null, async () => ({ status: 'missing', lines: [], start: 0, end: 0, size: 0 }))).toMatchObject({
      items: [],
      missing: true,
      live: null,
      before: null,
    });
  });

  it('a page mostly made of lines it does not understand is degraded', async () => {
    const page = await readPage(machine, tab(), null, async () => ok({ lines: ['x', 'y', userLine('oi')], start: 0, end: 30, size: 30 }));
    expect(page.degraded).toBe(true);
    expect(page.items).toHaveLength(1);
  });

  it('carries the last permission mode read', async () => {
    const page = await readPage(machine, tab(), null, async () => ok({ lines: [JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' })], start: 0, end: 30, size: 30 }));
    expect(page.mode).toBe('plan');
  });
});

describe('readForward', () => {
  it('reads forward from the cursor; more is true while the file has bytes past `end`', async () => {
    const rpc = vi.fn<Rpc>(async () => ok({ start: 10, end: 60, size: 90 }));
    const f = await readForward(machine, tab(), { session: SID, offset: 10 }, rpc);
    expect(rpc).toHaveBeenCalledWith(machine, expect.objectContaining({ direction: 'forward', offset: 10 }));
    expect(f).toMatchObject({ live: `${SID}.60`, more: true, missing: false });
  });

  it('more is false at the end of the file, and when a read made no progress', async () => {
    expect((await readForward(machine, tab(), { session: SID, offset: 10 }, async () => ok({ start: 10, end: 90, size: 90 }))).more).toBe(false);
    expect((await readForward(machine, tab(), { session: SID, offset: 10 }, async () => ok({ start: 10, end: 10, size: 90 }))).more).toBe(false);
  });

  it('forward from past the end of the file restarts at the end', async () => {
    const rpc = vi.fn<Rpc>(async () => ok({ start: 20, end: 20, size: 20 }));
    expect((await readForward(machine, tab(), { session: SID, offset: 999 }, rpc)).live).toBe(`${SID}.20`);
  });

  it('a missing transcript reads as missing, with the cursor kept', async () => {
    const f = await readForward(machine, tab(), { session: SID, offset: 10 }, async () => ({ status: 'missing', lines: [], start: 0, end: 0, size: 0 }));
    expect(f).toMatchObject({ missing: true, items: [], live: `${SID}.10`, more: false });
  });
});
