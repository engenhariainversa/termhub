import { sanitisePromptText } from '../chat/tab-question-context.js';
import type { MemoryItem } from '../db/repositories/memory-items.js';
import type { Repositories } from '../db/repositories/index.js';

/**
 * The current rules of a project (TER-1011): the decisions the concierge recorded for it or for the whole
 * account (`record_decision` notes) that nobody marked wrong, superseded or outdated, and that have not
 * expired (`MemoryItemsRepository.currentNotes`). They go into the automatic runs' first prompt, the wake
 * messages and the concierge's system prompt, so the agents act on what holds now rather than on older,
 * contradictory notes they would otherwise find in the memory.
 */
export interface CurrentRule {
  /** `note:<id>`, the ref `search_memory` and the Memória screen use. */
  ref: string;
  /** The question the decision answers. */
  title: string;
  /** The decision itself, the note's `Decisão:` line. */
  decision: string;
  /** Null for an account-wide rule. */
  project_id: string | null;
}

/** At most this many rules are read; the block keeps the newest that fit in `RULES_MAX`. */
export const RULES_LIMIT = 20;
/** The most the rules block takes of a prompt (a run's prompt is capped by `PROMPT_MAX_CHARS`). */
export const RULES_MAX = 1200;
/** One rule's line is cut past this. */
const RULE_MAX = 240;

/** The note's `Decisão:` line (`indexNote` writes `Decisão: …\nMotivo: …\nFontes: …`), or its whole text. */
function decisionOf(text: string): string {
  const m = /^Decisão:\s*(.*)$/m.exec(text);
  return (m?.[1] ?? text).trim();
}

export function ruleOf(item: Pick<MemoryItem, 'id' | 'title' | 'text' | 'project_id'>): CurrentRule {
  return { ref: `note:${item.id}`, title: item.title, decision: decisionOf(item.text), project_id: item.project_id };
}

/** The owner's current rules for the project, newest first. Never throws: a failed read is no rules. */
export async function currentRules(repos: Pick<Repositories, 'memoryItems'>, ownerId: string | null, projectId: string): Promise<CurrentRule[]> {
  if (!ownerId) return [];
  try {
    return (await repos.memoryItems.currentNotes(ownerId, projectId, RULES_LIMIT)).map(ruleOf);
  } catch {
    return [];
  }
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);

/** One rule as a prompt line: the person's words, sanitised and quoted like the wake's question. */
function ruleLine(r: CurrentRule): string {
  const scope = r.project_id ? '' : ' (todos os projetos)';
  return clip(`- [${r.ref}]${scope} «${sanitisePromptText(r.title)}»: «${sanitisePromptText(r.decision)}»`, RULE_MAX);
}

/**
 * The rules block of a prompt (pt-BR, like the rest of the runs' prompts), or null when there is none.
 * Newest first; a rule that does not fit in `max` is left out whole, with a closing line saying so.
 */
export function rulesBlock(rules: CurrentRule[], max = RULES_MAX): string | null {
  if (rules.length === 0) return null;
  const head = 'Regras vigentes do projeto (decisões do dono que valem agora; substituídas e expiradas já ficaram de fora — prevalecem sobre notas antigas da memória):';
  const more = '- … (outras em search_memory)';
  let body = head;
  let dropped = false;
  for (const r of rules) {
    const line = ruleLine(r);
    if (body.length + 1 + line.length + 1 + more.length > max) {
      dropped = true;
      continue;
    }
    body = `${body}\n${line}`;
  }
  if (body === head) return null;
  return dropped ? `${body}\n${more}` : body;
}

/** `rulesBlock` of the owner's current rules for the project: what the prompts and the wakes add. */
export async function currentRulesBlock(repos: Pick<Repositories, 'memoryItems'>, ownerId: string | null, projectId: string, max = RULES_MAX): Promise<string | null> {
  return rulesBlock(await currentRules(repos, ownerId, projectId), max);
}
