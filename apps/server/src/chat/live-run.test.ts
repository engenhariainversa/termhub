import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STREAM_END_INPUT_LINE } from '@termhub/agent-protocol';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatNotice } from '../db/repositories/chat.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { ChatSubagent } from '../db/repositories/chat-subagents.js';
import type { SubagentStatus } from './stream.js';
import { chatBus, type ChatEvent } from './bus.js';
import { LiveRun, type LiveTurn } from './live-run.js';
import type { RunStream } from './service.js';
import { subagentOrigins } from './subagent-origin.js';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-background.ndjson'), 'utf8').split('\n').filter(Boolean);
const midTurn = readFileSync(join(import.meta.dirname, 'fixtures/stream-mid-turn-injection.ndjson'), 'utf8').split('\n').filter(Boolean);
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

function harness(sessionId: string | null = null) {
  const rows: ChatMessage[] = [];
  let n = 0;
  const chat = {
    addMessage: vi.fn(async (m: { conversation_id: string; role: 'user' | 'assistant'; text: string }) => {
      const row = { id: `m${++n}`, conversation_id: m.conversation_id, role: m.role, text: m.text, usage: null, error_code: null, created_at: '' } as unknown as ChatMessage;
      rows.push(row);
      return row;
    }),
    updateMessage: vi.fn(async (id: string, p: { text?: string; usage?: unknown; error_code?: string | null; notice?: ChatNotice | null }) => {
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, p.text === undefined ? {} : { text: p.text }, p.error_code === undefined ? {} : { error_code: p.error_code }, p.notice ? { notice: p.notice } : {});
      return { ...row };
    }),
    deleteMessage: vi.fn(async (id: string) => void rows.splice(rows.findIndex((r) => r.id === id), 1)),
    setCliSession: vi.fn(async () => undefined),
    setContext: vi.fn(async (_id: string, u: { tokens: number; window?: number | null }) => ({ tokens: u.tokens, window: u.window ?? null })),
  };
  /** Subagent rows as the repository keeps them: one per task, `sa-<task_id>`. */
  const subagentRows = new Map<string, ChatSubagent>();
  const subagentRow = (id: string, status: SubagentStatus, extra: Partial<ChatSubagent> = {}): ChatSubagent => ({
    id, conversation_id: 'c1', task_id: 't?', tool_use_id: 'u?', description: '', subagent_type: null, status, started_at: '2026-09-26T12:00:00.000Z', ended_at: null, ...extra,
  });
  const subagents = {
    start: vi.fn(async (i: { conversation_id: string; task_id: string; tool_use_id: string; description: string; subagent_type: string | null }) => {
      const row = subagentRow(`sa-${i.task_id}`, 'running', { task_id: i.task_id, tool_use_id: i.tool_use_id, description: i.description, subagent_type: i.subagent_type });
      subagentRows.set(row.id, row);
      return row;
    }),
    /** Conditional like the repository's: with `from`, a row in any other state is left alone. */
    setStatus: vi.fn(async (id: string, status: SubagentStatus, opts?: { from?: SubagentStatus[] }) => {
      const existing = subagentRows.get(id);
      if (existing && opts?.from && !opts.from.includes(existing.status)) return undefined;
      const row = { ...(existing ?? subagentRow(id, status)), status };
      subagentRows.set(id, row);
      return row;
    }),
    interruptRunning: vi.fn(async (_conversationId: string) => {
      const open = [...subagentRows.values()].filter((r) => r.status === 'running' || r.status === 'stopping');
      return open.map((r) => {
        const row = { ...r, status: 'interrupted' as const, ended_at: '2026-09-26T12:05:00.000Z' };
        subagentRows.set(r.id, row);
        return row;
      });
    }),
  };
  const chatActions = { setSubagentByToolUse: vi.fn(async (_c: string, _t: string, _s: string): Promise<ChatAction[]> => []) };
  const describeLate = vi.fn(async (_actions: ChatAction[]) => undefined);
  const onTurnsChanged = vi.fn();
  const live = new LiveRun({ userId: 'u1', conversationId: 'c1', sessionId, chat, subagents, chatActions, describeLate, onTurnsChanged });
  const events: ChatEvent[] = [];
  const off = chatBus.subscribe((e) => events.push(e));
  /** A turn as the service builds it: question and empty answer already stored. */
  const turn = async (uuid: string, text: string) => {
    const question = await chat.addMessage({ conversation_id: 'c1', role: 'user', text });
    const answer = await chat.addMessage({ conversation_id: 'c1', role: 'assistant', text: '' });
    let resolve!: (m: ChatMessage) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<ChatMessage>((res, rej) => ((resolve = res), (reject = rej)));
    const t: LiveTurn = { uuid, text, question, answer, settle: { resolve, reject } };
    return { t, done };
  };
  return { live, chat, rows, events, off, turn, subagents, chatActions, describeLate, onTurnsChanged };
}

/** A hand-driven stream: `push` a CLI line, `end()` the process; `written` is what the driver wrote,
 *  and `closed()` whether the driver closed it (which ends the process, as closing the channel does). */
function manualStream() {
  const queue: string[] = [];
  let ended = false;
  let closed = false;
  let wake: (() => void) | null = null;
  const written: string[] = [];
  const stream: RunStream = {
    write: (line) => (ended ? false : (written.push(line), true)),
    close: () => ((closed = true), (ended = true), poke()),
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
  function poke() { const w = wake; wake = null; w?.(); }
  return { stream, written, closed: () => closed, push: (l: string) => (queue.push(l), poke()), end: () => ((ended = true), poke()) };
}

const replay = (uuid: string) => JSON.stringify({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: 'x' } });
const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const result = (session = 's1') => JSON.stringify({ type: 'result', session_id: session, usage: { input_tokens: 1 } });
const background = (count: number) => JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: count }, (_, i) => ({ task_id: `t${i}` })) });
const settle = () => new Promise((r) => setTimeout(r, 10));

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h?.off();
  h = harness();
});

