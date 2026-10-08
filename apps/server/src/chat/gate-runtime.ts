/**
 * The gate at the MCP boundary (spec §5.2): on a gated token — the concierge's, never a person's own
 * — a write is a question to the user, not an action. The HTTP call never waits for the answer, since
 * nginx cuts /mcp at 120 s and a blue/green deploy would lose the question: it returns at once saying
 * the action is pending, and the row in `chat_actions` is what remembers. When the user confirms, the
 * CLI session is told to repeat the call, and *that* arrival executes it.
 */
import { CONTROL_CHARS } from '../control/agents.js';
import { ControlError, type ControlContext } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import type { ChatAction, ChatActionClass } from '../db/repositories/chat-actions.js';
import { describeActions } from '../db/repositories/chat-actions-view.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { automationCallIsBrake } from '../automation/setup-tools.js';
import { chatBus } from './bus.js';
import { boardProjectOf } from './board-project.js';
import { type ActionClass, actionClass, BOARD_GRANT_BUDGET, BOARD_GRANT_TOOLS, boardGrantable, DEFAULT_ALLOW_BUDGETS, defaultGrantId, defaultKindOf, gateDecision, grantable, GRANTABLE_TOOL, idempotencyKeyFor, STANDING_BUDGET_WINDOW_MS, STANDING_GRANT_BUDGETS, standingKindOf, TAB_TERMINAL_GRANT, TERMINAL_GRANT_BUDGET, TERMINAL_GRANT_TOOLS, terminalGrantable } from './gate.js';
import { SCREEN_STATE_LINES, claudeScreenState } from '../monitor/screen-state.js';
import { STALE_WORKING_MS } from '../monitor/stale-working.js';
import { permissionDialogVisible } from './permission-dialog.js';
import { resurfaceCards } from './resurface.js';
import { ACTION_TTL_MS } from './service.js';
import { standingProjectOf } from './standing-project.js';
import { subagentOrigins } from './subagent-origin.js';

/** What the gate did: the tool's own value, or a pt-BR error for the caller to answer with. The
 * error's `code` is what the existing per-call audit row records; the gate writes no audit row. */
export type GateOutcome = { ok: true; value: unknown } | { ok: false; code: string; message: string };

export interface GatedCall {
  /** `gated` decides whether anything is mediated at all; `chat_conversation_id` names the chat a
   * gated write is asked in (see `applyGate`). */
  token: { gated: boolean; chat_conversation_id?: string | null };
  tool: string;
  args: Record<string, unknown>;
  /** The CLI's tool_use_id for this call (`_meta['claudecode/toolUseId']`, spec 2026-09-26 §4), when
   * the transport carried one — set only by the MCP route. Used to look up which subagent's turn (if
   * any) is making this call, through `subagentOrigins`. */
  tool_use_id?: string;
  /** The tool call itself, already scope-checked and argument-validated by the caller. `approval` is
   *  passed only when it runs a card the person clicked, never under a grant (TER-851). */
  run(approval?: { actionId: string; approvedAt: Date }): Promise<unknown>;
}

const PENDING = (tool: string) =>
  `Ação pendente de confirmação: o usuário precisa aprovar a ferramenta ${tool} no chat e nada foi executado. Não repita a chamada nem tente outro caminho. Se o mesmo pedido do usuário precisa de outras ações independentes desta, proponha todas agora, nesta mesma resposta: elas aparecem juntas numa só confirmação. Depois diga a ele que está aguardando a confirmação e pare. Quando ele decidir, você será avisado e poderá repetir as chamadas autorizadas.`;

const WAITING: GateOutcome = {
  ok: false,
  code: 'CONFIRMATION_WAITING',
  message:
    'Esta ação ainda está aguardando a confirmação do usuário no chat: a pergunta já foi enviada e nada foi executado. Não repita a chamada: diga a ele que está esperando e pare.',
};

/**
 * The same proposal asked again while its card still waits (TER-477): the card was just brought back to
 * the end of the chat, so the model points the person at it instead of telling them to scroll up.
 */
const RESURFACED: GateOutcome = {
  ok: false,
  code: 'CONFIRMATION_WAITING',
  message:
    'Esta ação ainda está aguardando a confirmação do usuário no chat e nada foi executado. O card foi trazido de volta para o fim da conversa: diga a ele que está logo abaixo e pare. Não repita a chamada.',
};

/**
 * A parallel arrival of the same approved proposal that lost the claim: another call already owns the
 * execution. Deliberately the same `CONFIRMATION_WAITING` outcome as a question still on screen —
 * what the model must do is identical, stop and wait — with wording that says which of the two it is.
 */
const ALREADY_CLAIMED: GateOutcome = {
  ok: false,
  code: 'CONFIRMATION_WAITING',
  message:
    'Uma chamada idêntica que chegou antes já está executando esta ação, então esta não executou nada. Não repita a chamada: espere o resultado da primeira e siga a partir dele.',
};

/**
 * An approval that aged out before any call came back to use it. Deliberately not `REFUSED`: the user
 * said yes and nobody ever said no, so the model must read this as a permission that lapsed, not as a
 * decision against the action. Repeating the call is the right next step and is exactly what the model
 * is told to do — the row has just been expired, so that repeat asks the user again instead of finding
 * the same dead approval.
 */
const APPROVAL_EXPIRED: GateOutcome = {
  ok: false,
  code: 'CONFIRMATION_EXPIRED',
  message:
    'A confirmação que o usuário deu para esta ação é antiga e expirou, então nada foi executado. Isto não é uma recusa: se a ação ainda fizer sentido, repita a chamada para propô-la de novo e o usuário confirma outra vez.',
};

