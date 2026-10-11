import { parseRef } from '../memory/refs.js';
import type { InputOrigin } from '../terminal/input-origin.js';
import { msg, type LocalizedText } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';

/** How old a chat message may be to back an order relayed on the person's behalf (decision 10.3). */
export const ON_BEHALF_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * `send_input`'s `on_behalf_of` (TER-851, spec §4.1): refs to the person's chat messages that the
 * concierge says it is relaying. Only the chat's gated token may pass them. Each ref must name a
 * `message` memory item of this user (only what the person typed is indexed as one, never an injected
 * wake or the assistant's answer) whose chat message is still there and at most `ON_BEHALF_MAX_AGE_MS`
 * old. The id may be the item's (what `search_memory` returns) or the chat message's own (TER-1037: the
 * ref the chat hands the concierge with each message the person typed); either way the item must exist.
 * Returns the chat message ids, in the order given; any bad ref fails the whole call.
 */
export async function verifyOnBehalfOf(ctx: ControlContext, refs: string[] | undefined): Promise<string[] | undefined> {
  if (!refs || refs.length === 0) return undefined;
  if (!ctx.token?.gated) throw new ControlError('ON_BEHALF_NOT_ALLOWED', msg('on_behalf_of só vale no chat do termhub: só ele tem as mensagens da pessoa'));
  const invalid = (ref: string, why: LocalizedText) =>
    new ControlError('ON_BEHALF_INVALID', msg('on_behalf_of: {{ref}} {{why}}. Use a ref message:… que acompanha a mensagem da pessoa, ou a que o search_memory devolve, de uma mensagem das últimas 24 h.', { ref, why }));
  const parsed = refs.map((ref) => ({ ref, parsed: parseRef(ref) }));
  for (const p of parsed) if (p.parsed?.kind !== 'message') throw invalid(p.ref, msg('não é uma mensagem do chat'));
  const userId = ctx.scope.user.id;
  const ids = parsed.map((p) => p.parsed!.id);
  const [byItem, bySource] = await Promise.all([ctx.repos.memoryItems.findManyForOwner(ids, userId), ctx.repos.memoryItems.findMessagesBySource(ids, userId)]);
  const itemById = new Map(byItem.map((it) => [it.id, it]));
  for (const it of bySource) if (!itemById.has(it.source_id)) itemById.set(it.source_id, it);
  const sourceIds = parsed.map((p) => {
    const item = itemById.get(p.parsed!.id);
    if (!item || item.kind !== 'message' || item.trust !== 'person') throw invalid(p.ref, msg('não existe'));
    return { ref: p.ref, messageId: item.source_id };
  });
  const messages = await ctx.repos.chat.findUserMessagesForUser([...new Set(sourceIds.map((s) => s.messageId))], userId);
  const messageById = new Map(messages.map((m) => [m.id, m]));
  const now = Date.now();
  for (const s of sourceIds) {
    const message = messageById.get(s.messageId);
    if (!message) throw invalid(s.ref, msg('não existe'));
    const at = Date.parse(message.created_at);
    if (!(Number.isFinite(at) && now - at <= ON_BEHALF_MAX_AGE_MS)) throw invalid(s.ref, msg('é de mais de 24 h atrás'));
  }
  return [...new Set(sourceIds.map((s) => s.messageId))];
}

/**
 * Who wrote a text typed through `ctx` (spec §5.2), when the caller did not say: a confirmation card the
 * person clicked (`ctx.approval`) is their approval of the exact text; the chat's token is the assistant,
 * or the person's request when `on_behalf_of` checked out; any other token is an MCP client; no token is
 * the person in a termhub screen.
 */
export function deriveInputOrigin(ctx: ControlContext, onBehalfOf?: string[]): InputOrigin {
  const userId = ctx.scope.user.id;
  if (ctx.approval) return { level: 'person_approved', userId, actionId: ctx.approval.actionId, approvedAt: ctx.approval.approvedAt };
  if (ctx.token?.gated) return onBehalfOf && onBehalfOf.length > 0 ? { level: 'person_requested', userId, messageIds: onBehalfOf } : { level: 'assistant', userId };
  if (ctx.token) return { level: 'mcp_client', userId, tokenId: ctx.token.id };
  return { level: 'person_typed', userId, surface: 'web' };
}