it('answers a message injected while a background subagent runs, and gives the notification its own message (real run)', async () => {
  const one = await h.turn(U1, 'dispara');
  expect(h.live.add(one.t)).toBe(true);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  const two = await h.turn(U2, 'capital?');
  for (const line of fixture) {
    s.push(line);
    await settle();
    // Inject the second message right after the first turn's result, as the recording did.
    if (JSON.parse(line).type === 'result' && !s.written.length) expect(h.live.add(two.t)).toBe(true);
  }
  s.end();
  expect(await consumed).toEqual({ code: null, missingSession: false, limit: null });

  expect((await one.done).text).toBe('Disparei um subagente.');
  expect((await two.done).text).toBe('Paris');
  const assistants = h.rows.filter((r) => r.role === 'assistant');
  expect(assistants.map((r) => r.text)).toEqual(['Disparei um subagente.', 'Paris', 'O subagente terminou: texto sobre faróis pronto.']);
  expect(assistants.every((r) => !/lighthouse/i.test(r.text))).toBe(true);
  // The injected line, then the end of input once the notification turn left nothing running.
  expect(JSON.parse(s.written[0])).toMatchObject({ type: 'user', uuid: U2 });
  expect(s.written.at(-1)).toBe(STREAM_END_INPUT_LINE);
  expect(h.events.filter((e) => e.type === 'run_finished')).toHaveLength(3);
});

it('two injected turns get one answer each, in the order of their replays', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(delta('resposta A')); s.push(result());
  s.push(replay(U2)); s.push(delta('resposta B')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect((await a.done).text).toBe('resposta A');
  expect((await b.done).text).toBe('resposta B');
});

it('keeps the input open while a subagent runs and ends it once nothing is left', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(background(1)); s.push(delta('disparei')); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(true);
  expect(s.written).toEqual([]);
  // The subagent ends: the CLI reports it in a turn of its own, and the input ends with that turn.
  s.push(background(0));
  await settle();
  expect(h.live.accepting).toBe(true);
  s.push(delta('terminou')); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(false);
  expect(s.written).toEqual([STREAM_END_INPUT_LINE]);
  expect(h.live.add((await h.turn(U2, 'tarde')).t)).toBe(false);
  s.end();
  await consumed;
});

it('keeps the input open when the turn that reports the last subagent starts another one (TER-498)', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(background(1)); s.push(delta('disparei')); s.push(result());
  await settle();
  // A monitor ends, and the turn the CLI starts to report it launches the next monitor.
  s.push(background(0)); s.push(toolCall()); s.push(background(1)); s.push(delta('relancei')); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(true);
  expect(s.written).toEqual([]);
  // With its input open the CLI ends each turn with a `result`: the text is stored, and nothing is owed.
  expect(h.live.busy).toBe(false);
  expect(h.rows.filter((r) => r.role === 'assistant').map((r) => r.text)).toEqual(['disparei', 'relancei']);
  // A message typed now goes straight in, monitor or not.
  expect(h.live.add((await h.turn(U2, 'e agora?')).t)).toBe(true);
  s.end();
  await consumed;
});

it('keeps the input open when a subagent ends during a turn: the turn that reports it comes next, and may start another (TER-498)', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  // The subagent ends while the person's turn is still being answered (Claude Code 2.1.285 then
  // reports it in a turn of its own, right after this one).
  s.push(replay(U1)); s.push(background(1)); s.push(delta('disparei'));
  s.push(background(0)); s.push(taskUpdated('t1', 'completed')); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(true);
  s.push(toolCall()); s.push(background(1)); s.push(delta('relancei')); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(true);
  expect(h.rows.filter((r) => r.role === 'assistant').map((r) => r.text)).toEqual(['disparei', 'relancei']);
  // That one ends with nothing being answered, and the turn that reports it starts nothing.
  s.push(background(0)); s.push(taskUpdated('t2', 'completed')); s.push(delta('fim')); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(false);
  expect(s.written).toEqual([STREAM_END_INPUT_LINE]);
  s.end();
  await consumed;
});

/** A process left with its input closed and a subagent in the background: the input ended with a
 *  turn, and a turn the CLI started afterwards launched a subagent (here the CLI never said that the
 *  first one had ended). The CLI holds that turn's `result` back until nothing is left running. */
async function stranded() {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(background(1)); s.push(background(0)); s.push(delta('disparei')); s.push(result());
  await settle();
  s.push(toolCall()); s.push(background(1)); s.push(delta('relancei'));
  await settle();
  return { s, consumed };
}

it('stop ends a process that takes no input, and what its own turn had said is stored as a message (TER-498)', async () => {
  const { s, consumed } = await stranded();
  expect(h.live.accepting).toBe(false);
  expect(h.live.busy).toBe(true);
  h.live.stop();
  expect(s.closed()).toBe(true);
  await consumed;
  // What the service does once the stream is over: a turn cut by a stop is not a failed answer.
  await h.live.failOpen('RUNNER_FAILED');
  expect(h.rows.filter((r) => r.role === 'assistant').at(-1)).toMatchObject({ text: 'relancei', error_code: null });
  expect(h.live.busy).toBe(false);
});

it('giveWay stops a process that takes no input and has a subagent in the background (TER-498)', async () => {
  const { s, consumed } = await stranded();
  h.live.giveWay();
  expect(s.closed()).toBe(true);
  await consumed;
});

it('giveWay leaves a process with nothing in the background to finish, and stops it if a turn on its way starts a subagent', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(delta('ok')); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(false);
  // Nothing in the background: the process exits on its own once it is done.
  h.live.giveWay();
  expect(s.closed()).toBe(false);
  // A turn that was still on its way starts a subagent: nothing would end this process for a long time.
  s.push(toolCall()); s.push(background(1));
  await settle();
  expect(s.closed()).toBe(true);
  await consumed;
});

/** A shutdown in the middle of a turn the CLI started on its own, with a message of the person's
 *  written and not yet replayed. */
async function cutByShutdown() {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(background(1)); s.push(delta('disparei')); s.push(result());
  await settle();
  h.live.add(b.t);
  s.push(delta('o subagente terminou'));
  await settle();
  s.end();
  await consumed;
  return { b };
}