const REFUSED: GateOutcome = {
  ok: false,
  code: 'CONFIRMATION_DENIED',
  message:
    'O usuário recusou esta ação no chat, então ela não será executada. Não tente de novo nem por outro caminho: explique a ele o que ficou sem fazer e, se houver, proponha uma alternativa diferente.',
};

/**
 * How long a "no" keeps refusing the identical proposal. What a denial has to defend against is the
 * immediate retry — a model told no that asks again three times in the same turn, wearing the user
 * down and burning quota — and that risk lives in minutes, not for ever: after that the user may well
 * have changed their mind, and a permanent refusal would leave them no way to say so. A question the
 * user never answered (`expired`) is not a "no" at all, and is simply asked again.
 *
 * The window is also cut short by the person writing again (`denialInForce`, TER-530): a message they
 * typed after the "no" is a new request, and the same call then asks again instead of refusing.
 */
const DENIAL_HOLDS_MS = 15 * 60 * 1000;

/**
 * How long a "yes" keeps authorising the identical proposal. An approval is the user's answer to a
 * question asked *now*: the model is expected to re-issue the gated call within the same conversation,
 * seconds later. The row, though, outlives the run — and an approval nobody ever consumed (the model
 * never came back, the run died, the session was dropped) would otherwise stay `approved` for ever:
 * weeks later a byte-identical proposal would find it, claim it and act on the user's machine without
 * anybody being asked. A "yes" has to be as mortal as the "no" it mirrors.
 *
 * The window is the same 24 h the spec fixes for a question the user never answered (`ACTION_TTL_MS`,
 * imported rather than repeated), for two reasons: it is a number the spec already chose, and it is
 * the very window the hourly sweep uses — so the gate's clock and the sweep's clock are one clock, and
 * a row the sweep has not reached yet is judged here exactly as the sweep would judge it.
 */
const APPROVAL_HOLDS_MS = ACTION_TTL_MS;

/** The user's "no" while it still holds. An older one is history: the same proposal is asked again.
 * So is one the person has written after (TER-530): the retry a denial guards against is the model's
 * own, within the turn it was told no; once the person types again — "pode fechar as janelas" — the
 * same call is their request, and it gets a fresh card instead of a refusal they never gave. */
async function denialInForce(ctx: ControlContext, conversationId: string, key: string): Promise<ChatAction | undefined> {
  const row = await ctx.repos.chatActions.findDeniedByKey(conversationId, key);
  if (!row) return undefined;
  const decidedAt = Date.parse(row.decided_at ?? row.created_at);
  if (!(Number.isFinite(decidedAt) && Date.now() - decidedAt < DENIAL_HOLDS_MS)) return undefined;
  const typedAt = Date.parse((await ctx.repos.chat.lastTypedAt(conversationId)) ?? '');
  return Number.isFinite(typedAt) && typedAt > decidedAt ? undefined : row;
}

/** The mirror of `denialInForce` for a "yes": whether this approval is still the user's current
 * answer. An unparseable `decided_at` counts as too old — the safe direction for a permission. */
const approvalInForce = (row: ChatAction): boolean => {
  const decidedAt = Date.parse(row.decided_at ?? row.created_at);
  return Number.isFinite(decidedAt) && Date.now() - decidedAt < APPROVAL_HOLDS_MS;
};

/**
 * Retires an approval the clock has outlived, and says so. The update is conditional on the row still
 * being approved (`expireApproved`), so this can never race a parallel arrival that claimed the very
 * same approval. Losing that update is the same ambiguity a lost claim has, and is read the same way
 * (`raceLost`): somebody is executing this action, or somebody already retired it.
 */
async function expireApproval(ctx: ControlContext, row: ChatAction): Promise<GateOutcome> {
  if (!(await ctx.repos.chatActions.expireApproved(row.id))) return raceLost(ctx, row);
  publishStatus(ctx, row, 'expired', null);
  return APPROVAL_EXPIRED;
}

const TAB_GONE = (tabId: string) => ({
  code: 'TAB_GONE',
  message: `A aba ${tabId} não existe mais, então a confirmação que o usuário deu para esta ação não vale mais e nada foi executado. Veja as abas com list_tabs e proponha a ação de novo se ainda fizer sentido.`,
});

const TAB_WAITING_PERMISSION = (tabId: string) => ({
  code: 'WAITING_PERMISSION',
  message: `A aba ${tabId} passou a esperar uma permissão enquanto a confirmação estava pendente: digitar agora responderia essa pergunta, não o que o usuário confirmou. Nada foi executado e a confirmação não vale mais. Leia a tela com read_screen e proponha a ação de novo.`,
});

/** A call a grant ran into a tab that started asking for a permission after the gate let it through
 * (spec 2026-09-27 TER-325 §2 "Lock at execution time"). Unlike a clicked `send_key`, a granted call
 * never acts on a tab asking a permission — a key would answer it, a standing `close_tab` (TER-386)
 * would kill it: the user has to see that dialog. */
const GRANTED_KEY_ON_PERMISSION = (tabId: string) => ({
  code: 'WAITING_PERMISSION',
  message: `A aba ${tabId} passou a pedir uma permissão antes desta ação: responder permissões nunca é liberado sem o usuário. Nada foi executado. Proponha a ação de novo e o usuário confirma no chat.`,
});

