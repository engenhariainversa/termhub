import { createHash } from 'node:crypto';
import { AI_MEMORY_RULE_PATH_RE } from '@termhub/machine-ops';
import { sanitisePromptText } from '../chat/tab-question-context.js';
import type { CurrentRule } from './current-rules.js';

/**
 * Current rules as pinned ai-memory pages (TER-1019, spec 2026-10-07 ai-memory rules): the pages termhub
 * wants in a checkout, and the diff against what it already wrote there. Pure: no I/O.
 *
 * The page texts are written to the machine for the agents to read in their session brief (pt-BR, like
 * the runs' prompts in `current-rules.ts`), not UI copy.
 */

/** At most this many rules become pages (the newest), so the brief stays near the spike's ~0.7k tokens. */
export const AI_MEMORY_RULES_MAX = 8;
/** A page's title (the rule's question) is cut past this. */
export const AI_MEMORY_TITLE_MAX = 80;
/** A page's decision text is cut past this. */
export const AI_MEMORY_DECISION_MAX = 300;
const SLUG_MAX = 40;

export interface RulePage {
  /** `_rules/termhub-<slug>-<note id>.md` */
  path: string;
  title: string;
  body: string;
  /** sha256 of title and body: an unchanged page is not written again. */
  hash: string;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/** Lowercase ASCII from the title: accents stripped, anything else a `-`, at most 40 chars, else `regra`. */
export function ruleSlug(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'regra';
}

export const pageHash = (title: string, body: string): string => createHash('sha256').update(`${title}\n${body}`).digest('hex');

/** The page of one rule, or null when its note id cannot be part of a path (never the case for termhub's ids). */
export function rulePage(rule: CurrentRule): RulePage | null {
  const id = rule.ref.startsWith('note:') ? rule.ref.slice('note:'.length) : rule.ref;
  const path = `_rules/termhub-${ruleSlug(rule.title)}-${id}.md`;
  if (!AI_MEMORY_RULE_PATH_RE.test(path)) return null;
  const title = clip(sanitisePromptText(rule.title), AI_MEMORY_TITLE_MAX) || 'Regra';
  const scope = rule.project_id ? '' : ' Vale para todos os projetos.';
  const decision = clip(sanitisePromptText(rule.decision), AI_MEMORY_DECISION_MAX);
  const body = `${decision}\n\nRegra vigente do termhub (${rule.ref}).${scope} Para mudar, use o termhub, não edite esta página.`;
  return { path, title, body, hash: pageHash(title, body) };
}

/** The pages for the current rules (newest first, as `currentRules` returns them), at most `AI_MEMORY_RULES_MAX`. */
export function rulePages(rules: CurrentRule[]): RulePage[] {
  const pages: RulePage[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (pages.length >= AI_MEMORY_RULES_MAX) break;
    const page = rulePage(r);
    if (!page || seen.has(page.path)) continue;
    seen.add(page.path);
    pages.push(page);
  }
  return pages;
}

export interface SyncPlan {
  writes: RulePage[];
  deletes: string[];
}

/** What to change in one checkout: write the wanted pages that are new or changed, delete the published ones no longer wanted. */
export function planSync(wanted: RulePage[], published: { path: string; hash: string }[]): SyncPlan {
  const have = new Map(published.map((p) => [p.path, p.hash]));
  const want = new Set(wanted.map((p) => p.path));
  return {
    writes: wanted.filter((p) => have.get(p.path) !== p.hash),
    deletes: published.filter((p) => !want.has(p.path)).map((p) => p.path),
  };
}