it('rejectOpen (a shutdown) stores what a turn of the CLI\'s own had said, and leaves the person\'s turn open for the resume (TER-498)', async () => {
  const { b } = await cutByShutdown();
  await h.live.rejectOpen(new Error('restarting'));
  await expect(b.done).rejects.toThrow('restarting');
  expect(h.rows.find((r) => r.id === b.t.answer.id)).toMatchObject({ text: '', error_code: null });
  // Nobody resumes a turn the CLI started: its row would stay empty for good.
  expect(h.rows.at(-1)).toMatchObject({ role: 'assistant', text: 'o subagente terminou', error_code: null });
});

it('rejectOpen never throws: a row that cannot be stored still leaves every turn of the person\'s rejected', async () => {
  const { b } = await cutByShutdown();
  h.chat.updateMessage.mockRejectedValueOnce(new Error('db gone'));
  await expect(h.live.rejectOpen(new Error('restarting'))).resolves.toBeUndefined();
  await expect(b.done).rejects.toThrow('restarting');
});

it('a stream that ends with turns open fails each one', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(delta('pela metade'));
  s.push(JSON.stringify({ type: 'termhub_error', code: null, reason: 'host_gone' }));
  s.end();
  const outcome = await consumed;
  expect(outcome.code).toBe('HOST_GONE');
  await h.live.failOpen(outcome.code);
  expect(await a.done).toMatchObject({ text: 'pela metade', error_code: 'HOST_GONE' });
  expect(await b.done).toMatchObject({ text: '', error_code: 'HOST_GONE' });
});

it('fails only the turn whose result is an error, and goes on', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(JSON.stringify({ type: 'result', is_error: true, session_id: 's1' }));
  s.push(replay(U2)); s.push(delta('ok')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect((await a.done).error_code).toBe('RUN_FAILED');
  expect(await b.done).toMatchObject({ text: 'ok', error_code: null });
});

it('stores the session the CLI reports, once', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(result('sess-9')); s.push(result('sess-9'));
  await settle();
  s.end();
  await consumed;
  expect(h.chat.setCliSession).toHaveBeenCalledTimes(1);
  expect(h.chat.setCliSession).toHaveBeenCalledWith('c1', 'sess-9');
  expect(h.live.sessionId).toBe('sess-9');
});

it('writes every waiting turn as the first input, one line each', async () => {
  h.live.add((await h.turn(U1, 'a')).t);
  h.live.add((await h.turn(U2, 'b')).t);
  const lines = h.live.initialText().split('\n');
  expect(lines.at(-1)).toBe('');
  expect(lines.slice(0, -1).map((l) => JSON.parse(l).uuid)).toEqual([U1, U2]);
});

it('restart puts the open turns back and drops their partial text', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(delta('perdido'));
  s.push(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'missing_session' }));
  s.end();
  expect(await consumed).toEqual({ code: 'MISSING_SESSION', missingSession: true, limit: null });
  await h.live.restart();
  expect(h.events.some((e) => e.type === 'reset' && e.message_id === a.t.answer.id)).toBe(true);
  expect(h.live.accepting).toBe(true);
  expect(JSON.parse(h.live.initialText().trim()).uuid).toBe(U1);
  const s2 = manualStream();
  const again = h.live.consume(s2.stream);
  s2.push(replay(U1)); s2.push(delta('de novo')); s2.push(result());
  await settle();
  s2.end();
  await again;
  expect((await a.done).text).toBe('de novo');
});

it('abandon deletes every open answer and rejects every open turn', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const err = new Error('setup');
  await h.live.abandon(err);
  await expect(a.done).rejects.toBe(err);
  expect(h.rows.map((r) => r.role)).toEqual(['user']);
});

it('a turn whose answer cannot be stored rejects instead of hanging, and failOpen still settles the rest', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  const c = await h.turn('33333333-3333-4333-8333-333333333333', 'c');
  h.live.add(a.t);
  h.live.add(b.t);
  h.live.add(c.t);
  const boom = new Error('db down');
  h.chat.updateMessage.mockRejectedValueOnce(boom);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(delta('x')); s.push(result());
  s.end();
  await expect(consumed).rejects.toBe(boom);
  await expect(a.done).rejects.toBe(boom);

  // failOpen: the first store fails, the next turn is still stored, and the failure comes back.
  const boom2 = new Error('db down again');
  h.chat.updateMessage.mockRejectedValueOnce(boom2);
  await expect(h.live.failOpen('RUNNER_FAILED')).rejects.toBe(boom2);
  await expect(b.done).rejects.toBe(boom2);
  expect(await c.done).toMatchObject({ error_code: 'RUNNER_FAILED' });
});

it('abandon rejects every open turn even when deleting an answer fails', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  h.live.add(b.t);
  const boom = new Error('db down');
  h.chat.deleteMessage.mockRejectedValueOnce(boom);
  const err = new Error('setup');
  await expect(h.live.abandon(err)).rejects.toBe(boom);
  await expect(a.done).rejects.toBe(err);
  await expect(b.done).rejects.toBe(err);
  expect(h.rows.filter((r) => r.role === 'assistant').map((r) => r.id)).toEqual([a.t.answer.id]);
});

it('merges a message the CLI folds into the running turn: one answer settles both (real run)', async () => {
  const M1 = 'f70d2c55-8121-4577-9d43-c91ae068d00a';
  const M2 = '66ac0883-fcfa-4ca9-9f0d-c8618d23ae42';
  const one = await h.turn(M1, 'dispara em primeiro plano');
  const two = await h.turn(M2, 'confirma');
  h.live.add(one.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  expect(h.live.add(two.t)).toBe(true);
  for (const line of midTurn) s.push(line);
  await settle();
  s.end();
  expect(await consumed).toEqual({ code: null, missingSession: false, limit: null });

  const first = await one.done;
  const second = await two.done;
  expect(first).toEqual(second);
  expect(first.id).toBe(two.t.answer.id);
  expect(first.text.startsWith('The hook blocked the foreground Agent call')).toBe(true);
  expect(h.rows.some((r) => r.id === one.t.answer.id)).toBe(false);
  expect(h.chat.deleteMessage).toHaveBeenCalledWith(one.t.answer.id);
  expect(h.rows.filter((r) => r.role === 'assistant')).toHaveLength(1);
  expect(h.events.filter((e) => e.type === 'run_finished')).toHaveLength(1);
  expect(h.live.endedTurns).toBe(2);
});

it('a running turn that already said something keeps its text when the next replay arrives', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(delta('parte A'));
  s.push(replay(U2)); s.push(delta('parte B')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect(await a.done).toMatchObject({ id: a.t.answer.id, text: 'parte A', error_code: null });
  expect(await b.done).toMatchObject({ id: b.t.answer.id, text: 'parte B', error_code: null });
  expect(h.chat.deleteMessage).not.toHaveBeenCalled();
});

it('failOpen settles a merged turn with the stored error message', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(replay(U2)); s.push(delta('meio'));
  s.push(JSON.stringify({ type: 'termhub_error', code: null, reason: 'host_gone' }));
  s.end();
  const outcome = await consumed;
  await h.live.failOpen(outcome.code);
  const first = await a.done;
  expect(first).toMatchObject({ id: b.t.answer.id, text: 'meio', error_code: 'HOST_GONE' });
  expect(await b.done).toEqual(first);
});