const TAB_PROMPT_CHANGED = (tabId: string) => ({
  code: 'PROMPT_CHANGED',
  message: `A aba ${tabId} está esperando outra permissão, pedida depois da pergunta que o usuário confirmou: responder agora aceitaria algo que ele nunca viu. Nada foi executado e a confirmação não vale mais. Leia a tela com read_screen e proponha a ação de novo.`,
});

/** What the action targets, for the chat's card and for re-validating an approval. Ids only: a value
 * of another shape is not an id and is dropped rather than stored. */
const targetId = (v: unknown) => (typeof v === 'string' && v.length >= 1 && v.length <= 64 ? v : null);
const targetOf = (args: Record<string, unknown>) => ({
  machine_id: targetId(args.machine_id),
  project_id: targetId(args.project_id),
  tab_id: targetId(args.tab_id),
});

/**
 * A tab card also keeps its tab's project (TER-986) and its name (TER-1024), read owner-scoped when the
 * card is asked: the card then still says which tab, of which project, it was for once the tab is
 * closed. Only fills a project the call did not name; a tab that does not resolve (gone, or another
 * user's) adds nothing. Best-effort: a failed read keeps the target as the call named it.
 */
type Target = ReturnType<typeof targetOf> & { tab_name?: string | null };
async function withTabSnapshot(ctx: ControlContext, target: ReturnType<typeof targetOf>): Promise<Target> {
  if (!target.tab_id) return target;
  try {
    const [tab] = await ctx.repos.tabs.findByIdsForOwner([target.tab_id], ctx.scope.user.id);
    return tab ? { ...target, project_id: target.project_id ?? tab.project_id, tab_name: tab.name } : target;
  } catch {
    return target;
  }
}

/** The subagent that made this call, if the live run saw its tool frame first and it is this
 * conversation's. */
const originFor = (call: GatedCall, conversationId: string) => {
  if (!call.tool_use_id) return { tool_use_id: null, subagent_id: null };
  const o = subagentOrigins.originOf(call.tool_use_id);
  return { tool_use_id: call.tool_use_id, subagent_id: o && o.conversationId === conversationId ? o.subagentId : null };
};

/**
 * The origin can land between `originFor`'s read and the insert — and then the live run's own bind
 * (`setSubagentByToolUse`) already ran while the row did not exist yet. A second read once the row is
 * stored ties it here, before its card is published, so the card still says which subagent asked.
 * Best-effort: a failure keeps the row as inserted (no origin, exactly as before this read).
 */
async function bindLateOrigin(ctx: ControlContext, call: GatedCall, conversationId: string, row: ChatAction): Promise<ChatAction> {
  if (row.subagent_id !== null || !call.tool_use_id) return row;
  const { subagent_id } = originFor(call, conversationId);
  if (!subagent_id) return row;
  try {
    const bound = await ctx.repos.chatActions.setSubagentByToolUse(conversationId, call.tool_use_id, subagent_id);
    // Nothing bound means the live run's bind got there first, with this same origin.
    return bound.find((r) => r.id === row.id) ?? { ...row, subagent_id };
  } catch {
    return row;
  }
}

/**
 * Tools that type free text at the prompt — exactly what must not land in a permission dialog.
 * `send_key`, and `send_input` with `answering_permission`, are how a pending permission is meant to
 * be answered (the tools' own contract), so for those a tab waiting on a permission is not stale.
 */
/** Tools that name a tab without sending it a key (TER-499): an approval of one is not an answer to
 *  whatever the tab is asking, so only a closed tab spends it. */
const NON_TYPING_TAB_TOOLS: ReadonlySet<string> = new Set(['link_tab_task']);

const typesFreeText = (call: GatedCall) => call.tool === 'run_command' || (call.tool === 'send_input' && call.args.answering_permission !== true);

/**
 * Whether the permission the tab is asking for now is a different one from the one the user saw when
 * they confirmed. `TabsRepository.recordEvent` treats every `waiting_permission` as a fresh ask and
 * bumps `state_at` for it, so a `state_at` later than the question's `created_at` is another prompt:
 * the first was answered and a second appeared while the approval waited. Without this, an approved
 * "press Enter" could accept a dialog nobody ever read.
 */
function promptChangedSince(tab: Tab, row: ChatAction): boolean {
  const askedAt = Date.parse(tab.state_at ?? '');
  const confirmed = Date.parse(row.created_at);
  return Number.isFinite(askedAt) && Number.isFinite(confirmed) && askedAt > confirmed;
}

/**
 * An approval is a snapshot of the moment the user gave it. Between the question and the keystroke
 * the tab can be killed, or the tool in it can start asking for a permission — and then the approved
 * text would answer the wrong question. Either way the approval is spent: the row fails (never back
 * to pending) and the model is told why. A row a grant approved never answers a permission at all,
 * whatever the tool: nobody saw that dialog.
 */
