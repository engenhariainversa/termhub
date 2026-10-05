import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import type { ControlContext } from '../control/context.js';
import { assertTerminal, offline } from '../control/screen.js';
import { sendInput } from '../control/terminals.js';
import { describeTabQuestions, toTabQuestionView, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
import { forbidden, HttpError, notFound } from '../lib/errors.js';
import { paneForeground } from '../terminal/session-ops.js';
import { lastNonBlankLines, permissionDialogVisible } from './permission-dialog.js';
import { asHttp, codeOf, scopedTabOfRow } from './tab-question-answer.js';
import { typedText, type SuggestionPayload } from './tab-question-payload.js';
import { publishTabQuestions } from './tab-questions.js';
import { readSuggestion, SUGGESTION_CAPTURE_LINES } from './tab-suggestions.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export const suggestionChanged = () => new HttpError(409, 'A sugestão mudou na aba', 'TAB_PROMPT_CHANGED');

/**
 * What "Enviar" types (spec 2026-09-25 tab suggestions §6.2): `typedText` — one line, no control characters
 * (C0, DEL, C1), ≤ 2000, no leading "!" nor "/" (it lands at Claude Code's prompt).
 */
export const suggestionSendBody = z.object({ text: typedText });

/**
 * The live check of a Codex reply card (there is no dimmed suggestion to compare): the tab still waits and
 * the plain screen shows no dialog that would eat the text. No timestamp comparison: any later event
 * (a prompt, a tool, a new Stop) already closes or replaces the card, and the caller has checked it is open and the tab's latest.
 * Codex's composer is not checked for a draft: text the person already typed there stays, and the reply
 * is appended to it before the Enter.
 */
function codexReplyStale(tab: { state: string | null }, screen: string): boolean {
  if (tab.state !== 'waiting_input') return true;
  return permissionDialogVisible(screen) || /enter to submit/i.test(lastNonBlankLines(screen, 5));
}

/**
 * The live check of a resume card (TER-643): the tab is still `idle` and its pane still at the shell. The
 * person may have started something there meanwhile (the agent again, an editor); the resume line would be
 * typed into it.
 */
async function exitedStale(tab: { state: string | null }, machine: Parameters<typeof paneForeground>[0], session: string): Promise<boolean> {
  if (tab.state !== 'idle') return true;
  return (await paneForeground(machine, session)) === 'busy';
}

const suggestionRow = async (ctx: ControlContext, id: string) => {
  const row = await ctx.repos.tabQuestions.findByIdForUser(id, ctx.scope.user.id);
  if (!row || row.kind !== 'suggestion') throw notFound('Sugestão não encontrada');
  return row;
};

/**
 * Sends a tab's suggestion from its card (spec §6.2). In order: `terminals:write`, the row through its
 * owner, the body, the tab through the scope (404), still open and still the tab's latest (409), the live
 * prompt still shows the same suggestion (else 409 and the card closes), the claim (409 for the loser of
 * a double click), then the text and Enter. A failure after the claim leaves the row `failed` and answers
 * 502. Logs ids and counts only — never the text.
 */
export async function sendTabSuggestion(ctx: ControlContext, id: string, raw: unknown, deps: { log: Log }): Promise<TabQuestionView> {
  // Typing into a terminal: the same grant as the MCP write tools.
  if (!(await ctx.can('terminals', 'write'))) throw forbidden('Enviar para a aba precisa da permissão terminals:write na sua role');
  const userId = ctx.scope.user.id;
  const row = await suggestionRow(ctx, id);
  const { text } = suggestionSendBody.parse(raw);
  const suggested = (row.payload as SuggestionPayload).text;
  const isCodex = (row.payload as SuggestionPayload).agent === 'codex';
  const exited = (row.payload as SuggestionPayload).exited === true;
  const { tab, machine } = await scopedTabOfRow(ctx, row, deps.log);
  if (row.status !== 'open') throw suggestionChanged();
  const latest = await ctx.repos.tabQuestions.findOpenForTab(tab.id);
  if (latest?.id !== row.id) throw suggestionChanged();

  let stale: boolean;
  try {
    assertTerminal(tab);
    // an agent moving between instances (a deploy) gets a few seconds to attach before it is called offline
    if (!(await agents.awaitAgent(machine))) throw offline();
    stale = exited
      ? await exitedStale(tab, machine, tab.tmux_session)
      : isCodex
      ? codexReplyStale(tab, await captureScreen(machine, tab.tmux_session, SUGGESTION_CAPTURE_LINES))
      : (await readSuggestion(machine, tab.tmux_session)) !== suggested;
  } catch (err) {
    // agentRpc turns a connection that dropped mid-call into a bare 503 (toHttpError)
    throw asHttp(err instanceof HttpError && err.statusCode === 503 ? offline() : err);
  }
  if (stale) {
    // The tab moved on without telling us: this card is stale, so it leaves the screens now (only this
    // row, only while still open). Best effort: the 409 is the answer either way.
    try {
      const closed = await ctx.repos.tabQuestions.closeOne(row.id, 'answered_in_tab');
      if (closed) await publishTabQuestions(ctx.repos, 'tab_question_closed', [closed]);
    } catch (err) {
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, code: codeOf(err, 'CLOSE_FAILED') }, 'stale tab suggestion not closed');
    }
    throw suggestionChanged();
  }

  // Only a suggestion row can be claimed here (the repository's kind guard), whatever the lookup said.
  const claimed = await ctx.repos.tabQuestions.claimSuggestion(row.id, userId, { text });
  if (!claimed) throw suggestionChanged();
  try {
    // The person clicked "Enviar" on this text (they may have edited it): their approval, word for word.
    await sendInput(ctx, { tab_id: tab.id, text, enter: true }, { level: 'person_approved', userId, actionId: null, approvedAt: new Date() });
  } catch (err) {
    const code = codeOf(err);
    deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, kind: 'suggestion', code }, 'tab suggestion send failed');
    // Recording the failure is best effort: a db or bus error here must not replace the send's own error.
    try {
      const failed = await ctx.repos.tabQuestions.markFailed(row.id, code);
      if (failed) await publishTabQuestions(ctx.repos, 'tab_question_answered', [failed]);
    } catch (recordErr) {
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, code: codeOf(recordErr, 'RECORD_FAILED') }, 'tab suggestion failure not recorded');
    }
    throw new HttpError(502, 'Não foi possível enviar para a aba', code);
  }
  deps.log.info({ tabQuestionId: row.id, tabId: tab.id, kind: 'suggestion', chars: text.length, edited: text !== suggested }, 'tab suggestion sent');
  // The text is in the tab: announcing it is best effort and can no longer turn the send into an error.
  try {
    const [view] = await publishTabQuestions(ctx.repos, 'tab_question_answered', [claimed]);
    if (view) return view;
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, code: codeOf(err, 'PUBLISH_FAILED') }, 'tab suggestion send not announced');
  }
  return toTabQuestionView(claimed, tab.name);
}