it('restart puts a merged turn back in order, with a new answer row', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(replay(U2));
  s.push(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'missing_session' }));
  s.end();
  expect((await consumed).missingSession).toBe(true);
  const before = h.events.length;
  await h.live.restart();
  expect(h.live.initialText().trim().split('\n').map((l) => JSON.parse(l).uuid)).toEqual([U1, U2]);
  expect(h.rows.some((r) => r.id === a.t.answer.id)).toBe(true);
  // The merged turn (`a`, folded into `b`'s answer) has a new row: its `message`, then the reset,
  // then the announcement (spec §4 order).
  const row = a.t.answer.id;
  const ofRow = h.events.slice(before).filter((e) => (e.type === 'message' && e.message.id === row) || ((e.type === 'reset' || e.type === 'run_started') && e.message_id === row));
  expect(ofRow.map((e) => e.type)).toEqual(['message', 'reset', 'run_started']);
});

it('abandon rejects a merged turn too', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  s.push(replay(U1)); s.push(replay(U2));
  await settle();
  const err = new Error('gone');
  await h.live.abandon(err);
  await expect(a.done).rejects.toBe(err);
  await expect(b.done).rejects.toBe(err);
  s.end();
  await consumed;
});

const toolCall = () => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_n', name: 'mcp__termhub__list_tabs', input: {} }] } });

it('drops a notification turn that said nothing when the next replay arrives, instead of storing it empty', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(background(1)); s.push(delta('disparei')); s.push(result());
  await settle();
  h.live.add(b.t);
  // The CLI starts a turn on its own (a tool call, no text yet), then replays the person's message.
  s.push(toolCall());
  await settle();
  const notification = h.rows.filter((r) => r.role === 'assistant').at(-1)!;
  expect(notification.id).not.toBe(b.t.answer.id);
  s.push(replay(U2)); s.push(delta('resposta B')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect(await b.done).toMatchObject({ text: 'resposta B', error_code: null });
  expect(h.chat.deleteMessage).toHaveBeenCalledWith(notification.id);
  expect(h.rows.some((r) => r.id === notification.id)).toBe(false);
  expect(h.chat.updateMessage).not.toHaveBeenCalledWith(notification.id, expect.anything());
  // Every open screen is told to re-read, and nothing announces the dropped row as a finished run.
  expect(h.events.filter((e) => e.type === 'run_finished').map((e) => (e as { message_id: string }).message_id)).toEqual([a.t.answer.id, b.t.answer.id]);
  expect(h.events.filter((e) => e.type === 'message').length).toBeGreaterThan(0);
});

it('drops a notification turn that ends with no text at all', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(background(1)); s.push(delta('disparei')); s.push(result());
  await settle();
  s.push(background(0)); s.push(toolCall()); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect(h.rows.filter((r) => r.role === 'assistant').map((r) => r.text)).toEqual(['disparei']);
  expect(h.events.filter((e) => e.type === 'run_finished')).toHaveLength(1);
});

it('fails the waiting turns and ends the input when a turn ends and the CLI never replayed a message', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  // A CLI that does not replay: its answer is not matched to any turn.
  s.push(delta('sem replay')); s.push(result());
  await settle();
  expect(await a.done).toMatchObject({ id: a.t.answer.id, error_code: 'RUN_FAILED' });
  expect(await b.done).toMatchObject({ id: b.t.answer.id, error_code: 'RUN_FAILED' });
  expect(h.live.accepting).toBe(false);
  expect(s.written.at(-1)).toBe(STREAM_END_INPUT_LINE);
  s.end();
  await consumed;
});

/** What a resumed session writes before it replays anything when its previous process left a subagent
 *  unfinished (Claude Code 2.1.285): that task's notification, then a `result` that ended no turn. */
const leftover = () => [
  JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 't-old', status: 'stopped' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', session_id: 's1', usage: { input_tokens: 0, output_tokens: 0, iterations: [] } }),
];

it('keeps the waiting turns when a resumed session ends a turn of its own before it replays anything (TER-498)', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  for (const line of leftover()) s.push(line);
  await settle();
  expect(h.live.accepting).toBe(true);
  expect(s.written).toEqual([]);
  s.push(replay(U1)); s.push(delta('resposta')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect(await a.done).toMatchObject({ text: 'resposta', error_code: null });
});

it('keeps waiting turns waiting at a result once the CLI has replayed in this process', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(background(1)); s.push(delta('A')); s.push(result());
  await settle();
  expect(h.live.add(b.t)).toBe(true);
  s.push(background(0)); s.push(delta('notificação')); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(true);
  s.push(replay(U2)); s.push(delta('B')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect((await b.done).text).toBe('B');
});

// Subagents (spec 2026-09-26 panel §5.3): what the stream says about them is kept, published, and
// never allowed to break the answer.
const taskStarted = (task: string, toolUse: string, description: string) => JSON.stringify({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: toolUse, description, subagent_type: 'general-purpose' });
const taskUpdated = (task: string, status: string) => JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: task, patch: { status } });
const subagentTool = (parent: string, id: string, tool: string) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: `mcp__termhub__${tool}`, input: {} }] } });
const controlResponse = (requestId: string, ok: boolean) => JSON.stringify({ type: 'control_response', response: ok ? { subtype: 'success', request_id: requestId } : { subtype: 'error', request_id: requestId, error: 'nope' } });
const subagentEvents = () => h.events.filter((e): e is Extract<ChatEvent, { type: 'subagent' }> => e.type === 'subagent');