async function staleApproval(ctx: ControlContext, call: GatedCall, row: ChatAction): Promise<{ code: string; message: string } | undefined> {
  if (!row.tab_id) return undefined;
  // Owner-scoped, batched read — the same one the card's enrichment uses, and for the same reason: a
  // gated model can name any tab id it likes (a prompt injected into a terminal screen would aim for
  // exactly that), and an unscoped read would resolve a stranger's tab and hand the model the tool's
  // own "not found" instead of `TAB_GONE` — an existence oracle for somebody else's tab.
  const [tab] = await ctx.repos.tabs.findByIdsForOwner([row.tab_id], ctx.scope.user.id);
  if (!tab) return TAB_GONE(row.tab_id);
  if (NON_TYPING_TAB_TOOLS.has(call.tool)) return undefined;
  if (tab.state === 'waiting_permission') {
    if (typesFreeText(call)) return TAB_WAITING_PERMISSION(row.tab_id);
    // A grant's call was never shown to the user, so it cannot be the answer they chose.
    if (row.grant_id) return GRANTED_KEY_ON_PERMISSION(row.tab_id);
    // The exempted tools answer a permission on purpose — but only the one the user actually saw.
    if (promptChangedSince(tab, row)) return TAB_PROMPT_CHANGED(row.tab_id);
  }
  return undefined;
}

/**
 * Why a conditional update on an `approved` row found nothing, in the only terms the model can act on.
 * Two different things take a row out of `approved`: a parallel arrival that is now executing it, and an
 * expiry — the hourly sweep, or another arrival of this same call, retiring an approval nobody consumed.
 * They call for opposite answers — wait for the other call's result, or propose the action again — so the
 * row itself is asked which happened, rather than assumed. Told to wait for a result an expiry made sure
 * will never come, the model stops, the user sees nothing happen, and no new question is ever asked.
 *
 * Anything other than a definite `expired` reads as the genuine race: the row is unreadable, gone, or
 * being executed, and "stop and wait" is the safe answer when this call cannot tell.
 */
async function raceLost(ctx: ControlContext, row: ChatAction): Promise<GateOutcome> {
  const current = await ctx.repos.chatActions.findByIdForUser(row.id, ctx.scope.user.id).catch(() => undefined);
  return current?.status === 'expired' ? APPROVAL_EXPIRED : ALREADY_CLAIMED;
}

/** Tells every open screen how a gated action ended (TER-477). Publishing never throws (`chatBus`). */
function publishStatus(ctx: ControlContext, row: ChatAction, status: 'executed' | 'failed' | 'expired', errorCode: string | null): void {
  chatBus.publish({ type: 'action_status', user_id: ctx.scope.user.id, conversation_id: row.conversation_id, action_id: row.id, status, error_code: errorCode });
}

/** Runs an approved action and closes its row. Ruling R2: an offline machine, an agent too old, any
 * failure at all is a `failed` row carrying the real error code, and the error reaches the model —
 * never a new question, because asking again for what the machine cannot do is a loop with no exit. */
async function execute(ctx: ControlContext, call: GatedCall, row: ChatAction): Promise<GateOutcome> {
  const started = Date.now();
  // Claim the approval before anything else happens. Two identical calls can both read the same
  // `approved` row and, without a claim, both would act on one approval — one confirmation, two
  // commands on the user's machine. The conditional update lets exactly one through.
  if (!(await ctx.repos.chatActions.claimApproved(row.id))) return raceLost(ctx, row);
  const stale = await staleApproval(ctx, call, row);
  if (stale) {
    await ctx.repos.chatActions.markExecuted(row.id, false, stale.code, Date.now() - started);
    publishStatus(ctx, row, 'failed', stale.code);
    return { ok: false, ...stale };
  }
  try {
    // A row born approved by a grant or a default is the gate letting the call through, not the person
    // approving this text: only a clicked card (`grant_id` null) makes what is typed theirs (TER-851).
    const decidedAt = row.decided_at ? new Date(row.decided_at) : null;
    const approval = row.grant_id === null && decidedAt && Number.isFinite(decidedAt.getTime()) ? { actionId: row.id, approvedAt: decidedAt } : undefined;
    const value = await call.run(approval);
    await ctx.repos.chatActions.markExecuted(row.id, true, null, Date.now() - started);
    publishStatus(ctx, row, 'executed', null);
    return { ok: true, value };
  } catch (err) {
    const code = err instanceof ControlError || err instanceof HttpError ? (err.code ?? 'ERROR') : 'INTERNAL';
    await ctx.repos.chatActions.markExecuted(row.id, false, code, Date.now() - started);
    publishStatus(ctx, row, 'failed', code);
    throw err; // the caller turns it into the same answer any other failed tool call gets
  }
}

/**
 * The write that would have recorded a proposal (pending or already-approved) failed for a real
 * reason — not the partial unique index catching a race, which the two callers below check for
 * before reaching here. The original error is deliberately not rethrown: a rejected write carries
 * the rejected data, so logging it upstream would put the proposed command — the whole point of
 * `args` — in a log line. The audit row's code is the signal. Shared by `ask` and `executeGranted`,
 * whose inserts hit the same failure modes and must answer the model identically.
 */
function actionNotRecorded(): never {
  throw new ControlError(
    'ACTION_NOT_RECORDED',
    'Não foi possível registrar esta ação para o usuário confirmar, então nada foi executado. Avise que houve uma falha ao registrar o pedido e tente de novo em alguns segundos.',
  );
}

/** Records the proposal and puts the question in the chat. */
async function ask(ctx: ControlContext, call: GatedCall, conversationId: string, key: string, cls: ChatActionClass): Promise<GateOutcome> {
  const target = await withTabSnapshot(ctx, targetOf(call.args));
  let row: ChatAction;
  try {
    // `args` is the proposal exactly as the concierge made it — the command, the prompt, the target.
    row = await ctx.repos.chatActions.insertPending({ conversation_id: conversationId, tool: call.tool, args: call.args, class: cls, idempotency_key: key, ...target, ...originFor(call, conversationId) });
  } catch {
    // Two calls of the same proposal can both read "no open row" before either inserts; the partial
    // unique index then refuses the loser. The winner's question is already in the chat, so this call
    // is simply waiting on it — asking again would put the same question twice in front of the user.
    // (An approval that landed in this same instant is picked up by the next arrival of the call.)
    if (await ctx.repos.chatActions.findOpenByKey(conversationId, key)) return WAITING;
    actionNotRecorded();
  }
  row = await bindLateOrigin(ctx, call, conversationId, row);
  await publishCard(ctx.repos, ctx.scope.user.id, row);
  return { ok: false, code: 'CONFIRMATION_PENDING', message: PENDING(call.tool) };
}