/**
 * "Dispensar" (spec §6.1): the card closes as `dismissed`; the tab is not touched, so no terminal grant is
 * needed. Idempotent: a suggestion already sent, closed or dismissed comes back as it is.
 */
export async function dismissTabSuggestion(ctx: ControlContext, id: string, deps: { log: Log }): Promise<TabQuestionView> {
  const userId = ctx.scope.user.id;
  const row = await suggestionRow(ctx, id);
  const dismissed = await ctx.repos.tabQuestions.dismiss(row.id, userId);
  if (!dismissed) {
    const now = (await ctx.repos.tabQuestions.findByIdForUser(row.id, userId)) ?? row;
    const [view] = await describeTabQuestions(ctx.repos, [now], userId);
    return view;
  }
  deps.log.info({ tabQuestionId: row.id, tabId: row.tab_id, kind: 'suggestion' }, 'tab suggestion dismissed');
  // The row is dismissed: announcing it is best effort and can no longer turn the dismiss into an error.
  try {
    const [view] = await publishTabQuestions(ctx.repos, 'tab_question_closed', [dismissed]);
    if (view) return view;
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, tabId: row.tab_id, code: codeOf(err, 'PUBLISH_FAILED') }, 'tab suggestion dismiss not announced');
  }
  return toTabQuestionView(dismissed, null);
}
