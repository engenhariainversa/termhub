import type { z } from 'zod';
import type { chatGrantListQuery } from '@termhub/mobile-api';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import { describeGrantList, describeGrants, describeProjectGrantList, describeProjectGrants, describeStandingGrantList, describeStandingGrants, type ChatGrantListItem, type ChatGrantView, type ChatProjectGrantView, type ChatStandingGrantView } from '../db/repositories/chat-actions-view.js';
import { GRANT_LIST_MAX, type GrantCursor } from '../db/repositories/chat-grants.js';
import type { ProjectGrantScope } from '../db/repositories/chat-project-grants.js';
import type { Repositories } from '../db/repositories/index.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';
import { boardProjectOf } from './board-project.js';
import { chatBus } from './bus.js';
import { boardGrantable, fileGrantable, folderOf, grantable, GRANTABLE_TOOL, standingKindOf, TAB_TERMINAL_GRANT, terminalGrantable, type StandingGrantKind } from './gate.js';
import { standingProjectOf } from './standing-project.js';

/**
 * "Permitir sempre nesta aba" is only for what the gate will honour (`grantable`): checked on the row
 * as the user sees it, before anything is decided (and, on the phone, before the PIN challenge is
 * spent), so a refused request changes nothing. Owner-scoped: another user's row is a 404.
 */
export async function assertGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<ChatAction> {
  const row = await pendingRow(repos, userId, actionId);
  if (!grantable(row.tool, (row.args ?? {}) as Record<string, unknown>)) throw new HttpError(400, 'Só dá para permitir sempre o envio de texto para uma aba', 'GRANT_NOT_ALLOWED');
  return row;
}

/** Trusts the tab of an action the user just approved, and tells every open screen (web and phone).
 * Created before the decision is re-injected, so the injected sentence can mention it. */
export async function grantTab(repos: Repositories, userId: string, action: ChatAction): Promise<ChatGrantView> {
  if (!action.tab_id) throw new HttpError(400, 'Só dá para permitir sempre o envio de texto para uma aba', 'GRANT_NOT_ALLOWED');
  const created = await repos.chatGrants.grant({ conversation_id: action.conversation_id, tab_id: action.tab_id, tool: GRANTABLE_TOOL, source_action_id: action.id, granted_by: userId });
  const [grant] = await describeGrants(repos, [created], userId);
  chatBus.publish({ type: 'grant', user_id: userId, conversation_id: action.conversation_id, grant });
  return grant;
}

const TAB_TERMINAL_GRANT_NOT_ALLOWED = () => new HttpError(400, 'Só dá para liberar teclas e shell numa ação de terminal de uma aba sua', 'GRANT_NOT_ALLOWED');

/** The pending row a grant button applies to, owner-scoped: 404 unknown or another user's, 409 decided. */
async function pendingRow(repos: Repositories, userId: string, actionId: string): Promise<ChatAction> {
  const row = await repos.chatActions.findByIdForUser(actionId, userId);
  if (!row) throw notFound('Ação não encontrada');
  if (row.status !== 'pending') throw conflict('Esta ação já foi decidida');
  return row;
}

/** The owner-scoped tab of a terminal card (`terminalGrantable`), read with the caller's own user id
 * exactly as the gate reads it — or undefined when the card is not one, or the tab does not resolve. */
async function terminalTabOf(repos: Repositories, userId: string, row: ChatAction) {
  if (!row.tab_id || !terminalGrantable(row.tool, (row.args ?? {}) as Record<string, unknown>)) return undefined;
  const [tab] = await repos.tabs.findByIdsForOwner([row.tab_id], userId);
  return tab;
}

/** "Liberar teclas e shell nesta aba" (spec 2026-09-27 TER-325) only for a pending send_key/send_input
 * card on a tab of this user's, never one answering a permission: checked before anything is decided
 * (and, on the phone, before the PIN challenge is spent), so a refused request changes nothing. */