/** A run with one turn replayed and answered, the stream left open for more. */
async function running() {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(background(1)); s.push(delta('disparei'));
  await settle();
  return { a, s, consumed };
}

it('registers a started subagent, updates its status and publishes both', async () => {
  const { s, consumed } = await running();
  s.push(taskStarted('t1', 'u1', 'Buscar CI')); s.push(result());
  await settle();
  s.push(taskUpdated('t1', 'completed'));
  await settle();
  s.end();
  await consumed;
  expect(h.subagents.start).toHaveBeenCalledWith({ conversation_id: 'c1', task_id: 't1', tool_use_id: 'u1', description: 'Buscar CI', subagent_type: 'general-purpose' });
  expect(h.subagents.setStatus).toHaveBeenCalledWith('sa-t1', 'completed', { from: ['running', 'stopping'] });
  expect(subagentEvents().map((e) => [e.user_id, e.conversation_id, e.subagent.id, e.subagent.status])).toEqual([
    ['u1', 'c1', 'sa-t1', 'running'],
    ['u1', 'c1', 'sa-t1', 'completed'],
  ]);
  expect(subagentEvents()[0].subagent).toEqual({ id: 'sa-t1', description: 'Buscar CI', subagent_type: 'general-purpose', status: 'running', started_at: '2026-09-26T12:00:00.000Z', ended_at: null });
  // Nothing was left running: the end of the stream interrupts nothing.
  expect(subagentEvents().some((e) => e.subagent.status === 'interrupted')).toBe(false);
});

it('ignores a status for a task it never saw start', async () => {
  const { s, consumed } = await running();
  s.push(taskUpdated('t9', 'completed'));
  await settle();
  s.end();
  await consumed;
  expect(h.subagents.setStatus).not.toHaveBeenCalled();
});

it('interrupts running subagents when the stream ends', async () => {
  const { s, consumed } = await running();
  s.push(taskStarted('t1', 'u1', 'Buscar CI')); s.push(taskStarted('t2', 'u2', 'Rodar testes')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect(h.subagents.interruptRunning).toHaveBeenCalledWith('c1');
  expect(subagentEvents().filter((e) => e.subagent.status === 'interrupted').map((e) => e.subagent.id)).toEqual(['sa-t1', 'sa-t2']);
});

it('a subagent bookkeeping failure never breaks the answer', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.subagents.start.mockRejectedValueOnce(Object.assign(new Error('secret text'), { code: 'P1001' }));
  h.subagents.interruptRunning.mockRejectedValueOnce(new Error('db down'));
  const { a, s, consumed } = await running();
  s.push(taskStarted('t1', 'u1', 'Buscar CI')); s.push(result());
  await settle();
  s.end();
  expect(await consumed).toEqual({ code: null, missingSession: false, limit: null });
  expect(await a.done).toMatchObject({ text: 'disparei', error_code: null });
  expect(err).toHaveBeenCalledWith(expect.stringMatching(/^chat: /), { conversation_id: 'c1', error: 'P1001' });
  expect(JSON.stringify(err.mock.calls)).not.toContain('secret text');
  err.mockRestore();
});

it('remembers the origin of a subagent termhub tool call and binds a late action', async () => {
  const action = { id: 'act1', subagent_id: 'sa-t1' } as unknown as ChatAction;
  h.chatActions.setSubagentByToolUse.mockResolvedValueOnce([action]);
  const { s, consumed } = await running();
  s.push(taskStarted('t1', 'u1', 'Buscar CI'));
  s.push(subagentTool('u1', 'toolu_B', 'send_input'));
  await settle();
  expect(subagentOrigins.originOf('toolu_B')).toEqual({ conversationId: 'c1', subagentId: 'sa-t1' });
  expect(h.chatActions.setSubagentByToolUse).toHaveBeenCalledWith('c1', 'toolu_B', 'sa-t1');
  expect(h.describeLate).toHaveBeenCalledWith([action]);
  s.end();
  await consumed;
});

it('does not look up actions for a subagent read tool', async () => {
  const { s, consumed } = await running();
  s.push(taskStarted('t1', 'u1', 'Buscar CI'));
  s.push(subagentTool('u1', 'toolu_R', 'list_tabs'));
  await settle();
  expect(subagentOrigins.originOf('toolu_R')).toEqual({ conversationId: 'c1', subagentId: 'sa-t1' });
  expect(h.chatActions.setSubagentByToolUse).not.toHaveBeenCalled();
  expect(h.describeLate).not.toHaveBeenCalled();
  s.end();
  await consumed;
});

it('does not describe anything when no action was waiting for the call', async () => {
  const { s, consumed } = await running();
  s.push(taskStarted('t1', 'u1', 'Buscar CI'));
  s.push(subagentTool('u1', 'toolu_C', 'run_command'));
  s.push(subagentTool('u9', 'toolu_D', 'run_command')); // a parent it never saw start
  await settle();
  expect(h.chatActions.setSubagentByToolUse).toHaveBeenCalledTimes(1);
  expect(h.describeLate).not.toHaveBeenCalled();
  expect(subagentOrigins.originOf('toolu_D')).toBeUndefined();
  s.end();
  await consumed;
});

it('writes a stop_task control line', async () => {
  const { s, consumed } = await running();
  expect(h.live.stopTask('t1', 'sa1')).toBe(true);
  expect(JSON.parse(s.written.at(-1)!)).toEqual({ type: 'control_request', request_id: 'stop-sa1', request: { subtype: 'stop_task', task_id: 't1' } });
  // The status and its event are the caller's (ChatService): stopTask stays synchronous.
  expect(h.subagents.setStatus).not.toHaveBeenCalled();
  s.end();
  await consumed;
});

it('refuses to stop once input is closed', async () => {
  const { s, consumed } = await running();
  s.push(background(0)); s.push(result());
  await settle();
  expect(h.live.accepting).toBe(false);
  const before = s.written.length;
  expect(h.live.stopTask('t1', 'sa1')).toBe(false);
  expect(s.written).toHaveLength(before);
  s.end();
  await consumed;
  // …and with no process at all.
  expect(h.live.stopTask('t1', 'sa1')).toBe(false);
});

