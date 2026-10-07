import { describe, expect, it } from 'vitest';
import type { ChatDecision, DecisionPair, ReplayDataset } from '../db/repositories/chat-decisions.js';
import { CURVE_THRESHOLDS, memoryReport, periodOf, replayOne } from './memory-report.js';

const yesNo = [
  { label: 'Sim', description: '' },
  { label: 'Não', description: '' },
];

let seq = 0;
function decision(over: Partial<ChatDecision> = {}): ChatDecision {
  seq += 1;
  return {
    id: `d${seq}`,
    user_id: 'u1',
    project_id: 'p1',
    project_name: 'Proj',
    conversation_id: 'c1',
    tab_question_id: `q${seq}`,
    question_index: 0,
    header: 'H',
    question: `Pergunta ${seq}?`,
    options: yesNo,
    multi_select: false,
    answer: { labels: ['Sim'] },
    embed_model: 'm#q1',
    suggested_count: 0,
    accepted_count: 0,
    auto_count: 0,
    created_at: `2026-09-${String(seq).padStart(2, '0')}T12:00:00.000Z`,
    ...over,
  };
}

const pair = (id: string, neighbour_id: string, similarity: number): DecisionPair => ({ id, neighbour_id, similarity });
const dataset = (decisions: ChatDecision[], replay: DecisionPair[], scope: DecisionPair[] = replay, older: ChatDecision[] = []): ReplayDataset => ({ decisions, older, replay, scope, unembedded: 0 });

describe('replayOne', () => {
  it('is a hit when the precedent maps to the same answer', () => {
    const past = decision();
    const now = decision();
    expect(replayOne(now, [{ ...past, similarity: 0.99 }], 0.98).outcome).toBe('hit');
  });

  it('is a miss when the precedent answered differently', () => {
    const past = decision({ answer: { labels: ['Não'] } });
    const now = decision();
    const r = replayOne(now, [{ ...past, similarity: 0.99 }], 0.98);
    expect(r.outcome).toBe('miss');
    expect(r.suggested).toEqual({ selected: [1] });
  });

  it('has no precedent below the threshold or when the labels no longer exist', () => {
    const past = decision();
    const other = decision({ answer: { labels: ['Talvez'] }, options: [{ label: 'Talvez', description: '' }] });
    const now = decision();
    expect(replayOne(now, [{ ...past, similarity: 0.97 }], 0.98).outcome).toBe('no_precedent');
    expect(replayOne(now, [{ ...other, similarity: 0.99 }], 0.98).outcome).toBe('no_precedent');
    expect(replayOne(now, [], 0.98).outcome).toBe('no_precedent');
  });

  it('prefers the newest precedent over the most similar, like the cards', () => {
    const old = decision({ answer: { labels: ['Não'] } });
    const fresh = decision();
    const now = decision();
    const r = replayOne(now, [{ ...old, similarity: 0.999 }, { ...fresh, similarity: 0.985 }], 0.98);
    expect(r.outcome).toBe('hit');
    expect(r.precedent?.id).toBe(fresh.id);
  });

  it('compares free-text answers trimmed', () => {
    const past = decision({ answer: { labels: [], text: 'use a fila ' } });
    const now = decision({ answer: { labels: [], text: 'use a fila' } });
    expect(replayOne(now, [{ ...past, similarity: 1 }], 0.98).outcome).toBe('hit');
  });
});

describe('periodOf', () => {
  it('buckets by UTC month and by ISO week (Monday)', () => {
    expect(periodOf('2026-10-07T23:00:00.000Z', 'month')).toBe('2026-10');
    expect(periodOf('2026-10-07T23:00:00.000Z', 'week')).toBe('2026-10-05'); // a Wednesday
    expect(periodOf('2026-10-11T08:00:00.000Z', 'week')).toBe('2026-10-05'); // the Sunday after
    expect(periodOf('2026-10-12T00:00:00.000Z', 'week')).toBe('2026-10-12'); // the next Monday
  });
});

