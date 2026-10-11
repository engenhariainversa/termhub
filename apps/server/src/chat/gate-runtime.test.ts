import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import { chatBus } from './bus.js';
import { applyGate, type GatedCall } from './gate-runtime.js';

/**
 * `applyGate`'s self-mediated path (spec 2026-09-26 concierge memory D13): `record_decision` and
 * `answer_tab_question` run straight through on a gated token, exactly like a read — no `chat_actions`
 * row, no `confirmation` published — because their own effect already is the mediation. Mirrors
 * `mcp/gate.e2e.test.ts`'s "never gates a read" case, one level down (no HTTP route, no real tool).
 */

const collected: Record<string, unknown>[] = [];
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  collected.length = 0;
  unsubscribe = chatBus.subscribe((event) => collected.push(event as unknown as Record<string, unknown>));
});

afterEach(() => unsubscribe?.());

function ctxWithSpyableActions() {
  const insertPending = vi.fn();
  const findOpenByKey = vi.fn();
  const repos = { chatActions: { insertPending, findOpenByKey } } as unknown as Repositories;
  const ctx = { repos, scope: { user: { id: 'u1' } } } as unknown as ControlContext;
  return { ctx, insertPending, findOpenByKey };
}

it('record_decision runs at once on a gated token: no chat_actions row, no confirmation published', async () => {
  const { ctx, insertPending, findOpenByKey } = ctxWithSpyableActions();
  const run = vi.fn(async () => ({ ref: 'note:abc' }));
  const call: GatedCall = { token: { gated: true, chat_conversation_id: 'c1' }, tool: 'record_decision', args: { question: 'q', decision: 'd', reason: 'r' }, run };

  const outcome = await applyGate(ctx, call);

  expect(outcome).toEqual({ ok: true, value: { ref: 'note:abc' } });
  expect(run).toHaveBeenCalledTimes(1);
  expect(insertPending).not.toHaveBeenCalled();
  expect(findOpenByKey).not.toHaveBeenCalled();
  expect(collected).toEqual([]);
});

it('answer_tab_question runs at once on a gated token too', async () => {
  const { ctx, insertPending } = ctxWithSpyableActions();
  const run = vi.fn(async () => ({ mode: 'suggest' as const }));
  const call: GatedCall = { token: { gated: true, chat_conversation_id: 'c1' }, tool: 'answer_tab_question', args: { question_id: 'tq1' }, run };

  const outcome = await applyGate(ctx, call);

  expect(outcome).toEqual({ ok: true, value: { mode: 'suggest' } });
  expect(run).toHaveBeenCalledTimes(1);
  expect(insertPending).not.toHaveBeenCalled();
  expect(collected).toEqual([]);
});

/** TER-851: only a card the person clicked makes the text the call types theirs. */
function ctxWithApprovedRow(grantId: string | null) {
  const decidedAt = new Date(Date.now() - 60_000).toISOString();
  const row = { id: 'act1', conversation_id: 'c1', status: 'approved', grant_id: grantId, decided_at: decidedAt, created_at: decidedAt, tab_id: null };
  const repos = {
    chatActions: { findOpenByKey: vi.fn(async () => row), claimApproved: vi.fn(async () => true), markExecuted: vi.fn(async () => undefined) },
  } as unknown as Repositories;
  const ctx = { repos, scope: { user: { id: 'u1' } } } as unknown as ControlContext;
  return { ctx, decidedAt };
}

it('runs a clicked card with the approval, so what it types is marked as the person’s', async () => {
  const { ctx, decidedAt } = ctxWithApprovedRow(null);
  const run = vi.fn(async () => ({ ok: true }));
  const outcome = await applyGate(ctx, { token: { gated: true, chat_conversation_id: 'c1' }, tool: 'create_task', args: { project_id: 'p1', title: 't' }, run });
  expect(outcome.ok).toBe(true);
  expect(run).toHaveBeenCalledWith({ actionId: 'act1', approvedAt: new Date(decidedAt) });
});

it('runs a row a grant approved without the approval', async () => {
  const { ctx } = ctxWithApprovedRow('default:board');
  const run = vi.fn(async () => ({ ok: true }));
  await applyGate(ctx, { token: { gated: true, chat_conversation_id: 'c1' }, tool: 'create_task', args: { project_id: 'p1', title: 't' }, run });
  expect(run).toHaveBeenCalledWith(undefined);
});
