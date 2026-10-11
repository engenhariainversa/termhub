// How one live event of the open conversation changes its thread (design spec §6): pure reducers
// over the slice the chat store keeps — the thread's messages and actions and the `live` fold of the
// answer being written. The store decides which events reach here (`belongsTo`) and does the I/O.
import type { TChatAttachment } from '@/services/api/contract';
import { applyLive, type LiveFold } from './live';
import { upsertSubagent } from './subagents';
import { upsertTabLimit } from './tab-limit-text';
import { upsertTabSuggestion } from './tab-suggestion-text';
import type { ChatAction, ChatEvent, ChatGrant, ChatMessage, ChatProjectGrant, ChatStandingGrant, SubagentView, TabLimit, TabQuestion, TabSuggestion } from './types';

export interface EventSlice {
  messages: ChatMessage[];
  actions: ChatAction[];
  /** The answer being written: streamed text, tool calls and started rows, by message id. */
  live: LiveFold;
  /** The conversation's trusted tabs; at most one per tab (a new grant replaces the old one). */
  grants: ChatGrant[];
  /** The conversation's trusted projects' boards ("Permitir sempre neste projeto"); at most one per
   * project (a new grant replaces the old one). */
  projectGrants: ChatProjectGrant[];
  /** The tabs' questions pushed into this conversation (spec 2026-09-25 §6.3). */
  tabQuestions: TabQuestion[];
  /** The tabs' suggestions pushed into this conversation (spec 2026-09-25 tab suggestions §6.4). */
  tabSuggestions: TabSuggestion[];
  /** The usage-limit cards of the project's tabs (spec 2026-09-30 project AI accounts §7.2). */
  tabLimits: TabLimit[];
  /** The subagents panel of this conversation, newest first (spec 2026-09-26 panel §4). */
  subagents: SubagentView[];
  /** Ids whose "Cancelar" came back with `subagent_cancel_failed`, or any other cancel failure the
   * store marks the same way (spec 2026-09-26 panel §5.4); cleared once a fresh `subagent` event
   * for that id arrives. */
  cancelFailed: string[];
}

const NO_ATTACHMENTS: readonly TChatAttachment[] = [];

/** The web's `sameAttachments`: what a stored attachment can change after the phone first saw it (an extraction ended, or gave up). */
function sameAttachments(a: readonly TChatAttachment[] = NO_ATTACHMENTS, b: readonly TChatAttachment[] = NO_ATTACHMENTS): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i]!.id && x.status === b[i]!.status && x.error_code === b[i]!.error_code);
}

const isAnswered = (m: ChatMessage): boolean => m.role === 'assistant' && (Boolean(m.text) || Boolean(m.error_code));
const isEmptyAnswer = (m: ChatMessage): boolean => m.role === 'assistant' && !m.text && !m.error_code;

/**
 * The web's `lib/chat-merge.ts` (`mergeMessage`): `msg` into `list` by id — appended when new,
 * replaced when something changed, and the very same `list` (same row objects) when nothing did, so
 * a memoised row keeps its props. `usage` is the server's JSON: compared by value. Attachments count
 * too: a re-read is how a status event the phone missed (backgrounded, offline) gets corrected.
 * A final answer is never replaced by an empty one.
 */
export function mergeMessage(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = list.findIndex((m) => m.id === msg.id);
  if (i < 0) return [...list, msg];
  const old = list[i]!;
  // An answer never goes from final back to empty: the empty version is older, whatever brought it.
  if (isAnswered(old) && isEmptyAnswer(msg)) return list;
  const same =
    old.text === msg.text && old.error_code === msg.error_code && old.created_at === msg.created_at && JSON.stringify(old.usage ?? null) === JSON.stringify(msg.usage ?? null) && sameAttachments(old.attachments, msg.attachments) && JSON.stringify(old.notice ?? null) === JSON.stringify(msg.notice ?? null);
  if (same) return list;
  // The server's version never carries the row's list key: it keeps the one this device gave it (TER-1001).
  const next = old.row_key !== undefined && msg.row_key === undefined ? { ...msg, row_key: old.row_key } : msg;
  return list.map((m, j) => (j === i ? next : m));
}

/**
 * The rows of the thread on screen that a re-read of the same conversation drops (the web's
 * `droppedRows`): the snapshot lacks them, they are not this device's own, and their `message`
 * event did not reach the store while the read was in flight. The server deleted them (an answer
 * that never started, a `message_removed` missed while the socket was down, a server that predates
 * that event), so nothing will ever answer them: the caller closes them in the fold.
 */
export function droppedRows(current: readonly ChatMessage[], server: readonly ChatMessage[], arrived: ReadonlySet<string>): string[] {
  const ids = new Set(server.map((m) => m.id));
  return current.filter((m) => !ids.has(m.id) && m.local === undefined && !arrived.has(m.id)).map((m) => m.id);
}