export async function assertTabTerminalGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<ChatAction> {
  const row = await pendingRow(repos, userId, actionId);
  if (!(await terminalTabOf(repos, userId, row))) throw TAB_TERMINAL_GRANT_NOT_ALLOWED();
  return row;
}

/** Trusts the tab of an action the user just approved for every key and any typed text, and tells every
 * open screen. The wider level replaces a narrow "Permitir sempre nesta aba" of the same conversation and
 * tab: that one is revoked first (and screens told), so the strip never shows both. Created before the
 * decision is re-injected, so the injected sentence can mention it. */
export async function grantTabTerminal(repos: Repositories, userId: string, action: ChatAction): Promise<ChatGrantView> {
  if (!action.tab_id) throw TAB_TERMINAL_GRANT_NOT_ALLOWED();
  const narrow = await repos.chatGrants.findActive(action.conversation_id, action.tab_id, GRANTABLE_TOOL);
  const revoked = await repos.chatGrants.revokeTool(action.conversation_id, action.tab_id, GRANTABLE_TOOL, userId);
  if (narrow && revoked > 0) chatBus.publish({ type: 'grant_revoked', user_id: userId, conversation_id: action.conversation_id, grant_id: narrow.id });
  const created = await repos.chatGrants.grant({ conversation_id: action.conversation_id, tab_id: action.tab_id, tool: TAB_TERMINAL_GRANT, source_action_id: action.id, granted_by: userId });
  const [grant] = await describeGrants(repos, [created], userId);
  chatBus.publish({ type: 'grant', user_id: userId, conversation_id: action.conversation_id, grant });
  return grant;
}

/** TER-1153: the grant button of a card whose project (or tab, or card) no longer resolves for this user —
 * gone, or never theirs. Says what to do rather than the rule; the screens no longer offer the button
 * for such a card (`target_gone`), so this answers an older screen or a card that went stale while open. */
const GRANT_TARGET_GONE = () => new HttpError(400, 'Este pedido é de um projeto, aba ou tarefa que não existe mais, então não dá para liberar nada a partir dele. Recuse e peça de novo ao chat no projeto certo.', 'GRANT_NOT_ALLOWED');

const PROJECT_GRANT_NOT_ALLOWED = () => new HttpError(400, 'Só dá para permitir sempre neste projeto ações de quadro de um projeto seu', 'GRANT_NOT_ALLOWED');

/** "Permitir sempre neste projeto" only for a pending board card whose project resolves (spec 2026-09-26
 * project grant §5): checked before anything is decided, and before the phone's PIN challenge is spent.
 * Resolved with the caller's own user id, exactly as the gate does — never a "view as" owner id — so
 * the button is accepted for exactly the grants the gate will honour. */
export async function assertProjectGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<{ action: ChatAction; projectId: string }> {
  const row = await pendingRow(repos, userId, actionId);
  if (!boardGrantable(row.tool)) throw PROJECT_GRANT_NOT_ALLOWED();
  const projectId = await boardProjectOf(repos, userId, row.tool, (row.args ?? {}) as Record<string, unknown>);
  if (!projectId) throw GRANT_TARGET_GONE();
  return { action: row, projectId };
}

const PROJECT_ALL_GRANT_NOT_ALLOWED = () => new HttpError(400, 'Só dá para liberar tudo neste projeto numa ação de quadro ou de terminal de um projeto seu', 'GRANT_NOT_ALLOWED');

/** "Liberar tudo neste projeto" (spec 2026-09-27 TER-325): a pending board card whose project resolves
 * (as `assertProjectGrantableAction`), or a pending terminal card whose tab is this user's — the tab's
 * project is the one trusted. Checked before anything is decided and before the phone's PIN challenge
 * is spent, with the caller's own user id, exactly as the gate resolves it. */
