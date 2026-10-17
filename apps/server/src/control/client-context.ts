/**
 * `get_client_context` (TER-1088): where the person's last message in this chat came from — client and
 * version, device and system, public IP, which of their machines are on the same network, time zone and
 * language — as the server read it from the request. The same data as the `[termhub origin]` line of each
 * message; kept in memory only, so it is empty after a restart until the next message. Only in the chat
 * conversation the token was minted for.
 */
import { recalledOrigin, type ClientOrigin } from '../chat/client-origin.js';
import { ControlError, type ControlContext } from './context.js';

const NOT_IN_CHAT = () => new ControlError('NOT_IN_CHAT', 'Esta ferramenta só funciona no chat do termhub: ela lê de onde a pessoa está falando na própria conversa.');

export interface ClientContextReport {
  /** Off: the person turned "Contar ao chat de onde estou falando" off; nothing is read or kept. */
  enabled: boolean;
  origin: ClientOrigin | null;
  note: string;
}

export async function getClientContext(ctx: ControlContext): Promise<ClientContextReport> {
  const conversationId = ctx.token?.chat_conversation_id;
  if (!conversationId) throw NOT_IN_CHAT();
  const userId = ctx.scope.user.id;
  const conversation = await ctx.repos.chat.findByIdForUser(conversationId, userId);
  if (!conversation) throw NOT_IN_CHAT();
  if (!(await ctx.repos.users.chatClientContext(userId))) {
    return { enabled: false, origin: null, note: 'A pessoa desligou "Contar ao chat de onde estou falando" (Memória do chat): pergunte, se precisar saber.' };
  }
  const origin = recalledOrigin(conversationId);
  if (!origin) return { enabled: true, origin: null, note: 'Ainda não há origem guardada nesta conversa: ela chega com a próxima mensagem da pessoa (o servidor só a guarda em memória).' };
  const network =
    origin.same_network_as.length > 0
      ? `A pessoa está na mesma rede (mesmo IP público de saída) de: ${origin.same_network_as.join(', ')}; arquivos dessas máquinas podem ser servidos pela rede local.`
      : 'Não deu para dizer que a pessoa está na mesma rede de alguma máquina dela (máquina offline, rede diferente ou IP privado).';
  return { enabled: true, origin, note: `Origem da última mensagem da pessoa, lida pelo servidor. ${network}` };
}
