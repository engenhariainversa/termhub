import type { FastifyBaseLogger } from 'fastify';
import { chatBus } from '../chat/bus.js';
import { askForAutomation } from '../chat/gate-runtime.js';
import { controlContextFor } from '../control/context.js';
import { setAutomationPolicy } from '../automation/setup-tools.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { MemoryRule, RuleSourceRow } from '../db/repositories/memory-rules.js';
import type { Embedder } from '../chat/embeddings.js';
import { HttpError, notFound } from '../lib/errors.js';
import { msg } from '../i18n/index.js';
import { indexNote } from './index-items.js';
import { consolidate, type ProjectPolicy, type RulePolicy, type RuleSource } from './rules.js';

/**
 * Current rules (regras vigentes, TER-1010) against the database: consolidation run when the Memória
 * screen asks for the rules, and what approving or rejecting a proposal does. Opt-in throughout — a
 * proposal changes nothing until the person approves it, and a `policy` proposal changes the Setup only
 * through `set_automation_policy` cards the person approves too.
 */

export type RulesDeps = { embedder: Embedder | null; log: Pick<FastifyBaseLogger, 'info' | 'warn'>; threshold: number; now?: Date };

/** The tool of the cards a policy proposal asks: the same card the concierge's call shows. */
export const POLICY_TOOL = 'set_automation_policy';
const KEY_PREFIX = 'memory_rule:';
export const policyCardKey = (ruleId: string, projectId: string) => `${KEY_PREFIX}${ruleId}:${projectId}`;
function parseKey(key: string | null): { ruleId: string; projectId: string } | null {
  if (!key?.startsWith(KEY_PREFIX)) return null;
  const [ruleId, projectId] = key.slice(KEY_PREFIX.length).split(':');
  return ruleId && projectId ? { ruleId, projectId } : null;
}

/** What a source decided, in one line: a note's "Decisão:" line, or a decision's question and answer. */
export function statementOf(row: Pick<RuleSourceRow, 'ref' | 'text' | 'answer'>): string {
  if (row.ref.startsWith('note:')) {
    const line = row.text.split('\n').find((l) => l.startsWith('Decisão: '));
    return (line ? line.slice('Decisão: '.length) : row.text).trim();
  }
  const answer = (row.answer ?? {}) as { labels?: unknown; text?: unknown };
  const labels = Array.isArray(answer.labels) ? answer.labels.filter((l): l is string => typeof l === 'string') : [];
  const text = typeof answer.text === 'string' ? answer.text.trim() : '';
  const said = [labels.join(', '), text].filter(Boolean).join(' — ');
  return said ? `${row.text.trim()} → ${said}` : row.text.trim();
}

/** The policy fields a card asks to change. */
const policyArgs = (policy: RulePolicy, projectId: string): Record<string, unknown> => ({
  project_id: projectId,
  ...(policy.autonomy ? { autonomy: policy.autonomy } : {}),
  ...(policy.max_parallel !== undefined ? { max_parallel: policy.max_parallel } : {}),
});

/** The project, only when it is still the owner's. */
async function ownedProject(repos: Repositories, ownerId: string, projectId: string) {
  const project = await repos.projects.findById(projectId);
  return project && project.owner_id === ownerId ? project : null;
}

/**
 * Consolidates the owner's current notes and decisions into proposals and stores them (`syncProposals`),
 * after settling policy proposals whose cards were decided. Answers every row, newest first, and the
 * sources by ref (for the screen to show where each rule came from).
 */
