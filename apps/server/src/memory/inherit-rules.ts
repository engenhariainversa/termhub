import type { Repositories } from '../db/repositories/index.js';
import type { Project } from '../db/repositories/types.js';
import { RULES_LIMIT, ruleOf } from './current-rules.js';
import { noteItem } from './index-items.js';

/**
 * "Herdar regras de" (TER-1169): a project being created takes, as its own notes, the current rules of
 * another project of the same owner — those scoped to that project only; the account-wide ones already
 * hold everywhere. Each copy is an ordinary note of the new project (scope `project`), citing the rule it
 * came from, so the person can mark it wrong or replace it on the Memória screen without touching the
 * original. Returns how many were copied. Never reads another owner's notes: `currentNotes` is held to
 * `ownerId`, and the caller has already resolved `from` within the person's scope.
 */
export async function inheritRules(repos: Pick<Repositories, 'memoryItems'>, ownerId: string, from: Pick<Project, 'id' | 'name'>, to: Pick<Project, 'id'>): Promise<number> {
  if (from.id === to.id) return 0;
  const notes = await repos.memoryItems.currentNotes(ownerId, from.id, RULES_LIMIT);
  const own = notes.filter((n) => n.project_id === from.id && n.scope === 'project');
  if (own.length === 0) return 0;
  // oldest first, so the copies keep the original order (newest first) when listed by creation time
  const items = own.reverse().map((n) => {
    const rule = ruleOf(n);
    return noteItem({
      owner_id: ownerId,
      project_id: to.id,
      question: rule.title,
      decision: rule.decision,
      reason: `Herdada do projeto ${from.name} ao criar este projeto.`,
      sources: [rule.ref],
      scope: 'project',
      written_by: 'person',
    });
  });
  await repos.memoryItems.upsertMany(items);
  return items.length;
}
