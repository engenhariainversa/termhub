/**
 * `get_chat_context` (TER-1038): the concierge reads how full its own CLI session is — the number the
 * chat's meter shows — instead of estimating it, so it can answer exactly and suggest compacting at the
 * right time. Only in the chat conversation the token was minted for.
 */
import { ControlError, type ControlContext } from './context.js';

/** From this share of the limit on, the meter turns amber and the concierge suggests compacting
 *  (the web and the phone use the same mark). */
export const CONTEXT_SUGGEST_AT = 0.8;

const NOT_IN_CHAT = () => new ControlError('NOT_IN_CHAT', 'Esta ferramenta só funciona no chat do termhub: ela lê o contexto da própria conversa.');

export interface ChatContextReport {
  /** Tokens in the session at the end of the last turn (or compaction); null before the first turn. */
  tokens: number | null;
  /** The model's context window, as the CLI reported it. */
  window: number | null;
  /** The person's own limit (Memória do chat), when they set one. */
  limit: number | null;
  /** What `share` is measured against: the person's limit, else the window. */
  measured_against: 'limit' | 'window' | null;
  /** 0–100, rounded; null when there is nothing to measure against. */
  percent: number | null;
  /** ISO time of the last compaction ("Compactar" or the CLI's auto-compact); null = never. */
  compacted_at: string | null;
  suggest_compact: boolean;
  note: string;
}

export async function getChatContext(ctx: ControlContext): Promise<ChatContextReport> {
  const conversationId = ctx.token?.chat_conversation_id;
  if (!conversationId) throw NOT_IN_CHAT();
  const userId = ctx.scope.user.id;
  const conversation = await ctx.repos.chat.findByIdForUser(conversationId, userId);
  if (!conversation) throw NOT_IN_CHAT();
  const limit = await ctx.repos.users.chatContextLimit(userId);
  const tokens = conversation.context_tokens;
  const window = conversation.context_window;
  const against = limit ?? window;
  const measured_against = limit !== null ? 'limit' : window !== null ? 'window' : null;
  const percent = tokens !== null && against ? Math.min(100, Math.round((tokens / against) * 100)) : null;
  const suggest_compact = tokens !== null && against !== null && against > 0 && tokens / against >= CONTEXT_SUGGEST_AT;
  const note =
    tokens === null
      ? 'Esta conversa ainda não tem medida de contexto: ela aparece ao fim do primeiro turno (ou depois de "Compactar").'
      : [
          'Medida ao fim do último turno, como o medidor do chat mostra; o turno atual ainda não está somado.',
          suggest_compact
            ? 'Passou de 80% do limite: sugira à pessoa compactar a conversa (botão "Compactar" no cabeçalho do chat ou /compact na caixa de mensagem). Você não compacta sozinho.'
            : 'Ainda há espaço: não é preciso compactar agora.',
        ].join(' ');
  return { tokens, window, limit, measured_against, percent, compacted_at: conversation.context_compacted_at, suggest_compact, note };
}
