import { createHash } from 'node:crypto';
import { AUTONOMY_LEVELS, type AutonomyLevel } from '../setup/schema.js';

/**
 * Current rules (regras vigentes, TER-1010): which decisions and concierge notes say the same thing,
 * and what the person is offered to approve because of it. Pure — the repository hands in the sources,
 * the similar pairs pgvector found and the rows already decided; nothing here reads or writes the
 * database, and nothing here applies anything: every result is only a proposal.
 */

/** A proposal the person rejected does not come back for this long (TER-1010). */
export const REJECTION_DAYS = 180;
const REJECTION_MS = REJECTION_DAYS * 24 * 60 * 60 * 1000;
/** Word overlap (Jaccard) at which two statements count as the same, when no embedding pair says so. */
export const LEXICAL_THRESHOLD = 0.6;

export type RuleKind = 'rule' | 'policy';
export type RuleStatus = 'proposed' | 'awaiting_confirmation' | 'approved' | 'rejected';

/** One current decision or note, as consolidation reads it. `statement` is what it decided. */
export interface RuleSource {
  /** `note:<id>` or `decision:<id>` (memory/refs.ts). */
  ref: string;
  project_id: string | null;
  title: string;
  statement: string;
  created_at: string;
}

/** What a `policy` proposal changes, and on which projects. `applied` lists the projects whose
 *  `set_automation_policy` card was approved and applied. */
export interface RulePolicy {
  autonomy?: AutonomyLevel;
  max_parallel?: number;
  project_ids: string[];
  applied?: string[];
}

/** A `memory_rules` row, as consolidation needs it. */
export interface ExistingRule {
  id: string;
  kind: RuleKind;
  status: RuleStatus;
  project_id: string | null;
  source_refs: string[];
  fingerprint: string;
  note_id: string | null;
  decided_at: string | null;
}

/** The automation Setup fields a policy proposal can widen, per project. */
export interface ProjectPolicy {
  autonomy: AutonomyLevel;
  max_parallel: number | null;
}

export interface RuleCandidate {
  kind: RuleKind;
  /** Null = a rule at the user level. */
  project_id: string | null;
  text: string;
  policy: RulePolicy | null;
  source_refs: string[];
  fingerprint: string;
}

/** Lowercase, no accents, so the patterns below need no accented variants. */
export const normalize = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const PERMIT = /\b(sim|pode|podem|posso|liberad\w*|liber[ae]\w*|permit\w*|autoriz\w*|sem (parar para |precisar )?(perguntar|pedir|confirma\w*))\b/;
/** "não precisa perguntar" grants, it does not deny: removed before the negation check. */
const NOT_NEEDED = /\bnao precisa (de )?(perguntar|pedir|confirma\w*)\b/;
const NOT_NEEDED_ALL = new RegExp(NOT_NEEDED.source, 'g');
const NEGATION = /\b(nao|nunca|jamais|proibid\w*|bloquead\w*)\b/;
const AUTONOMY_TERMS: [AutonomyLevel, RegExp][] = [
  ['release', /\b(release\w*|publica\w*|npm|ota)\b/],
  ['deploy', /\bdeploy\w*\b/],
  ['merge', /\b(merge\w*|mescla\w*|mergea\w*)\b/],
];
const PARALLEL = [/\b(\d{1,2})\s+(?:\S+\s+){0,3}?(?:em )?paralel\w*/, /\bparalel\w*\D{0,20}?\b(\d{1,2})\b/];