/**
 * Puts a pending card in front of the person (every open screen, and the phone's push). Enriched the same
 * way, and only in this one place, as `GET /api/chat`'s trail — the browser must never resolve a
 * machine/project/tab name or build the sentence itself. Scoped to the person the card is for: the model
 * on a gated token could name someone else's task/tab/project id in `call.args` (exactly what a prompt
 * injected into a terminal screen would aim for), and this card must never confirm that a foreign id
 * exists, let alone show its name, before the call that would 404 on it.
 */
async function publishCard(repos: Repositories, userId: string, row: ChatAction): Promise<void> {
  const [card] = await describeActions(repos, [row], userId);
  chatBus.publish({
    type: 'confirmation',
    user_id: userId,
    conversation_id: row.conversation_id,
    action_id: row.id,
    tool: row.tool,
    args: row.args,
    class: row.class,
    machine_id: row.machine_id,
    project_id: row.project_id,
    tab_id: row.tab_id,
    summary: card.summary,
    subagent: card.subagent,
    created_at: row.created_at,
  });
}

/**
 * A card the server asks by itself, for automatic work (agentic board D7: a merge above the project's
 * level). It is the gate's pending card — same row, same class rules, same publish as `ask()` — in the
 * owner's most recent conversation of the project (opened when there is none), but it is never a
 * concierge proposal: the row is born injected (the model is never told to repeat a call it never made)
 * and its approval is acted on by the server (`ChatService.onApproved`). Asked once per `key`, whatever
 * became of the earlier card: null when the key was already asked.
 */
export async function askForAutomation(
  repos: Repositories,
  ownerId: string,
  projectId: string,
  payload: { tool: string; args: Record<string, unknown>; key: string },
): Promise<ChatAction | null> {
  if (await repos.chatActions.findLatestByKeyInProject(ownerId, projectId, payload.key)) return null;
  const conversation = (await repos.chat.findLatestActiveForProject(projectId, ownerId)) ?? (await repos.chat.getOrCreateForProject(ownerId, projectId));
  let row: ChatAction;
  try {
    row = await repos.chatActions.insertPending({
      conversation_id: conversation.id,
      tool: payload.tool,
      args: payload.args,
      class: actionClass(payload.tool, payload.args) === 'irreversible' ? 'irreversible' : 'write',
      idempotency_key: payload.key,
      project_id: projectId,
      injected: true,
    });
  } catch (e) {
    // the other colour asked the same key in the same instant: its card is the one
    if (await repos.chatActions.findOpenByKey(conversation.id, payload.key)) return null;
    throw e;
  }
  await publishCard(repos, ownerId, row);
  return row;
}

/**
 * Runs a call a grant (tab or project) already answered ("Permitir sempre nesta aba", spec 2026-09-25;
 * "Permitir sempre neste projeto", spec 2026-09-26; "Liberar teclas e shell nesta aba" / "Liberar tudo
 * neste projeto", spec 2026-09-27 TER-325). The row is
 * born `approved` and goes through `execute()` like a clicked approval — the claim, `staleApproval`
 * (so a dead tab or a tab waiting on a permission still blocks) and the audit — and the trail is told
 * live, since no card was ever shown for it.
 */
async function executeGranted(ctx: ControlContext, call: GatedCall, conversationId: string, key: string, cls: ChatActionClass, grantId: string): Promise<GateOutcome> {
  const target = await withTabSnapshot(ctx, targetOf(call.args));
  let row: ChatAction;
  try {
    row = await ctx.repos.chatActions.insertApproved({ conversation_id: conversationId, tool: call.tool, args: call.args, class: cls, idempotency_key: key, ...target, ...originFor(call, conversationId), grant_id: grantId, decided_by: ctx.scope.user.id });
  } catch {
    // Either reading of a failed insert: the partial unique index refused it because an identical
    // call arrived in the same instant and its (approved) row already occupies the key — the same
    // race `ask` checks for, read the same way (`findOpenByKey`) — or the write failed for a real
    // reason and nothing recorded the proposal at all.
    if (await ctx.repos.chatActions.findOpenByKey(conversationId, key)) return ALREADY_CLAIMED;
    actionNotRecorded();
  }
  row = await bindLateOrigin(ctx, call, conversationId, row);
  try {
    return await execute(ctx, call, row);
  } finally {
    // Telling the trail live is best-effort: this step must never turn a keystroke that already ran
    // (or whose failure `execute` already recorded) into a different outcome for the caller, and the
    // grant is still active — a retry driven by an error here would type it again. A reload picks the
    // row up from `GET /api/chat` regardless.
    try {
      const done = await ctx.repos.chatActions.findByIdForUser(row.id, ctx.scope.user.id);
      if (done) {
        const [card] = await describeActions(ctx.repos, [done], ctx.scope.user.id);
        chatBus.publish({ type: 'granted_action', user_id: ctx.scope.user.id, conversation_id: conversationId, action: card });
      }
    } catch {
      // live trail is best-effort; a reload shows the row
    }
  }
}

