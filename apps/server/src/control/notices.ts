/**
 * `notify` (TER-1101): the concierge tells the person outside the chat — a push to the phone and a browser
 * notification — that what it is writing now matters. Only in the chat, for the answer being written:
 * the notice leaves once that answer is done, and a tap opens the conversation at it.
 *
 * Levels: `needs_you` (a question, an approval, an error that blocks), `done` (something the person asked
 * to follow happened: it names the watch or reminder, so nothing the person never asked about is pushed
 * as "concluído") and `fyi` (stays in the chat, no push). The person's rules decide the rest
 * (`chat/notices/rules.ts`).
 */
import { NOTICE_LIMITS, type NoticeLevel } from '../chat/notices/rules.js';
import { msg } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';
import { chatScope } from './watches.js';

export interface NotifyArgs {
  level: NoticeLevel;
  headline: string;
  watch_id?: string;
}

export interface NotifyResult {
  status: 'queued' | 'chat_only';
  level: NoticeLevel;
  note: string;
}

export async function notify(ctx: ControlContext, a: NotifyArgs, now = new Date()): Promise<NotifyResult> {
  const { conversationId, projectId } = await chatScope(ctx);
  const userId = ctx.scope.user.id;
  if (a.level === 'fyi') return { status: 'chat_only', level: a.level, note: 'Só para saber: fica no chat, sem push.' };
  if (a.level === 'done') {
    if (!a.watch_id) throw new ControlError('NOTICE_NOT_FOLLOWED', 'Um aviso "done" precisa de watch_id: a assinatura (watch) ou o lembrete (schedule_wakeup) que a pessoa pediu para acompanhar. Sem isso, use fyi.');
    const w = await ctx.repos.chatWatches.findById(a.watch_id);
    if (!w || w.user_id !== userId || w.project_id !== projectId) throw new ControlError('NOTICE_NOT_FOLLOWED', 'Assinatura não encontrada nesta conversa: um aviso "done" só vale para algo que a pessoa pediu para acompanhar aqui. Sem isso, use fyi.');
  }
  if ((await ctx.repos.conciergeNotices.countPending(conversationId)) >= NOTICE_LIMITS.pendingPerConversation)
    throw new ControlError('NOTICE_LIMIT', msg('Esta conversa já tem {{max}} avisos esperando para sair: escreva no chat sem notify.', { max: NOTICE_LIMITS.pendingPerConversation }));
  await ctx.repos.conciergeNotices.create(
    { user_id: userId, conversation_id: conversationId, project_id: projectId, level: a.level, headline: a.headline.trim().replace(/\s+/g, ' ').slice(0, NOTICE_LIMITS.headlineMax), watch_id: a.level === 'done' ? a.watch_id! : null },
    now,
  );
  return {
    status: 'queued',
    level: a.level,
    note: 'Aviso registrado: sai quando esta resposta terminar, pelas regras da pessoa (níveis, horário de silêncio, agrupamento, limite por hora); o toque abre esta mensagem. Escreva a mensagem completa no chat normalmente.',
  };
}