it('rolls a failed stop back to running and says so', async () => {
  const { s, consumed } = await running();
  s.push(taskStarted('t1', 'u1', 'Buscar CI'));
  await settle();
  await h.subagents.setStatus('sa-t1', 'stopping'); // the service persists it before the stop line
  expect(h.live.stopTask('t1', 'sa-t1')).toBe(true);
  s.push(controlResponse('stop-sa-t1', false));
  await settle();
  expect(h.subagents.setStatus).toHaveBeenCalledWith('sa-t1', 'running', { from: ['stopping'] });
  expect(h.events.filter((e) => e.type === 'subagent_cancel_failed')).toEqual([{ type: 'subagent_cancel_failed', user_id: 'u1', conversation_id: 'c1', subagent_id: 'sa-t1' }]);
  expect(subagentEvents().at(-1)!.subagent.status).toBe('running');
  // Rolled back once: a second rollback (the timeout) finds nothing to undo.
  await h.live.rollbackStop('sa-t1');
  expect(h.events.filter((e) => e.type === 'subagent_cancel_failed')).toHaveLength(1);
  s.end();
  await consumed;
});

it('a successful stop waits for the status frame', async () => {
  const { s, consumed } = await running();
  s.push(taskStarted('t1', 'u1', 'Buscar CI'));
  await settle();
  h.live.stopTask('t1', 'sa-t1');
  s.push(controlResponse('stop-sa-t1', true)); s.push(taskUpdated('t1', 'killed'));
  await settle();
  expect(h.subagents.setStatus.mock.calls).toEqual([['sa-t1', 'stopped', { from: ['running', 'stopping'] }]]);
  // The stop settled: the timeout's rollback does nothing now.
  await h.live.rollbackStop('sa-t1');
  expect(h.events.some((e) => e.type === 'subagent_cancel_failed')).toBe(false);
  s.end();
  await consumed;
});

it('a rollback that finds the row no longer stopping changes nothing and says nothing', async () => {
  const { s, consumed } = await running();
  s.push(taskStarted('t1', 'u1', 'Buscar CI'));
  await settle();
  // The service persisted `stopping`, then the stop was written…
  await h.subagents.setStatus('sa-t1', 'stopping');
  expect(h.live.stopTask('t1', 'sa-t1')).toBe(true);
  // …and something else already settled the row (another path wrote a final state) before the timeout.
  await h.subagents.setStatus('sa-t1', 'stopped');
  h.subagents.setStatus.mockClear();
  const before = h.events.length;
  await h.live.rollbackStop('sa-t1');
  expect(h.subagents.setStatus).toHaveBeenCalledWith('sa-t1', 'running', { from: ['stopping'] });
  expect(h.events.slice(before)).toEqual([]);
  s.end();
  await consumed;
});

it('ignores control responses it did not ask for', async () => {
  const { s, consumed } = await running();
  s.push(controlResponse('other', false)); s.push(controlResponse('stop-sa-nobody', false));
  await settle();
  expect(h.subagents.setStatus).not.toHaveBeenCalled();
  expect(h.events.some((e) => e.type === 'subagent_cancel_failed')).toBe(false);
  s.end();
  await consumed;
});

it('a note line is pending until its replay and its answer is a message of its own', async () => {
  const { a, s, consumed } = await running();
  s.push(result());
  await settle();
  expect(await a.done).toMatchObject({ text: 'disparei' });
  expect(h.live.addNote('nota')).toBe(true);
  const line = JSON.parse(s.written.at(-1)!);
  expect(line).toMatchObject({ type: 'user', message: { role: 'user', content: 'nota' } });
  expect(line.uuid).toMatch(/^[0-9a-f-]{36}$/);
  // Nothing running in the background, but the note was not replayed yet: the input stays open.
  s.push(background(0));
  await settle();
  expect(h.live.accepting).toBe(true);
  const before = h.rows.filter((r) => r.role === 'assistant').length;
  s.push(replay(line.uuid)); s.push(delta('anotado')); s.push(result());
  await settle();
  const assistants = h.rows.filter((r) => r.role === 'assistant');
  expect(assistants).toHaveLength(before + 1);
  expect(assistants.at(-1)).toMatchObject({ text: 'anotado', error_code: null });
  expect(h.live.accepting).toBe(false);
  expect(s.written.at(-1)).toBe(STREAM_END_INPUT_LINE);
  s.end();
  await consumed;
});

it('a note taken before the process starts is written first', async () => {
  h.live.add((await h.turn(U1, 'a')).t);
  expect(h.live.addNote('nota')).toBe(true);
  const lines = h.live.initialText().trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.map((l) => l.message.content)).toEqual(['nota', 'a']);
  expect(lines[1].uuid).toBe(U1);
});

it('reports stored turns on every change', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  expect(h.onTurnsChanged).toHaveBeenLastCalledWith([{ question_id: a.t.question!.id, answer_id: a.t.answer.id, text: 'a' }]);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  h.live.add(b.t);
  const both = [
    { question_id: a.t.question!.id, answer_id: a.t.answer.id, text: 'a' },
    { question_id: b.t.question!.id, answer_id: b.t.answer.id, text: 'b' },
  ];
  expect(h.onTurnsChanged).toHaveBeenLastCalledWith(both);
  const calls = h.onTurnsChanged.mock.calls.length;
  s.push(replay(U1));
  await settle();
  expect(h.onTurnsChanged.mock.calls.length).toBeGreaterThan(calls);
  expect(h.live.storedTurns()).toEqual(both);
  s.push(delta('A')); s.push(result());
  await settle();
  expect(h.onTurnsChanged).toHaveBeenLastCalledWith([both[1]]);
  s.push(replay(U2)); s.push(delta('B')); s.push(result());
  await settle();
  expect(h.onTurnsChanged).toHaveBeenLastCalledWith([]);
  s.end();
  await consumed;
});

it('a turn with no question (resumed after a restart) still gets its answer', async () => {
  const a = await h.turn(U1, 'a');
  a.t.question = null;
  h.live.add(a.t);
  expect(h.live.storedTurns()).toEqual([{ question_id: null, answer_id: a.t.answer.id, text: 'a' }]);
  const err = new Error('setup');
  await h.live.abandon(err);
  await expect(a.done).rejects.toBe(err);
});