export async function refreshRules(repos: Repositories, ownerId: string, deps: RulesDeps): Promise<{ rules: MemoryRule[]; sources: Map<string, RuleSourceRow> }> {
  const now = deps.now ?? new Date();
  for (const rule of await repos.memoryRules.listForOwner(ownerId)) {
    if (rule.status === 'awaiting_confirmation') await settlePolicy(repos, rule, deps);
  }
  const rows = await repos.memoryRules.listSources(ownerId);
  const sources: RuleSource[] = rows.map((r) => ({ ref: r.ref, project_id: r.project_id, title: r.title, statement: statementOf(r), created_at: r.created_at }));
  let pairs: [string, string][] = [];
  if (deps.embedder) {
    try {
      pairs = await repos.memoryRules.similarPairs(ownerId, deps.threshold);
    } catch (err) {
      // best effort: without the pairs, word overlap alone groups the sources
      deps.log.warn({ code: err instanceof Error ? err.name : 'unknown' }, 'rules: similar pairs failed');
    }
  }
  const policies = new Map<string, ProjectPolicy>();
  for (const projectId of new Set(sources.map((s) => s.project_id).filter((p): p is string => p !== null))) {
    if (!(await ownedProject(repos, ownerId, projectId))) continue;
    const { autonomy, max_parallel } = (await repos.projectSetup.get(projectId)).data.automation;
    policies.set(projectId, { autonomy, max_parallel });
  }
  const rules = await repos.memoryRules.listForOwner(ownerId);
  const candidates = consolidate({ sources, pairs, rules, policies, now });
  await repos.memoryRules.syncProposals(ownerId, candidates);
  return { rules: await repos.memoryRules.listForOwner(ownerId), sources: new Map(rows.map((r) => [r.ref, r])) };
}

/**
 * "Aprovar". A `rule` becomes `approved` (with the text the person may have edited) and is indexed as a
 * note of theirs (trust `person`), so `search_memory` finds the rule where it used to find its sources. A
 * `policy` never changes the Setup here: it asks one `set_automation_policy` card per project still the
 * owner's and waits (`awaiting_confirmation`); only an approved card applies it (`applyPolicyCard`).
 */
export async function approveRule(repos: Repositories, ownerId: string, id: string, input: { text?: string }, deps: RulesDeps): Promise<MemoryRule> {
  const rule = await repos.memoryRules.findForOwner(id, ownerId);
  if (!rule) throw notFound();
  if (rule.status !== 'proposed') throw new HttpError(409, msg('Esta proposta já foi decidida'), 'RULE_DECIDED');
  if (rule.kind === 'rule') {
    const text = input.text?.trim() || rule.text;
    const note = await indexNote(
      repos,
      { owner_id: ownerId, project_id: rule.project_id, question: 'Regra vigente', decision: text, reason: 'Regra aprovada pela pessoa na tela Memória.', sources: rule.source_refs, trust: 'person' },
      deps,
    );
    const approved = await repos.memoryRules.decide(id, ownerId, ['proposed'], 'approved', ownerId, { text, note_id: note.id });
    if (!approved) {
      await repos.memoryItems.deleteNote(note.id, ownerId);
      throw new HttpError(409, msg('Esta proposta já foi decidida'), 'RULE_DECIDED');
    }
    return approved;
  }
  const policy = rule.policy;
  const projects: string[] = [];
  for (const projectId of policy?.project_ids ?? []) if (await ownedProject(repos, ownerId, projectId)) projects.push(projectId);
  if (!policy || projects.length === 0) throw new HttpError(409, msg('Nenhum projeto desta proposta continua seu'), 'RULE_NO_PROJECT');
  const waiting = await repos.memoryRules.decide(id, ownerId, ['proposed'], 'awaiting_confirmation', ownerId, { policy: { ...policy, project_ids: projects, applied: [] } });
  if (!waiting) throw new HttpError(409, msg('Esta proposta já foi decidida'), 'RULE_DECIDED');
  for (const projectId of projects) {
    await askForAutomation(repos, ownerId, projectId, { tool: POLICY_TOOL, args: policyArgs(policy, projectId), key: policyCardKey(id, projectId) });
  }
  return waiting;
}