/**
 * Whether the text half of a call disqualifies it from a grant, beyond the grant existing (spec §2
 * "Agent tabs only"). A grant trusts an agent's prompt, but `send_input` types any text and presses
 * Enter: on a bare shell that is `run_command` under another name, and in Claude Code a leading `!`
 * runs the rest in bash — so text whose first non-blank character is `!` is outside the grant. Any
 * other control character is outside it too: `send_input` delivers the text as keystrokes, and a
 * control character is not "text" to the terminal but an edit to the line being typed — Ctrl-U wipes
 * it, backspace (`\x7f`) erases the character before it — so it can turn text that does not itself
 * start with `!` into a `!` command by the time the TUI reads it. `CONTROL_CHARS` is the same check
 * `checkPrompt` uses for a prompt's own text; only `\n` (a pasted multi-line prompt) is allowed. Both
 * checks read the arguments alone, before any read, and the tab must separately report an agent at
 * work (`working`, `waiting_background`, `waiting_input` or `finished`, from the monitor hooks). A tab that never reported (a shell), an
 * agent that ended (`idle`) or errored falls back to a normal question. Two readings deliberately still
 * go through the grant: a tab that does not resolve (missing, or somebody else's) and one waiting on a
 * permission, so `execute()` records them as the `TAB_GONE` / `WAITING_PERMISSION` locks — the model
 * gets the lock's error, as for a clicked approval.
 */
const textOutsideGrant = (args: Record<string, unknown>) =>
  typeof args.text === 'string' && (args.text.trimStart().startsWith('!') || CONTROL_CHARS.test(args.text));

/** The tab half of the eligibility above, through the same owner-scoped read `staleApproval` uses. */
async function grantCoversTab(ctx: ControlContext, tabId: string): Promise<boolean> {
  const [tab] = await ctx.repos.tabs.findByIdsForOwner([tabId], ctx.scope.user.id);
  if (!tab) return true; // recorded as TAB_GONE by `execute()`
  return tab.state === 'working' || tab.state === 'waiting_background' || tab.state === 'waiting_input' || tab.state === 'finished' || tab.state === 'waiting_permission';
}

/**
 * The project grant that answers a board call, if any (spec 2026-09-26 project grant §4): the project
 * the call writes into, resolved owner-scoped (an unresolved one is never covered), an active grant for
 * it in this conversation, and budget left. Not atomic with the insert — parallel calls at the edge can
 * overshoot by their number, which a brake tolerates.
 */
async function projectGrantCovering(ctx: ControlContext, conversationId: string, call: GatedCall): Promise<string | null> {
  const projectId = await boardProjectOf(ctx.repos, ctx.scope.user.id, call.tool, call.args);
  if (!projectId) return null;
  const grant = await ctx.repos.chatProjectGrants.findActive(conversationId, projectId);
  if (!grant) return null;
  // Board calls only: a "tudo" grant's terminal calls have a budget of their own (spec 2026-09-27 §2).
  const used = await ctx.repos.chatActions.countForGrantSince(conversationId, grant.id, new Date(Date.now() - BOARD_GRANT_BUDGET.windowMs), [...BOARD_GRANT_TOOLS]);
  return used < BOARD_GRANT_BUDGET.calls ? grant.id : null;
}

/** Whether a grant has terminal calls left this hour, against `TERMINAL_GRANT_BUDGET`. */
async function terminalBudgetLeft(ctx: ControlContext, conversationId: string, grantId: string): Promise<boolean> {
  const used = await ctx.repos.chatActions.countForGrantSince(conversationId, grantId, new Date(Date.now() - TERMINAL_GRANT_BUDGET.windowMs), [...TERMINAL_GRANT_TOOLS]);
  return used < TERMINAL_GRANT_BUDGET.calls;
}

/** The live half of "never answer a permission" (spec 2026-09-27 TER-325 §2): a plain capture of the
 * tab's last lines. A dialog on screen — or a capture that fails, since then nothing is known — means
 * ask. The capture is never logged or stored. */
async function permissionOnScreen(ctx: ControlContext, tabId: string): Promise<boolean> {
  try {
    const { text } = await readScreen(ctx, { tab_id: tabId, lines: 40 }, { plain: true });
    return permissionDialogVisible(text);
  } catch {
    return true;
  }
}

/**
 * The terminal-level grant that covers a `send_input`/`send_key` (spec 2026-09-27 TER-325 §4): the tab's
 * own "teclas e shell" grant, else a project "tudo" grant for the tab's project — resolved owner-scoped,
 * so a foreign or missing tab is never covered by a project grant. A tab-level grant naming a tab that no
 * longer resolves still returns, so `execute()` records `TAB_GONE`. `waiting_permission`, a dialog on the
 * screen and a spent budget all return null: the call is asked. Like the board budget, not atomic with
 * the insert.
 */
async function terminalGrantCovering(ctx: ControlContext, conversationId: string, tabId: string): Promise<string | null> {
  const [tab] = await ctx.repos.tabs.findByIdsForOwner([tabId], ctx.scope.user.id);
  const tabGrant = await ctx.repos.chatGrants.findActive(conversationId, tabId, TAB_TERMINAL_GRANT);
  if (!tab) return tabGrant ? tabGrant.id : null;
  if (tab.state === 'waiting_permission') return null;
  let grantId: string | null = null;
  if (tabGrant && (await terminalBudgetLeft(ctx, conversationId, tabGrant.id))) grantId = tabGrant.id;
  if (!grantId) {
    const projectGrant = await ctx.repos.chatProjectGrants.findActive(conversationId, tab.project_id);
    if (projectGrant?.scope === 'all' && (await terminalBudgetLeft(ctx, conversationId, projectGrant.id))) grantId = projectGrant.id;
  }
  if (!grantId) return null;
  return (await permissionOnScreen(ctx, tabId)) ? null : grantId;
}