it('a note replayed while a person\'s turn has said nothing yet leaves the reply in that turn', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  await settle();
  expect(h.live.addNote('nota')).toBe(true);
  const note = JSON.parse(s.written.at(-1)!).uuid;
  s.push(replay(note)); s.push(delta('resposta')); s.push(result());
  await settle();
  s.end();
  await consumed;
  expect(await a.done).toMatchObject({ id: a.t.answer.id, text: 'resposta', error_code: null });
  expect(h.rows.filter((r) => r.role === 'assistant').map((r) => r.id)).toEqual([a.t.answer.id]);
  expect(h.events.filter((e) => e.type === 'run_finished')).toHaveLength(1);
});

const typesOf = (events: ChatEvent[], id: string) =>
  events.filter((e) => ('message_id' in e && e.message_id === id) || (e.type === 'message' && e.message.id === id)).map((e) => e.type);

it('announces a turn it accepted with run_started, and says nothing for one it refused', async () => {
  const a = await h.turn(U1, 'a');
  expect(h.live.add(a.t)).toBe(true);
  expect(h.events.filter((e) => e.type === 'run_started')).toEqual([{ type: 'run_started', user_id: 'u1', conversation_id: 'c1', message_id: a.t.answer.id }]);

  h.live.endInput();
  const b = await h.turn(U2, 'b');
  expect(h.live.add(b.t)).toBe(false);
  expect(h.events.filter((e) => e.type === 'run_started')).toHaveLength(1);
});

it('a turn the CLI starts on its own publishes its message and then run_started', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('primeira'));
  s.push(result());
  await settle();
  const before = h.events.length;
  s.push(delta('por conta própria'));
  await settle();
  const own = h.events.slice(before);
  expect(own.map((e) => e.type)).toEqual(['message', 'run_started', 'delta']);
  expect((own[1] as { message_id: string }).message_id).toBe((own[0] as { message: ChatMessage }).message.id);
  s.end();
  await consumed;
});

it('a turn merged into the next one has its empty row removed, and says so', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  await settle();
  h.live.add(b.t);
  s.push(replay(U2));
  await settle();
  expect(h.events.filter((e) => e.type === 'message_removed')).toEqual([{ type: 'message_removed', user_id: 'u1', conversation_id: 'c1', message_id: a.t.answer.id }]);
  s.push(delta('as duas'));
  s.push(result());
  s.end();
  await consumed;
});

it('a turn the CLI started that said nothing has its row removed, and says so', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('resposta'));
  s.push(result());
  await settle();
  s.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu9', name: 'Read', input: {} }] } }));
  await settle();
  s.push(result());
  await settle();
  const removed = h.events.filter((e) => e.type === 'message_removed');
  expect(removed).toHaveLength(1);
  expect(h.rows.some((r) => r.id === (removed[0] as { message_id: string }).message_id)).toBe(false);
  s.end();
  await consumed;
});

it('abandon removes every open answer and says so for each', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  a.done.catch(() => {});
  b.done.catch(() => {});
  h.live.add(a.t);
  h.live.add(b.t);
  await h.live.abandon(new Error('setup'));
  expect(h.events.filter((e) => e.type === 'message_removed').map((e) => (e as { message_id: string }).message_id)).toEqual([a.t.answer.id, b.t.answer.id]);
});

it('restart announces every waiting turn again, after its reset', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('meia'));
  await settle();
  s.end();
  await consumed;
  const before = h.events.length;
  await h.live.restart();
  expect(typesOf(h.events.slice(before), a.t.answer.id)).toEqual(['reset', 'run_started']);
});

/** A process that died while writing a turn the CLI started on its own, with a turn of the person's
 *  waiting (written before the first turn's result, so the input was still open). */
async function diedOnItsOwnTurn() {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('resposta'));
  await settle();
  const b = await h.turn(U2, 'b');
  expect(h.live.add(b.t)).toBe(true);
  s.push(result());
  s.push(delta('por conta própria'));
  await settle();
  const own = h.rows.find((r) => r.role === 'assistant' && r.id !== a.t.answer.id && r.id !== b.t.answer.id)!;
  expect(own).toBeDefined();
  s.end();
  await consumed;
  return { b, own };
}

it('restart removes the row of a turn the CLI started, after the waiting turns were announced', async () => {
  const { b, own } = await diedOnItsOwnTurn();
  const before = h.events.length;
  await h.live.restart();
  const after = h.events.slice(before);
  expect(h.rows.some((r) => r.id === own.id)).toBe(false);
  expect(h.live.storedTurns().map((t) => t.answer_id)).toEqual([b.t.answer.id]);
  const removedAt = after.findIndex((e) => e.type === 'message_removed' && e.message_id === own.id);
  const announcedAt = after.findIndex((e) => e.type === 'run_started' && e.message_id === b.t.answer.id);
  expect(announcedAt).toBeGreaterThanOrEqual(0);
  expect(removedAt).toBeGreaterThan(announcedAt);
});

it('a row restart could not remove strands nobody: the waiting turns wait again and nothing is announced as removed', async () => {
  const { b, own } = await diedOnItsOwnTurn();
  h.chat.deleteMessage.mockRejectedValueOnce(new Error('database down'));
  const before = h.events.length;
  await expect(h.live.restart()).resolves.toBeUndefined();
  expect(h.live.storedTurns().map((t) => t.answer_id)).toEqual([b.t.answer.id]);
  expect(h.events.slice(before).some((e) => e.type === 'message_removed')).toBe(false);
  expect(h.rows.some((r) => r.id === own.id)).toBe(true);
  // The fresh session still goes in: a failed removal does not leave the dead session behind.
  expect(h.chat.setCliSession).toHaveBeenCalledWith('c1', null);
});

it('lists the answers it still owes: the one being written, then the waiting ones', async () => {
  expect(h.live.openAnswerIds()).toEqual([]);
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  h.live.add(b.t);
  expect(h.live.openAnswerIds()).toEqual([a.t.answer.id, b.t.answer.id]);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('resposta'));
  s.push(result());
  await settle();
  expect(h.live.openAnswerIds()).toEqual([b.t.answer.id]);
  s.push(replay(U2));
  s.push(delta('outra'));
  s.push(result());
  await settle();
  expect(h.live.openAnswerIds()).toEqual([]);
  s.push(delta('por conta própria'));
  await settle();
  expect(h.live.openAnswerIds()).toHaveLength(1);
  s.end();
  await consumed;
});

