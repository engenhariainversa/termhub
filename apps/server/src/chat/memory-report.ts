import type { ChatDecision, DecisionAnswer, DecisionNeighbour, ReplayDataset } from '../db/repositories/chat-decisions.js';
import { pickPrecedent } from './decision-memory.js';
import { mapAnswer, sameAnswer, type ItemAnswer } from './decision-text.js';

/**
 * The memory report (TER-1009, `docs/memory-report.md`): how well the decision memory would have
 * answered the questions the person actually answered (replay), and how often they answered the same
 * question again (repeats). Pure functions over `ChatDecisionsRepository.replayDataset`, which only
 * ever holds one user's rows — nothing here reads the database, the clock or the config.
 */

export type ReplayOutcome = 'hit' | 'miss' | 'no_precedent';
export type ReportPeriod = 'week' | 'month';

/** Thresholds the replay is also run at, so a limit can be tuned from data (TER-642). */
export const CURVE_THRESHOLDS = [0.85, 0.9, 0.92, 0.94, 0.96, 0.98, 0.99];

export interface ReplayCounts {
  /** Decisions replayed. */
  total: number;
  hit: number;
  miss: number;
  no_precedent: number;
  /** `hit / (hit + miss)`: how often a suggestion would have been right. `null` with no suggestion. */
  hit_rate: number | null;
  /** `(hit + miss) / total`: how often the memory would have suggested anything at all. */
  coverage: number | null;
}

/** One replayed question the memory would have answered wrong: what was asked, what the person
 *  answered, and which past decision suggested what. */
export interface ReplayMiss {
  decision_id: string;
  question: string;
  project_name: string | null;
  answered_at: string;
  answer: DecisionAnswer;
  suggested: DecisionAnswer;
  precedent: { decision_id: string; question: string; answered_at: string; similarity: number };
}

export interface RepeatCounts {
  /** Decisions measured. */
  answers: number;
  /** Answers to a question equivalent to an earlier one of the same scope. */
  repeated: number;
  /** Of those, the ones answered exactly as before (the memory could have spared the person). */
  same_answer: number;
  /** `repeated / answers`. */
  rate: number | null;
}

export interface MemoryReport {
  threshold: number;
  period: ReportPeriod;
  dataset: { decisions: number; unembedded: number; from: string | null; to: string | null };
  replay: ReplayCounts & { curve: (ReplayCounts & { threshold: number })[]; misses: ReplayMiss[] };
  repeats: RepeatCounts & {
    /** Distinct equivalent questions answered more than once. */
    questions: number;
    by_project: (RepeatCounts & { project_id: string | null; project_name: string | null; questions: number })[];
    by_period: (RepeatCounts & { period: string })[];
  };
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);

/** What the person answered, as indexes on the decision's own options. `mapAnswer` turns labels back
 *  into indexes (and drops free text next to labels, as a suggestion does); an answer it cannot map —
 *  only possible for a malformed row — is compared as its free text alone. */
function actualOf(d: ChatDecision): ItemAnswer {
  return mapAnswer(d.answer, d) ?? { selected: [], text: d.answer.text };
}

/** A mapped answer back into labels on `d`'s options, for display. */
function labelsOf(d: ChatDecision, a: ItemAnswer): DecisionAnswer {
  const labels = a.selected.map((i) => d.options[i]?.label ?? '');
  return a.text !== undefined ? { labels, text: a.text } : { labels };
}

function counts(outcomes: ReplayOutcome[]): ReplayCounts {
  const hit = outcomes.filter((o) => o === 'hit').length;
  const miss = outcomes.filter((o) => o === 'miss').length;
  return { total: outcomes.length, hit, miss, no_precedent: outcomes.length - hit - miss, hit_rate: ratio(hit, hit + miss), coverage: ratio(hit + miss, outcomes.length) };
}

/** Every decision of the dataset by id, the measured ones and the older neighbours alike. */
function byId(ds: ReplayDataset): Map<string, ChatDecision> {
  return new Map([...ds.older, ...ds.decisions].map((d) => [d.id, d]));
}