/**
 * A re-read's snapshot into the thread it refreshes (same conversation, spec 2026-09-29 §5): a row
 * the phone saw removed is left out of the snapshot; every other server row merges by id
 * (`mergeMessage`: the server's version wins, except an empty one over a final one, and untouched
 * rows keep their objects); a row the snapshot lacks stays when it is this device's own (`local`) or
 * its `message` event reached the store while the GET was in flight (`arrived`), and goes otherwise
 * (the server no longer has it). The very same `current` back when nothing changed.
 *
 * Not a comparison of `created_at` with the snapshot's newest row: an answer is always newer than its
 * question, so a deleted answer would pass it and stay on screen for good.
 */
export function mergeThread(current: ChatMessage[], server: ChatMessage[], removed: ReadonlySet<string>, arrived: ReadonlySet<string>): ChatMessage[] {
  const listed = removed.size === 0 ? server : server.filter((m) => !removed.has(m.id));
  const ids = new Set(listed.map((m) => m.id));
  const kept = current.filter((m) => ids.has(m.id) || m.local !== undefined || (arrived.has(m.id) && !removed.has(m.id)));
  return listed.reduce(mergeMessage, kept.length === current.length ? current : kept);
}

/**
 * The messages with `attachment` replaced by id inside whichever message carries it (the web's
 * `patchMessageAttachment`); the same array, and the same message objects, when nothing changed.
 */
export function patchMessageAttachment(messages: ChatMessage[], attachment: TChatAttachment): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    const list = m.attachments;
    if (!list) return m;
    const i = list.findIndex((a) => a.id === attachment.id);
    if (i < 0) return m;
    const current = list[i]!;
    if (current.status === attachment.status && current.error_code === attachment.error_code && JSON.stringify(current.meta) === JSON.stringify(attachment.meta)) return m;
    changed = true;
    return { ...m, attachments: list.map((a, j) => (j === i ? attachment : a)) };
  });
  return changed ? next : messages;
}

/** Settles the pending action `id` as approved or denied. A card that has moved on already — a
 * re-read that says it ran, failed or expired — is never moved back; the same array when nothing
 * changes (idempotent). */
export function settlePending(actions: ChatAction[], id: string, status: 'approved' | 'denied'): ChatAction[] {
  if (!actions.some((a) => a.id === id && a.status === 'pending')) return actions;
  return actions.map((a) => (a.id === id ? { ...a, status } : a));
}

/** Every tab-question event carries the whole card: replace it by id, or append it. */
export function upsertTabQuestion(list: TabQuestion[], q: TabQuestion): TabQuestion[] {
  return list.some((x) => x.id === q.id) ? list.map((x) => (x.id === q.id ? q : x)) : [...list, q];
}

function actionFromConfirmation(e: Extract<ChatEvent, { type: 'confirmation' }>): ChatAction {
  return {
    id: e.action_id,
    tool: e.tool,
    args: e.args,
    class: e.class,
    status: 'pending',
    machine_id: e.machine_id,
    project_id: e.project_id,
    tab_id: e.tab_id,
    grant_id: null,
    summary: e.summary,
    // Which subagent's turn proposed it (spec 2026-09-26 §4), when there is one — carried through
    // verbatim, including its absence (`undefined`) on an older server.
    subagent: e.subagent,
    created_at: e.created_at,
    // Carried through verbatim, like `subagent`: absent on an older server (spec 2026-09-30 §2.2).
    ...(e.surfaced_at !== undefined ? { surfaced_at: e.surfaced_at } : {}),
  };
}

/**
 * The slice after `e` — the same object for an event that changes nothing. A `message` merges by id
 * and asks for no re-read (spec §4.2 "Merge on message"): the event is the row; only a reconnect
 * re-reads the thread, in the store.
 */
