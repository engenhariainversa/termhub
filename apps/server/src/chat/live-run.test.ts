import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STREAM_END_INPUT_LINE } from '@termhub/agent-protocol';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../db/repositories/chat.js';
import { chatBus, type ChatEvent } from './bus.js';
import { LiveRun, type LiveTurn } from './live-run.js';
import type { RunStream } from './service.js';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-background.ndjson'), 'utf8').split('\n').filter(Boolean);
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
    updateMessage: vi.fn(async (id: string, p: { text?: string; usage?: unknown; error_code?: string | null }) => {
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, p.text === undefined ? {} : { text: p.text }, p.error_code === undefined ? {} : { error_code: p.error_code });
      return { ...row };
    }),
    deleteMessage: vi.fn(async (id: string) => void rows.splice(rows.findIndex((r) => r.id === id), 1)),
    setCliSession: vi.fn(async () => undefined),
  };
  const live = new LiveRun({ userId: 'u1', conversationId: 'c1', sessionId, chat });
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
  return { live, chat, rows, events, off, turn };
}

/** A hand-driven stream: `push` a CLI line, `end()` the process; `written` is what the driver wrote. */
function manualStream() {
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const written: string[] = [];
  const stream: RunStream = {
    write: (line) => (ended ? false : (written.push(line), true)),
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
  const poke = () => { const w = wake; wake = null; w?.(); };
  return { stream, written, push: (l: string) => (queue.push(l), poke()), end: () => ((ended = true), poke()) };
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
  expect(await consumed).toEqual({ code: null, missingSession: false });

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
  s.push(background(0));
  await settle();
  expect(h.live.accepting).toBe(false);
  expect(s.written).toEqual([STREAM_END_INPUT_LINE]);
  expect(h.live.add((await h.turn(U2, 'tarde')).t)).toBe(false);
  s.end();
  await consumed;
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
  expect(await consumed).toEqual({ code: 'MISSING_SESSION', missingSession: true });
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