/** Pairs grouped by decision id, each list best (most similar) first. */
function groupPairs(pairs: ReplayDataset['replay'], all: Map<string, ChatDecision>): Map<string, DecisionNeighbour[]> {
  const out = new Map<string, DecisionNeighbour[]>();
  for (const p of pairs) {
    const n = all.get(p.neighbour_id);
    if (!n) continue;
    const list = out.get(p.id) ?? [];
    list.push({ ...n, similarity: p.similarity });
    out.set(p.id, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.similarity - a.similarity);
  return out;
}

/**
 * Replays one decision against the memory as it stood right before it (its earlier neighbours), with
 * the cards' own rule (`pickPrecedent`): `hit` when the suggestion equals what the person answered,
 * `miss` when it differs, `no_precedent` when nothing earlier was close enough or mapped onto the
 * question's options.
 */
export function replayOne(d: ChatDecision, near: DecisionNeighbour[], threshold: number): { outcome: ReplayOutcome; precedent?: DecisionNeighbour; suggested?: ItemAnswer } {
  const picked = pickPrecedent(near, d, threshold);
  if (!picked) return { outcome: 'no_precedent' };
  return { outcome: sameAnswer(picked.mapped, actualOf(d)) ? 'hit' : 'miss', precedent: picked.decision, suggested: picked.mapped };
}

/** UTC bucket of an ISO date: `YYYY-MM` for a month, the Monday `YYYY-MM-DD` for a week. */
export function periodOf(iso: string, period: ReportPeriod): string {
  if (period === 'month') return iso.slice(0, 7);
  const day = new Date(iso.slice(0, 10) + 'T00:00:00.000Z');
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function repeatCounts(answers: number, repeated: number, same: number): RepeatCounts {
  return { answers, repeated, same_answer: same, rate: ratio(repeated, answers) };
}

/** Union-find over repeat edges: how many groups of two or more equivalent questions, optionally only
 *  those whose decisions belong to `keep`. */
function groupCount(edges: [string, string][], keep?: (id: string) => boolean): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of edges) {
    if (keep && !keep(a)) continue;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  return new Set([...parent.keys()].map(find)).size;
}

/**
 * The whole report for one user's dataset. `threshold` is both the replay's suggestion limit and the
 * similarity at which two questions of the same scope count as the same question; `maxMisses` caps
 * the miss cases listed (newest first), never the counts.
 */
export function memoryReport(ds: ReplayDataset, opts: { threshold: number; period: ReportPeriod; maxMisses: number }): MemoryReport {
  const all = byId(ds);
  const replayNear = groupPairs(ds.replay, all);
  const scopeNear = groupPairs(ds.scope, all);

  const results = ds.decisions.map((d) => ({ d, ...replayOne(d, replayNear.get(d.id) ?? [], opts.threshold) }));
  const misses: ReplayMiss[] = results
    .filter((r) => r.outcome === 'miss')
    .reverse()
    .slice(0, opts.maxMisses)
    .map(({ d, precedent, suggested }) => ({
      decision_id: d.id,
      question: d.question,
      project_name: d.project_name,
      answered_at: d.created_at,
      answer: d.answer,
      suggested: labelsOf(d, suggested!),
      precedent: { decision_id: precedent!.id, question: precedent!.question, answered_at: precedent!.created_at, similarity: precedent!.similarity },
    }));
  const curve = CURVE_THRESHOLDS.map((t) => ({ threshold: t, ...counts(ds.decisions.map((d) => replayOne(d, replayNear.get(d.id) ?? [], t).outcome)) }));

  // Repeats: a decision whose nearest earlier question of the same scope is at or above the threshold.
  const edges: [string, string][] = [];
  const repeats = new Map<string, { same: boolean }>();
  for (const d of ds.decisions) {
    const prev = scopeNear.get(d.id)?.[0];
    if (!prev || prev.similarity < opts.threshold) continue;
    const mapped = mapAnswer(prev.answer, d);
    repeats.set(d.id, { same: mapped !== null && sameAnswer(mapped, actualOf(d)) });
    edges.push([d.id, prev.id]);
  }
  const tally = (ds2: ChatDecision[]) => {
    const rep = ds2.filter((d) => repeats.has(d.id));
    return repeatCounts(ds2.length, rep.length, rep.filter((d) => repeats.get(d.id)!.same).length);
  };
  const groupBy = (key: (d: ChatDecision) => string) => {
    const m = new Map<string, ChatDecision[]>();
    for (const d of ds.decisions) m.set(key(d), [...(m.get(key(d)) ?? []), d]);
    return m;
  };

  const by_project = [...groupBy((d) => d.project_id ?? '').values()]
    .map((list) => {
      const ids = new Set(list.map((d) => d.id));
      return { project_id: list[0]!.project_id, project_name: list[0]!.project_name, ...tally(list), questions: groupCount(edges, (id) => ids.has(id)) };
    })
    .sort((a, b) => b.repeated - a.repeated || b.answers - a.answers);
  const by_period = [...groupBy((d) => periodOf(d.created_at, opts.period)).entries()].map(([period, list]) => ({ period, ...tally(list) })).sort((a, b) => a.period.localeCompare(b.period));

  return {
    threshold: opts.threshold,
    period: opts.period,
    dataset: { decisions: ds.decisions.length, unembedded: ds.unembedded, from: ds.decisions[0]?.created_at ?? null, to: ds.decisions.at(-1)?.created_at ?? null },
    replay: { ...counts(results.map((r) => r.outcome)), curve, misses },
    repeats: { ...tally(ds.decisions), questions: groupCount(edges), by_project, by_period },
  };
}