/**
 * The standing grant ("Liberar sem prazo", spec 2026-09-28 TER-386) that covers this call, if any: the
 * call's kind, its project resolved owner-scoped (an unresolved one is never covered), the per-kind guards
 * — a close only of a tab that is not working nor asking a permission; terminal calls under TER-325's
 * rules — an active grant of this user for that project and kind, and budget left this hour, counted
 * across conversations. Like the other budgets, not atomic with the insert.
 */
async function standingGrantCovering(ctx: ControlContext, call: GatedCall): Promise<string | null> {
  const kind = standingKindOf(call.tool, call.args);
  if (!kind) return null;
  if (kind === 'terminal' && textOutsideGrant(call.args)) return null;
  const target = await standingProjectOf(ctx.repos, ctx.scope.user.id, kind, call.tool, call.args);
  if (!target) return null;
  if (kind === 'close_tab' && (target.tab?.state === 'working' || target.tab?.state === 'waiting_background' || target.tab?.state === 'waiting_permission')) return null;
  if (kind === 'terminal' && target.tab?.state === 'waiting_permission') return null;
  const grant = await ctx.repos.chatStandingGrants.findActive(ctx.scope.user.id, target.projectId, kind);
  if (!grant) return null;
  const used = await ctx.repos.chatActions.countByGrantSince(grant.id, new Date(Date.now() - STANDING_BUDGET_WINDOW_MS));
  if (used >= STANDING_GRANT_BUDGETS[kind]) return null;
  if (kind === 'terminal' && (await permissionOnScreen(ctx, target.tab!.id))) return null;
  return grant.id;
}

/** Tab states a default close is for (TER-627): the agent is not at work — `finished` among them, an agent
 * that reported and asks nothing (TER-972). `null` (a tab that never reported, a bare shell that may be
 * running anything) is not among them, nor `working` read at face value, nor `waiting_permission`, which
 * the person has to see. */
const STOPPED_TAB_STATES: ReadonlySet<string> = new Set(['waiting_input', 'finished', 'idle', 'error']);

/**
 * A Claude Code `working` tab whose state is stale in the TER-615 sense — no hook event for `STALE_WORKING_MS` — and
 * whose screen shows Claude Code back at its input box with no spinner: the check the stale-working
 * sweeper makes, made now, so a close does not wait for its next pass. Any doubt (a fresh state, a
 * failed capture, a spinner, a dialog, a screen it cannot read) is "at work". Never logged.
 */
async function idleDespiteWorking(ctx: ControlContext, tab: Tab): Promise<boolean> {
  // The screen check reads Claude Code's own screen; another tool's is not something it can judge.
  if (tab.state_tool !== 'claude') return false;
  const since = Date.parse(tab.state_at ?? '');
  if (!Number.isFinite(since) || Date.now() - since < STALE_WORKING_MS) return false;
  try {
    const { text } = await readScreen(ctx, { tab_id: tab.id, lines: SCREEN_STATE_LINES + 20 }, { plain: true });
    return claudeScreenState(text) === 'prompt';
  } catch {
    return false;
  }
}

/**
 * The default allowance (TER-627) that covers this call, as the synthetic grant id it is audited under,
 * or null: what the chat does without asking for every user who did not restrict it in "Permissões do
 * chat". The standing grant's resolution and guards, owner-scoped, and stricter where a default reaches
 * further than a grant someone chose:
 * - terminal: an agent at work in the tab (`working`, `waiting_background`, `waiting_input` or `finished`) — typed text on a bare shell is
 *   `run_command` under another name — never `!`/control characters, never a permission (state or screen);
 * - close_tab: a stopped tab (`STOPPED_TAB_STATES`), or a `working` one the screen shows idle;
 * - link_tab_task: the tab resolves (the tool checks the card itself).
 * Tried last, after every grant of the person's own, so theirs are spent first. Budgeted per user and kind.
 */
async function defaultGrantCovering(ctx: ControlContext, call: GatedCall): Promise<string | null> {
  const kind = defaultKindOf(call.tool, call.args);
  if (!kind) return null;
  if (kind === 'terminal' && textOutsideGrant(call.args)) return null;
  if ((await ctx.repos.chatDefaultRestrictions.listForUser(ctx.scope.user.id)).has(kind)) return null;
  let tab: Tab | undefined;
  if (kind === 'link_tab_task') {
    [tab] = await ctx.repos.tabs.findByIdsForOwner([call.args.tab_id as string], ctx.scope.user.id);
    if (!tab) return null;
  } else {
    const target = await standingProjectOf(ctx.repos, ctx.scope.user.id, kind, call.tool, call.args);
    if (!target) return null;
    tab = target.tab;
  }
  if (kind === 'terminal' && tab?.state !== 'working' && tab?.state !== 'waiting_background' && tab?.state !== 'waiting_input' && tab?.state !== 'finished') return null;
  if (kind === 'close_tab' && !(tab && (STOPPED_TAB_STATES.has(tab.state ?? '') || (tab.state === 'working' && (await idleDespiteWorking(ctx, tab)))))) return null;
  const grantId = defaultGrantId(ctx.scope.user.id, kind);
  const used = await ctx.repos.chatActions.countByGrantSince(grantId, new Date(Date.now() - STANDING_BUDGET_WINDOW_MS));
  if (used >= DEFAULT_ALLOW_BUDGETS[kind]) return null;
  if (kind === 'terminal' && (await permissionOnScreen(ctx, tab!.id))) return null;
  return grantId;
}