describe('memoryReport', () => {
  it('counts hits, misses and questions with no precedent, and lists the misses newest first', () => {
    const a = decision({ question: 'Fazer merge?' });
    const b = decision({ question: 'Fazer merge agora?' }); // hit on a
    const c = decision({ question: 'Fazer o merge?', answer: { labels: ['Não'] } }); // miss: newest precedent b says Sim
    const d = decision({ question: 'Outra coisa?' }); // no precedent
    const e = decision({ question: 'Merge?', answer: { labels: ['Não'] } }); // miss at 0.985, hit on c? c is a Não → hit
    const ds = dataset([a, b, c, d, e], [pair(b.id, a.id, 0.99), pair(c.id, a.id, 0.99), pair(c.id, b.id, 0.985), pair(d.id, a.id, 0.5), pair(e.id, c.id, 0.99), pair(e.id, a.id, 0.97)]);
    const r = memoryReport(ds, { threshold: 0.98, period: 'month', maxMisses: 10 });
    expect(r.replay).toMatchObject({ total: 5, hit: 2, miss: 1, no_precedent: 2, hit_rate: 0.667, coverage: 0.6 });
    expect(r.replay.misses).toEqual([
      {
        decision_id: c.id,
        question: 'Fazer o merge?',
        project_name: 'Proj',
        answered_at: c.created_at,
        answer: { labels: ['Não'] },
        suggested: { labels: ['Sim'] },
        precedent: { decision_id: b.id, question: 'Fazer merge agora?', answered_at: b.created_at, similarity: 0.985 },
      },
    ]);
    expect(r.dataset).toEqual({ decisions: 5, unembedded: 0, from: a.created_at, to: e.created_at });
  });

  it('caps the miss list but never the counts', () => {
    const base = decision({ answer: { labels: ['Não'] } });
    const later = [decision(), decision(), decision()];
    const r = memoryReport(dataset([base, ...later], later.map((d) => pair(d.id, base.id, 0.99))), { threshold: 0.98, period: 'month', maxMisses: 2 });
    expect(r.replay.miss).toBe(3);
    expect(r.replay.misses.map((m) => m.decision_id)).toEqual([later[2]!.id, later[1]!.id]);
  });

  it('runs the replay at every curve threshold', () => {
    const a = decision();
    const b = decision();
    const r = memoryReport(dataset([a, b], [pair(b.id, a.id, 0.93)]), { threshold: 0.98, period: 'month', maxMisses: 10 });
    expect(r.replay.curve.map((c) => c.threshold)).toEqual(CURVE_THRESHOLDS);
    expect(r.replay.curve.find((c) => c.threshold === 0.92)).toMatchObject({ hit: 1, no_precedent: 1 });
    expect(r.replay.curve.find((c) => c.threshold === 0.94)).toMatchObject({ hit: 0, no_precedent: 2 });
  });

  it('counts repeated questions within the same scope, split by same or changed answer', () => {
    const a = decision({ created_at: '2026-09-01T10:00:00.000Z' });
    const b = decision({ created_at: '2026-09-20T10:00:00.000Z' }); // repeats a, same answer
    const c = decision({ created_at: '2026-10-02T10:00:00.000Z', answer: { labels: ['Não'] } }); // repeats b, changed answer
    const d = decision({ created_at: '2026-10-03T10:00:00.000Z' }); // unrelated
    const x = decision({ project_id: 'p2', project_name: 'Outro', created_at: '2026-10-04T10:00:00.000Z' });
    const y = decision({ project_id: 'p2', project_name: 'Outro', created_at: '2026-10-05T10:00:00.000Z' }); // repeats x
    const scope = [pair(b.id, a.id, 0.99), pair(c.id, b.id, 0.985), pair(d.id, a.id, 0.4), pair(y.id, x.id, 0.995)];
    const r = memoryReport(dataset([a, b, c, d, x, y], [], scope), { threshold: 0.98, period: 'month', maxMisses: 10 });
    expect(r.repeats).toMatchObject({ answers: 6, repeated: 3, same_answer: 2, rate: 0.5, questions: 2 });
    expect(r.repeats.by_project).toEqual([
      { project_id: 'p1', project_name: 'Proj', answers: 4, repeated: 2, same_answer: 1, rate: 0.5, questions: 1 },
      { project_id: 'p2', project_name: 'Outro', answers: 2, repeated: 1, same_answer: 1, rate: 0.5, questions: 1 },
    ]);
    expect(r.repeats.by_period).toEqual([
      { period: '2026-09', answers: 2, repeated: 1, same_answer: 1, rate: 0.5 },
      { period: '2026-10', answers: 4, repeated: 2, same_answer: 1, rate: 0.5 },
    ]);
  });

  it('resolves neighbours that fell outside the window, and answers nulls on an empty dataset', () => {
    const old = decision();
    const now = decision();
    const r = memoryReport(dataset([now], [pair(now.id, old.id, 0.99)], [pair(now.id, old.id, 0.99)], [old]), { threshold: 0.98, period: 'week', maxMisses: 10 });
    expect(r.replay).toMatchObject({ total: 1, hit: 1 });
    expect(r.repeats).toMatchObject({ repeated: 1, questions: 1 });

    const empty = memoryReport(dataset([], []), { threshold: 0.98, period: 'month', maxMisses: 10 });
    expect(empty.replay).toMatchObject({ total: 0, hit_rate: null, coverage: null });
    expect(empty.repeats).toMatchObject({ answers: 0, rate: null, questions: 0, by_project: [], by_period: [] });
    expect(empty.dataset).toEqual({ decisions: 0, unembedded: 0, from: null, to: null });
  });
});