/** "Recusar": stored with the time, so the same proposal stays away for 180 days. */
export async function rejectRule(repos: Repositories, ownerId: string, id: string): Promise<MemoryRule> {
  const rule = await repos.memoryRules.findForOwner(id, ownerId);
  if (!rule) throw notFound();
  const rejected = await repos.memoryRules.decide(id, ownerId, ['proposed'], 'rejected', ownerId);
  if (!rejected) throw new HttpError(409, msg('Esta proposta já foi decidida'), 'RULE_DECIDED');
  return rejected;
}

/** "Remover regra": the rule goes away, its note too, and its sources are current again. */
export async function removeRule(repos: Repositories, ownerId: string, id: string): Promise<void> {
  const removed = await repos.memoryRules.deleteApproved(id, ownerId);
  if (!removed) throw notFound();
  if (removed.note_id) await repos.memoryItems.deleteNote(removed.note_id, ownerId);
}

/**
 * The person approved a `set_automation_policy` card a policy proposal asked (the decision hook, and
 * `settlePolicy` for an approval a hook never acted on). Claimed first (`claimApproved`), so two hooks
 * or both colours apply it once; applied through `setAutomationPolicy` with the card as its approval.
 * A card the concierge proposed itself has no `memory_rule:` key and is left alone.
 */
export async function applyPolicyCard(repos: Repositories, action: ChatAction, deps: RulesDeps): Promise<void> {
  const key = parseKey(action.idempotency_key);
  if (!key || action.tool !== POLICY_TOOL || action.status !== 'approved') return;
  const rule = await repos.memoryRules.findById(key.ruleId);
  if (!rule?.policy || rule.status !== 'awaiting_confirmation') return;
  const owner = await repos.users.findById(rule.owner_id);
  if (!owner || !(await repos.memoryRules.findForOwner(rule.id, owner.id))) return;
  if (!(await repos.chatActions.claimApproved(action.id))) return;
  let ok = true;
  let code: string | null = null;
  try {
    const ctx = { ...controlContextFor(repos, owner), approval: { actionId: action.id, approvedAt: new Date(action.decided_at ?? Date.now()) } };
    await setAutomationPolicy(ctx, policyArgs(rule.policy, key.projectId) as { project_id: string });
    const applied = [...new Set([...(rule.policy.applied ?? []), key.projectId])];
    await repos.memoryRules.setPolicy(rule.id, { ...rule.policy, applied });
  } catch (err) {
    ok = false;
    code = (err as { code?: string }).code ?? 'FAILED';
    deps.log.warn({ rule_id: rule.id, action_id: action.id, code }, 'rules: policy card failed');
  }
  await repos.chatActions.markExecuted(action.id, ok, code);
  chatBus.publish({ type: 'action_status', user_id: owner.id, conversation_id: action.conversation_id, action_id: action.id, status: ok ? 'executed' : 'failed', error_code: code });
  const fresh = await repos.memoryRules.findById(rule.id);
  if (fresh) await settlePolicy(repos, fresh, deps);
}

/**
 * A policy proposal whose cards are all decided: `approved` when at least one project took the change
 * (its sources superseded from then on), `rejected` when none did — a denied or expired card is the
 * person saying no, and the 180 days start then. An approval no hook acted on is applied here first.
 */
async function settlePolicy(repos: Repositories, rule: MemoryRule, deps: RulesDeps): Promise<void> {
  if (rule.status !== 'awaiting_confirmation' || !rule.policy) return;
  let open = false;
  for (const projectId of rule.policy.project_ids) {
    const action = await repos.chatActions.findLatestByKeyInProject(rule.owner_id, projectId, policyCardKey(rule.id, projectId));
    if (!action) continue;
    if (action.status === 'approved') {
      await applyPolicyCard(repos, action, deps);
      return;
    }
    if (action.status === 'pending') open = true;
  }
  if (open) return;
  const fresh = await repos.memoryRules.findById(rule.id);
  if (!fresh || fresh.status !== 'awaiting_confirmation') return;
  const took = (fresh.policy?.applied ?? []).length > 0;
  await repos.memoryRules.decide(rule.id, rule.owner_id, ['awaiting_confirmation'], took ? 'approved' : 'rejected', fresh.decided_by);
}