/**
 * `actionClass`, plus what only the current state can tell (TER-975): a `set_automation_policy` change is a
 * brake or a widening only against the Setup it changes. A brake goes through like `pause_automation`; a
 * widening keeps the static `write`, which no grant or default covers, so the person is always asked. Only
 * on a gated token: anyone else's call runs unmediated anyway.
 */
async function classOf(ctx: ControlContext, call: GatedCall): Promise<ActionClass> {
  const cls = actionClass(call.tool, call.args);
  if (call.token.gated && cls === 'write' && call.tool === 'set_automation_policy' && (await automationCallIsBrake(ctx, call.args))) return 'self_mediated';
  return cls;
}

/** The gate itself: run the call, or answer why it did not run. */
export async function applyGate(ctx: ControlContext, call: GatedCall): Promise<GateOutcome> {
  const cls = await classOf(ctx, call);
  // Reads are never gated, whatever the token; and a person's own MCP session acts unmediated —
  // they are the one calling, and asking them to confirm their own keystroke is nonsense. A
  // self-mediated call (spec 2026-09-26 concierge memory D13) is let through the same way even on a
  // gated token: its own effect is already the mediation (a visible, forgettable note; a cancellable
  // countdown, or a suggestion), so a confirmation card here would only double the question.
  if (cls === 'read' || cls === 'self_mediated' || !call.token.gated) return { ok: true, value: await call.run() };

  // The token names the conversation it was minted for (spec 2026-09-23 §4.2): that is the chat the
  // question belongs in. A gated token with none predates per-conversation tokens (24 h at most) and
  // can only have come from the account-wide chat.
  const conversationId = call.token.chat_conversation_id ?? (await ctx.repos.chat.getOrCreateForUser(ctx.scope.user.id)).id;
  const key = idempotencyKeyFor(conversationId, call.tool, call.args);
  const open = await ctx.repos.chatActions.findOpenByKey(conversationId, key);
  // An approval is only an approval while it is fresh (`APPROVAL_HOLDS_MS`). An older one is retired
  // here, before any decision is taken on it, so a "yes" nobody consumed can never authorise a write
  // days after the fact. A stale `pending` row is not this branch's business: it keeps waiting until
  // the hourly sweep expires it, which is what makes the same question askable again.
  if (open?.status === 'approved' && !approvalInForce(open)) return expireApproval(ctx, open);
  // The open row decides; with none, a recent "no" to the same proposal still does. Anything else —
  // no row, an executed one, a question left to expire, a denial older than the window — is asked.
  const row = open ?? (await denialInForce(ctx, conversationId, key));

  const decision = gateDecision(row, cls);
  // `allow` and `refuse` only come back with a row (without one the decision is `ask`), so the guard
  // on `row` narrows the type rather than adding a branch of its own.
  if (!row || decision === 'ask') {
    // Only where the gate would otherwise ask: an open row or a "no" still in force decided above.
    if (!row && grantable(call.tool, call.args) && !textOutsideGrant(call.args)) {
      const grant = await ctx.repos.chatGrants.findActive(conversationId, call.args.tab_id, GRANTABLE_TOOL);
      if (grant && (await grantCoversTab(ctx, call.args.tab_id))) return executeGranted(ctx, call, conversationId, key, cls, grant.id);
    }
    // Wider, and tried after the narrow grant so agent chatter stays off the terminal budget.
    if (!row && terminalGrantable(call.tool, call.args) && !textOutsideGrant(call.args)) {
      const grantId = await terminalGrantCovering(ctx, conversationId, call.args.tab_id);
      if (grantId) return executeGranted(ctx, call, conversationId, key, cls, grantId);
    }
    if (!row && boardGrantable(call.tool)) {
      const grantId = await projectGrantCovering(ctx, conversationId, call);
      if (grantId) return executeGranted(ctx, call, conversationId, key, cls, grantId);
    }
    // Last, the standing grants (TER-386): after every conversation-bound one, so their budgets are spent first.
    if (!row) {
      const grantId = await standingGrantCovering(ctx, call);
      if (grantId) return executeGranted(ctx, call, conversationId, key, cls, grantId);
    }
    // Then the defaults every user gets unless they restricted them (TER-627).
    if (!row) {
      const grantId = await defaultGrantCovering(ctx, call);
      if (grantId) return executeGranted(ctx, call, conversationId, key, cls, grantId);
    }
    return ask(ctx, call, conversationId, key, cls);
  }
  if (decision === 'waiting') {
    // Asked again while the card still waits (TER-477): bring it back where the person is reading.
    // Best effort — a failure here leaves the card where it was and the answer as before.
    try {
      const { actions } = await resurfaceCards(ctx.repos, ctx.scope.user.id, conversationId, { actionIds: [row.id], questions: false });
      if (actions.length > 0) return RESURFACED;
    } catch {
      // the card stays where it was
    }
    return WAITING;
  }
  if (decision === 'allow') return execute(ctx, call, row);
  return REFUSED;
}