// TER-588: the CLI's own frames, recorded with the account at its usage limit (Claude Code 2.1.285).
const usageLimit = readFileSync(join(import.meta.dirname, 'fixtures/stream-usage-limit.ndjson'), 'utf8').split('\n').filter(Boolean);
const modelNotFound = readFileSync(join(import.meta.dirname, 'fixtures/stream-model-not-found.ndjson'), 'utf8').split('\n').filter(Boolean);
const swapNotice: ChatNotice = { kind: 'account_swap', from: null, to: 'Trabalho', resets_at: '2026-09-30T06:20:00.000Z' };

it('puts a turn that met the usage limit back in the queue, with the reset time and where the session lives', async () => {
  const a = await h.turn(U1, 'oi');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  for (const line of usageLimit) s.push(line);
  await settle();
  // the input ends: nothing more goes to an account at its limit
  expect(s.written.at(-1)).toBe(STREAM_END_INPUT_LINE);
  s.push(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'run_failed' }));
  s.end();
  expect(await consumed).toEqual({ code: 'RUN_FAILED', missingSession: false, limit: { resets_at: new Date(1790749200 * 1000).toISOString() } });
  expect(h.live.sessionDir).toBe('/home/u/.claude/projects/-srv');
  // not answered: waiting again, its screen cleared
  expect(h.chat.updateMessage).not.toHaveBeenCalled();
  expect(h.events.some((e) => e.type === 'reset' && e.message_id === a.t.answer.id)).toBe(true);
  expect(JSON.parse(h.live.initialText().trim()).uuid).toBe(U1);
});

it('answers the turn on the next account, resuming the same session, with the notice of the swap', async () => {
  h.off();
  h = harness('ee7af5ab-976a-43f5-92e0-d1afd433c518');
  const a = await h.turn(U1, 'oi');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  for (const line of usageLimit) s.push(line);
  await settle();
  s.end();
  await consumed;
  await h.live.retryElsewhere({ fresh: false, notice: swapNotice });
  expect(h.live.accepting).toBe(true);
  expect(h.live.sessionId).toBe('ee7af5ab-976a-43f5-92e0-d1afd433c518');
  expect(h.chat.setCliSession).not.toHaveBeenCalledWith('c1', null);
  // a new uuid: the resumed session holds U1, and a CLI that reads a uuid it has on file answers nothing (TER-837)
  const U2 = JSON.parse(h.live.initialText().trim()).uuid as string;
  expect(U2).not.toBe(U1);
  const s2 = manualStream();
  const again = h.live.consume(s2.stream);
  s2.push(replay(U2)); s2.push(delta('oi!')); s2.push(result('ee7af5ab-976a-43f5-92e0-d1afd433c518'));
  await settle();
  s2.end();
  expect(await again).toMatchObject({ code: null, limit: null });
  const final = await a.done;
  expect(final).toMatchObject({ text: 'oi!', error_code: null, notice: swapNotice });
});

it('starts a fresh session on the next account when the old one could not be moved', async () => {
  h.off();
  h = harness('ee7af5ab-976a-43f5-92e0-d1afd433c518');
  const a = await h.turn(U1, 'oi');
  h.live.add(a.t);
  await h.live.retryElsewhere({ fresh: true, notice: swapNotice });
  expect(h.live.sessionId).toBeNull();
  expect(h.chat.setCliSession).toHaveBeenCalledWith('c1', null);
});

it('stores every open turn as the usage limit, with its notice, when no account is left', async () => {
  const a = await h.turn(U1, 'oi');
  const b = await h.turn(U2, 'e aí');
  h.live.add(a.t);
  h.live.add(b.t);
  const notice: ChatNotice = { kind: 'usage_limit', account: null, resets_at: '2026-09-30T06:20:00.000Z', fallback: 'none_free' };
  await h.live.failOpen('USAGE_LIMIT', notice);
  expect(await a.done).toMatchObject({ error_code: 'USAGE_LIMIT', notice });
  expect(await b.done).toMatchObject({ error_code: 'USAGE_LIMIT', notice });
});

it('keeps what a turn already said when the limit comes mid-answer, and stores it as the limit', async () => {
  const a = await h.turn(U1, 'oi');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1)); s.push(delta('metade'));
  for (const line of usageLimit) s.push(line);
  await settle();
  s.end();
  expect(await consumed).toMatchObject({ limit: null });
  expect(await a.done).toMatchObject({ text: 'metade', error_code: 'USAGE_LIMIT' });
});

it('names a model the CLI does not know instead of the generic failure', async () => {
  const a = await h.turn(U1, 'oi');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  for (const line of modelNotFound) s.push(line);
  await settle();
  s.end();
  await consumed;
  expect(await a.done).toMatchObject({ error_code: 'MODEL_UNAVAILABLE' });
});

it('keeps the order of the turns when the limit meets one while the next is already written (review of TER-588)', async () => {
  const a = await h.turn(U1, 'primeira');
  const b = await h.turn(U2, 'segunda');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  await settle();
  h.live.add(b.t); // written to the process before it met the limit
  for (const line of usageLimit.slice(0, 4)) s.push(line);
  await settle();
  // the process had read the second line already: it replays it, and fails it too
  s.push(replay(U2));
  for (const line of usageLimit.slice(1, 4)) s.push(line);
  await settle();
  s.end();
  expect(await consumed).toMatchObject({ limit: { resets_at: expect.any(String) } });
  expect(h.live.initialText().trim().split('\n').map((l) => JSON.parse(l).uuid)).toEqual([U1, U2]);
  expect(h.chat.updateMessage).not.toHaveBeenCalled();
});

it('does not re-run a turn that already called a tool when the limit comes', async () => {
  const a = await h.turn(U1, 'faz');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__termhub__send_input', input: {} }] } }));
  for (const line of usageLimit) s.push(line);
  await settle();
  s.end();
  expect(await consumed).toMatchObject({ limit: null });
  expect(await a.done).toMatchObject({ error_code: 'USAGE_LIMIT' });
});