export async function assertProjectAllGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<{ action: ChatAction; projectId: string }> {
  const row = await pendingRow(repos, userId, actionId);
  let projectId: string | null | undefined;
  if (boardGrantable(row.tool)) projectId = await boardProjectOf(repos, userId, row.tool, (row.args ?? {}) as Record<string, unknown>);
  else if (terminalGrantable(row.tool, (row.args ?? {}) as Record<string, unknown>) && row.tab_id) projectId = (await terminalTabOf(repos, userId, row))?.project_id ?? null;
  else throw PROJECT_ALL_GRANT_NOT_ALLOWED();
  if (!projectId) throw GRANT_TARGET_GONE();
  return { action: row, projectId };
}

/** Trusts the project of an action the user just approved — its board (`board`), or its board and its
 * tabs' keys and typing (`all`) — and tells every open screen (web and phone). Created before the
 * decision is re-injected, so the injected sentence can mention it. */
export async function grantProject(repos: Repositories, userId: string, action: ChatAction, projectId: string, scope: ProjectGrantScope = 'board'): Promise<ChatProjectGrantView> {
  const created = await repos.chatProjectGrants.grant({ conversation_id: action.conversation_id, project_id: projectId, source_action_id: action.id, granted_by: userId, scope });
  const [grant] = await describeProjectGrants(repos, [created], userId);
  chatBus.publish({ type: 'project_grant', user_id: userId, conversation_id: action.conversation_id, grant });
  return grant;
}

/** The conversation's project grants still in force, as `GET /chat` (web and phone) returns them. */
export async function activeProjectGrants(repos: Repositories, userId: string, conversationId: string): Promise<ChatProjectGrantView[]> {
  return describeProjectGrants(repos, await repos.chatProjectGrants.listActive(conversationId), userId);
}

const STANDING_GRANT_NOT_ALLOWED = () => new HttpError(400, 'Só dá para liberar sem prazo uma ação de rotina de um projeto seu', 'GRANT_NOT_ALLOWED');

/** "Liberar sem prazo" (spec 2026-09-28 TER-386) only for a pending card of a standing kind
 * (`standingKindOf`) whose project resolves — for a tab-borne kind, whose tab is this user's. Checked
 * before anything is decided and before the phone's PIN challenge is spent, with the caller's own user id
 * and the gate's own resolver (`standingProjectOf`), so the button is accepted for exactly the grants the
 * gate will honour. */
export async function assertStandingGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<{ action: ChatAction; kind: StandingGrantKind; projectId: string }> {
  const row = await pendingRow(repos, userId, actionId);
  const args = (row.args ?? {}) as Record<string, unknown>;
  const kind = standingKindOf(row.tool, args);
  if (!kind) throw STANDING_GRANT_NOT_ALLOWED();
  const resolved = await standingProjectOf(repos, userId, kind, row.tool, args);
  if (!resolved) throw GRANT_TARGET_GONE();
  return { action: row, kind, projectId: resolved.projectId };
}

/** Trusts one kind of routine action in the project of an action the user just approved, with no expiry,
 * and tells every open screen (web and phone). Created before the decision is re-injected, so the
 * injected sentence can mention it. */
export async function grantStanding(repos: Repositories, userId: string, action: ChatAction, kind: StandingGrantKind, projectId: string): Promise<ChatStandingGrantView> {
  const created = await repos.chatStandingGrants.grant({ user_id: userId, project_id: projectId, kind, conversation_id: action.conversation_id, source_action_id: action.id });
  const [grant] = await describeStandingGrants(repos, [created], userId);
  chatBus.publish({ type: 'standing_grant', user_id: userId, conversation_id: action.conversation_id, grant });
  return grant;
}

const FILE_GRANT_NOT_ALLOWED = () => new HttpError(400, 'Só dá para permitir sempre uma pasta ao compartilhar um arquivo de uma máquina sua', 'GRANT_NOT_ALLOWED');

/** "Permitir sempre nesta pasta" (TER-1086) only for a pending `share_file` card naming one of this user's
 *  machines. Checked before anything is decided and before the phone's PIN challenge is spent. Answers the
 *  folder it trusts: the one the file sits in, as the card showed it. */