/** A statement's clauses: sentences and lines. A negation only ever spoils its own clause. */
const clausesOf = (statement: string): string[] =>
  normalize(statement)
    .split(/[.;\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);

const grants = (clause: string): boolean => (PERMIT.test(clause) || NOT_NEEDED.test(clause)) && !NEGATION.test(clause.replace(NOT_NEEDED_ALL, ''));

/** Whether the statement grants something: one clause that permits, with no negation in it. */
export function isPermission(statement: string): boolean {
  return clausesOf(statement).some(grants);
}

/**
 * The automatic-work Setup a permission asks for: the highest level its granting clauses name (merge,
 * deploy, release/publish) and the number next to "paralelo". Null when it names neither — or when the
 * statement grants nothing ("nunca mesclar sozinho" is not a merge permission).
 */
export function autonomyOf(statement: string): { autonomy?: AutonomyLevel; max_parallel?: number } | null {
  const granting = clausesOf(statement).filter(grants);
  let autonomy: AutonomyLevel | undefined;
  let parallel: number | undefined;
  for (const clause of granting) {
    for (const [level, re] of AUTONOMY_TERMS) {
      if (re.test(clause) && (!autonomy || AUTONOMY_LEVELS.indexOf(level) > AUTONOMY_LEVELS.indexOf(autonomy))) autonomy = level;
    }
    for (const re of PARALLEL) {
      const n = Number(re.exec(clause)?.[1]);
      if (n > 0 && (parallel === undefined || n > parallel)) parallel = n;
    }
  }
  if (!autonomy && parallel === undefined) return null;
  return { ...(autonomy ? { autonomy } : {}), ...(parallel !== undefined ? { max_parallel: parallel } : {}) };
}

const STOPWORDS = new Set(
  'a o as os de do da dos das e em no na nos nas um uma uns umas que para por com sem se ao aos ou mas como sim nao isso esse essa este esta ja so tambem mais quando sempre todo toda todos todas cada pelo pela pelos pelas the and of to'.split(' '),
);

/** The words that carry meaning: no card refs (`TER-123`), numbers, stopwords or 1–2 letter words. */
export function tokensOf(s: string): Set<string> {
  const words = normalize(s)
    .replace(/\b[a-z]{2,10}-\d+\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
  return new Set(words);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** sha256 of what makes a proposal the same proposal: kind, scope, policy change and sources. */
export function fingerprintOf(c: Pick<RuleCandidate, 'kind' | 'project_id' | 'policy' | 'source_refs'>): string {
  const policy = c.policy ? [c.policy.autonomy ?? null, c.policy.max_parallel ?? null, [...c.policy.project_ids].sort()] : null;
  return createHash('sha256')
    .update(JSON.stringify([c.kind, c.project_id ?? 'user', policy, [...c.source_refs].sort()]))
    .digest('hex');
}

/** Every ref an approved rule, or a policy waiting for its cards, already stands for. */
export function coveredRefs(rules: ExistingRule[]): Set<string> {
  const out = new Set<string>();
  for (const r of rules) {
    if (r.status !== 'approved' && r.status !== 'awaiting_confirmation') continue;
    for (const ref of r.source_refs) out.add(ref);
    if (r.note_id) out.add(`note:${r.note_id}`);
  }
  return out;
}

/**
 * A rejection holds (180 days) against a candidate of the same kind and scope when more than half of the
 * candidate's sources were in the rejected proposal: one new note joining the group does not bring a
 * rejected proposal back, a group that is mostly new does.
 */
export function isSuppressed(c: Pick<RuleCandidate, 'kind' | 'project_id' | 'source_refs'>, rules: ExistingRule[], now: Date): boolean {
  return rules.some((r) => {
    if (r.status !== 'rejected' || r.kind !== c.kind || r.project_id !== c.project_id) return false;
    if (!r.decided_at || now.getTime() - new Date(r.decided_at).getTime() >= REJECTION_MS) return false;
    const rejected = new Set(r.source_refs);
    const shared = c.source_refs.filter((ref) => rejected.has(ref)).length;
    return shared * 2 > c.source_refs.length;
  });
}

/** Union-find over refs. */
function clusters(refs: string[], pairs: [string, string][]): string[][] {
  const parent = new Map(refs.map((r) => [r, r]));
  const find = (r: string): string => {
    let p = parent.get(r)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(r, p);
    return p;
  };
  for (const [a, b] of pairs) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const r of refs) {
    const root = find(r);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }
  return [...groups.values()];
}

const levelRank = (a: AutonomyLevel | undefined) => (a ? AUTONOMY_LEVELS.indexOf(a) : -1);
const parallelRank = (n: number | null | undefined) => (n === null ? Number.POSITIVE_INFINITY : (n ?? -1));

/**
 * The proposals for the person, from the current sources:
 * - sources an approved rule (or a policy awaiting its cards) stands for are left out;
 * - sources join a group when pgvector paired them (`pairs`) or their words overlap enough;
 * - a group whose permission asks for more automatic work than a project's Setup allows becomes one
 *   `policy` proposal for those projects (never applied here: approving it asks `set_automation_policy`);
 * - otherwise a permission present in two or more projects becomes one rule at the user level, and two or
 *   more sources of one scope (a project, or the user) become one rule of that scope;
 * - a proposal rejected less than 180 days ago does not come back (`isSuppressed`).
 * The rule's text is the newest source's statement (the newest granting one, for a permission).
 */
export function consolidate(input: {
  sources: RuleSource[];
  pairs: [string, string][];
  rules: ExistingRule[];
  policies: Map<string, ProjectPolicy>;
  now: Date;
}): RuleCandidate[] {
  const covered = coveredRefs(input.rules);
  const sources = input.sources.filter((s) => !covered.has(s.ref));
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const tokens = new Map(sources.map((s) => [s.ref, tokensOf(`${s.title} ${s.statement}`)]));
  const pairs: [string, string][] = [...input.pairs];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i]!;
      const b = sources[j]!;
      if (jaccard(tokens.get(a.ref)!, tokens.get(b.ref)!) >= LEXICAL_THRESHOLD) pairs.push([a.ref, b.ref]);
    }
  }

  const out: RuleCandidate[] = [];
  const push = (c: Omit<RuleCandidate, 'fingerprint'>) => {
    const candidate = { ...c, source_refs: [...c.source_refs].sort() };
    if (isSuppressed(candidate, input.rules, input.now)) return;
    out.push({ ...candidate, fingerprint: fingerprintOf(candidate) });
  };
  const newestFirst = (a: RuleSource, b: RuleSource) => b.created_at.localeCompare(a.created_at) || a.ref.localeCompare(b.ref);

  for (const refs of clusters([...byRef.keys()], pairs)) {
    const items = refs.map((r) => byRef.get(r)!).sort(newestFirst);
    const permits = items.filter((s) => isPermission(s.statement));
    const projects = [...new Set(items.map((s) => s.project_id).filter((p): p is string => p !== null))].sort();

    // Autonomy: the widest level and parallelism any granting source asks for.
    let autonomy: AutonomyLevel | undefined;
    let parallel: number | undefined;
    for (const s of permits) {
      const a = autonomyOf(s.statement);
      if (a?.autonomy && levelRank(a.autonomy) > levelRank(autonomy)) autonomy = a.autonomy;
      if (a?.max_parallel !== undefined && a.max_parallel > (parallel ?? 0)) parallel = a.max_parallel;
    }
    if (autonomy || parallel !== undefined) {
      const widens = projects.filter((p) => {
        const current = input.policies.get(p);
        if (!current) return false;
        return levelRank(autonomy) > levelRank(current.autonomy) || (parallel !== undefined && parallel > parallelRank(current.max_parallel));
      });
      if (widens.length > 0) {
        push({
          kind: 'policy',
          project_id: widens.length === 1 ? widens[0]! : null,
          text: permits[0]!.statement,
          policy: { ...(autonomy ? { autonomy } : {}), ...(parallel !== undefined ? { max_parallel: parallel } : {}), project_ids: widens },
          source_refs: refs,
        });
        continue;
      }
    }

    if (permits.length > 0 && projects.length >= 2) {
      push({ kind: 'rule', project_id: null, text: permits[0]!.statement, policy: null, source_refs: refs });
      continue;
    }
    // Same scope, two or more sources: one rule per scope.
    const byScope = new Map<string | null, RuleSource[]>();
    for (const s of items) byScope.set(s.project_id, [...(byScope.get(s.project_id) ?? []), s]);
    for (const [scope, group] of byScope) {
      if (group.length < 2) continue;
      push({ kind: 'rule', project_id: scope, text: group[0]!.statement, policy: null, source_refs: group.map((s) => s.ref) });
    }
  }
  return out;
}