export function applyEvent(slice: EventSlice, e: ChatEvent): EventSlice {
  switch (e.type) {
    case 'message': {
      const messages = mergeMessage(slice.messages, e.message);
      const live = applyLive(slice.live, e);
      return messages === slice.messages && live === slice.live ? slice : { ...slice, messages, live };
    }
    case 'confirmation': {
      const existing = slice.actions.find((a) => a.id === e.action_id);
      if (!existing) return { ...slice, actions: [...slice.actions, actionFromConfirmation(e)] };
      // The live run learned which subagent proposed a card already on screen, after the card was
      // already published with none (spec 2026-09-26 §4), or the card was brought back to the end of
      // the thread (`surfaced_at`, spec 2026-09-30 §2.2): merged in, the card's status untouched. A
      // repeat with nothing new changes nothing.
      const subagent = e.subagent ?? existing.subagent;
      const surfacedAt = e.surfaced_at ?? existing.surfaced_at;
      if (subagent === existing.subagent && surfacedAt === existing.surfaced_at) return slice;
      return { ...slice, actions: slice.actions.map((a) => (a.id === e.action_id ? { ...a, subagent, surfaced_at: surfacedAt } : a)) };
    }
    case 'decision': {
      const actions = settlePending(slice.actions, e.action_id, e.status);
      return actions === slice.actions ? slice : { ...slice, actions };
    }
    case 'action_status': {
      // The gate ran, failed or expired a card (spec 2026-09-30 §2.3): the card reads so live. An id
      // this slot does not hold (another device's, or older than the loaded window) changes nothing.
      const current = slice.actions.find((a) => a.id === e.action_id);
      if (!current || (current.status === e.status && current.error_code === e.error_code)) return slice;
      return { ...slice, actions: slice.actions.map((a) => (a === current ? { ...a, status: e.status, error_code: e.error_code } : a)) };
    }
    case 'grant':
      // One active grant per (tab, tool), as on the server: a narrow grant never drops a terminal one.
      return { ...slice, grants: [...slice.grants.filter((g) => g.id !== e.grant.id && !(g.tab_id === e.grant.tab_id && g.tool === e.grant.tool)), e.grant] };
    case 'grant_revoked':
      return { ...slice, grants: slice.grants.filter((g) => g.id !== e.grant_id) };
    case 'project_grant':
      return { ...slice, projectGrants: [...slice.projectGrants.filter((g) => g.id !== e.grant.id && g.project_id !== e.grant.project_id), e.grant] };
    case 'project_grant_revoked':
      return { ...slice, projectGrants: slice.projectGrants.filter((g) => g.id !== e.grant_id) };
    case 'granted_action':
      // A send_input run under a grant never asked: its card arrives whole, already executed.
      return { ...slice, actions: slice.actions.some((a) => a.id === e.action.id) ? slice.actions.map((a) => (a.id === e.action.id ? e.action : a)) : [...slice.actions, e.action] };
    case 'tab_question':
    case 'tab_question_answered':
    case 'tab_question_closed':
      return { ...slice, tabQuestions: upsertTabQuestion(slice.tabQuestions, e.question) };
    case 'tab_suggestion':
    case 'tab_suggestion_closed':
      return { ...slice, tabSuggestions: upsertTabSuggestion(slice.tabSuggestions, e.suggestion) };
    case 'tab_limit':
    case 'tab_limit_closed':
      return { ...slice, tabLimits: upsertTabLimit(slice.tabLimits, e.notice) };
    case 'attachment_status': {
      const messages = patchMessageAttachment(slice.messages, e.attachment);
      return messages === slice.messages ? slice : { ...slice, messages };
    }
    case 'subagent': {
      const subagents = upsertSubagent(slice.subagents, e.subagent);
      // Whatever this row is now, a stale "Cancelar" failure from before no longer applies.
      const cancelFailed = slice.cancelFailed.includes(e.subagent.id) ? slice.cancelFailed.filter((id) => id !== e.subagent.id) : slice.cancelFailed;
      return subagents === slice.subagents && cancelFailed === slice.cancelFailed ? slice : { ...slice, subagents, cancelFailed };
    }
    case 'subagent_cancel_failed':
      return slice.cancelFailed.includes(e.subagent_id) ? slice : { ...slice, cancelFailed: [...slice.cancelFailed, e.subagent_id] };
    case 'delta':
    case 'action':
    case 'reset':
    case 'run_started':
    case 'run_finished': {
      const live = applyLive(slice.live, e);
      return live === slice.live ? slice : { ...slice, live };
    }
    case 'message_removed': {
      const live = applyLive(slice.live, e);
      const messages = slice.messages.some((m) => m.id === e.message_id) ? slice.messages.filter((m) => m.id !== e.message_id) : slice.messages;
      return messages === slice.messages && live === slice.live ? slice : { ...slice, messages, live };
    }
    default:
      return slice;
  }
}

/**
 * A standing grant ("Liberar sem prazo", spec 2026-09-28 TER-386) is not bound to a conversation: its
 * two events apply to every slot that shows it, whatever conversation they are tagged with — the same
 * set `GET chat` returns (the slot's project, or all of them in the account-wide chat, `slotProject`
 * null); a revoke is applied by id. A re-grant of the same kind on the same project replaces the older
 * one, as on the server. The same array for an event that changes nothing here.
 */
export function applyStandingGrantEvent(grants: ChatStandingGrant[], slotProject: string | null, e: ChatEvent): ChatStandingGrant[] {
  if (e.type === 'standing_grant_revoked') return grants.some((g) => g.id === e.grant_id) ? grants.filter((g) => g.id !== e.grant_id) : grants;
  if (e.type !== 'standing_grant' || (slotProject !== null && e.grant.project_id !== slotProject)) return grants;
  return [...grants.filter((g) => g.id !== e.grant.id && !(g.project_id === e.grant.project_id && g.kind === e.grant.kind)), e.grant];
}