export async function assertFileGrantableAction(repos: Repositories, userId: string, actionId: string): Promise<{ action: ChatAction; machineId: string; folder: string }> {
  const row = await pendingRow(repos, userId, actionId);
  const args = (row.args ?? {}) as Record<string, unknown>;
  if (!fileGrantable(row.tool, args)) throw FILE_GRANT_NOT_ALLOWED();
  const machine = await repos.machines.findById(args.machine_id);
  if (!machine || machine.owner_id !== userId) throw FILE_GRANT_NOT_ALLOWED();
  const folder = folderOf(args.path);
  // "/" or "~" would trust every file of the machine: never a folder grant.
  if (folder === '/' || folder === '~' || folder === '.') throw FILE_GRANT_NOT_ALLOWED();
  return { action: row, machineId: machine.id, folder };
}

/** What a folder grant looks like to the screens: the machine by name. */
export interface ChatFileGrantResponse {
  id: string;
  machine_id: string;
  machine_name: string;
  folder: string;
  created_at: string;
}

/** Trusts the folder of a `share_file` the user just approved, with no expiry. No live event: the card
 *  answers it, and the permissions screen reads the list on its own. */
export async function grantFolder(repos: Repositories, userId: string, action: ChatAction, machineId: string, folder: string): Promise<ChatFileGrantResponse> {
  const created = await repos.chatFileGrants.grant({ user_id: userId, machine_id: machineId, folder, conversation_id: action.conversation_id, source_action_id: action.id });
  const machine = await repos.machines.findById(machineId);
  return { id: created.id, machine_id: machineId, machine_name: machine?.name ?? '', folder, created_at: created.created_at };
}

/** The user's folder grants in force, newest first. */
export async function activeFileGrants(repos: Repositories, userId: string): Promise<ChatFileGrantResponse[]> {
  return (await repos.chatFileGrants.listActive(userId)).map((g) => ({ id: g.id, machine_id: g.machine_id, machine_name: g.machine_name, folder: g.folder, created_at: g.created_at }));
}

/** The user's standing grants in force, as `GET /chat` (web and phone) returns them: the conversation's
 * project's, or — for the general chat (`null`) — all of them. */
export async function activeStandingGrants(repos: Repositories, userId: string, projectId: string | null): Promise<ChatStandingGrantView[]> {
  return describeStandingGrants(repos, await repos.chatStandingGrants.listActive(userId, projectId ?? undefined), userId);
}

/** "Revogar", any kind: tab grants first, then project grants, then standing grants (ids never collide).
 * 404 unknown or not this user's, 409 already revoked. A standing grant whose granting conversation is
 * gone publishes no event: the list screen re-reads on its own and an open chat drops it on its next
 * `GET /chat` (spec 2026-09-28 §5). */
export async function revokeGrant(repos: Repositories, userId: string, grantId: string): Promise<ChatGrantView | ChatProjectGrantView | ChatStandingGrantView> {
  const tab = await repos.chatGrants.revoke(grantId, userId);
  if (tab) {
    chatBus.publish({ type: 'grant_revoked', user_id: userId, conversation_id: tab.conversation_id, grant_id: tab.id });
    return (await describeGrants(repos, [tab], userId))[0];
  }
  const project = await repos.chatProjectGrants.revoke(grantId, userId);
  if (project) {
    chatBus.publish({ type: 'project_grant_revoked', user_id: userId, conversation_id: project.conversation_id, grant_id: project.id });
    return (await describeProjectGrants(repos, [project], userId))[0];
  }
  const standing = await repos.chatStandingGrants.revoke(grantId, userId);
  if (standing) {
    if (standing.conversation_id) chatBus.publish({ type: 'standing_grant_revoked', user_id: userId, conversation_id: standing.conversation_id, grant_id: standing.id });
    return (await describeStandingGrants(repos, [standing], userId))[0];
  }
  const existing =
    (await repos.chatGrants.findByIdForUser(grantId, userId)) ?? (await repos.chatProjectGrants.findByIdForUser(grantId, userId)) ?? (await repos.chatStandingGrants.findByIdForUser(grantId, userId));
  throw existing ? conflict('Esta permissão já foi revogada') : notFound('Permissão não encontrada');
}

/** The conversation's grants still in force, as `GET /chat` (web and phone) returns them. */
export async function activeGrants(repos: Repositories, userId: string, conversationId: string): Promise<ChatGrantView[]> {
  return describeGrants(repos, await repos.chatGrants.listActive(conversationId), userId);
}

const INVALID_CURSOR = () => new HttpError(400, 'Cursor inválido', 'INVALID_CURSOR');

/** Opaque to clients: base64url of `<created_at ISO>|<id>`. */
export const encodeGrantCursor = (c: GrantCursor): string => Buffer.from(`${c.created_at}|${c.id}`, 'utf8').toString('base64url');

/** The inverse, strictly: anything that is not exactly what `encodeGrantCursor` makes is a 400, never an
 * unfiltered page. */
export function decodeGrantCursor(s: string): GrantCursor {
  const raw = Buffer.from(s, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  if (sep <= 0) throw INVALID_CURSOR();
  const created_at = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const t = Date.parse(created_at);
  if (!id || id.length > 64 || !Number.isFinite(t) || new Date(t).toISOString() !== created_at) throw INVALID_CURSOR();
  return { created_at, id };
}

/** "Abas confiáveis" (spec 2026-09-26 §3.3): one page of this user's grants, web and phone alike.
 * `active` is never paged — the repository caps it at `GRANT_LIST_MAX` on its own, and this always
 * asks for that same cap rather than the query's `limit`, so the query's default (50) can never
 * silently truncate the active list.
 *
 * `kinds: 'all'` (spec 2026-09-26 project grant §5) adds project grants: both tables are read with the
 * same cursor and `limit` each (each returns at most `limit` rows after the cursor, so the merged first
 * `limit` rows of both pages together are exactly the next page), merged newest first by `(created_at,
 * id)` and cut to `limit`; the cut row's own `(created_at, id)` is a valid cursor for both tables. An
 * old app that never sends `kinds` keeps seeing tab grants only.
 *
 * `kinds: 'all_standing'` (spec 2026-09-28 TER-386) reads standing grants too, the same way — three
 * tables, one cursor. Only an app that asks for it sees a row with no expiry (`all` stays tab + project). */
export async function listGrants(repos: Repositories, userId: string, query: z.infer<typeof chatGrantListQuery>, now = new Date()): Promise<{ grants: ChatGrantListItem[]; next_cursor: string | null }> {
  const cursor = query.cursor ? decodeGrantCursor(query.cursor) : null;
  const limit = query.state === 'active' ? GRANT_LIST_MAX : query.limit;
  const opts = { state: query.state, cursor, limit };
  const tabs = await repos.chatGrants.listForUser(userId, opts, now);
  const tabItems = await describeGrantList(repos, tabs.grants, userId, now);
  if (query.kinds !== 'all' && query.kinds !== 'all_standing') return { grants: tabItems, next_cursor: tabs.next ? encodeGrantCursor(tabs.next) : null };
  const projects = await repos.chatProjectGrants.listForUser(userId, opts, now);
  const standing = query.kinds === 'all_standing' ? await repos.chatStandingGrants.listForUser(userId, opts) : { grants: [], next: null };
  const merged = [...tabItems, ...(await describeProjectGrantList(repos, projects.grants, userId, now)), ...(await describeStandingGrantList(repos, standing.grants, userId))].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1,
  );
  const page = merged.slice(0, limit);
  const more = merged.length > limit || tabs.next !== null || projects.next !== null || standing.next !== null;
  const last = page[page.length - 1];
  return { grants: page, next_cursor: query.state === 'ended' && more && last ? encodeGrantCursor({ created_at: last.created_at, id: last.id }) : null };
}
