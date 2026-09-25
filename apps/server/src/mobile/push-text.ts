/**
 * The words of a push notification (spec §9). Pure: it only ever sees names the caller resolved
 * owner-scoped from ids — never an action's summary, its arguments, its tool or a reply's text.
 */
export interface PushContext {
  projectName: string | null;
  tabName: string | null;
  machineName: string | null;
}

export interface PushText {
  title: string;
  body: string;
}

const chatOf = (projectName: string | null) => (projectName ? `O chat do projeto ${projectName}` : 'O chat geral');

/** A pending action waits for the person's confirmation. */
export function confirmationText(ctx: PushContext): PushText {
  const title = `${ctx.projectName ?? 'termhub'} precisa de você`;
  if (!ctx.tabName) return { title, body: `${chatOf(ctx.projectName)} pediu sua confirmação.` };
  const where = ctx.machineName ? `na aba ${ctx.tabName} (${ctx.machineName})` : `na aba ${ctx.tabName}`;
  return { title, body: `${chatOf(ctx.projectName)} pediu confirmação para agir ${where}.` };
}

/** A run finished with an answer. */
export function replyText(ctx: PushContext): PushText {
  return {
    title: ctx.projectName ? `Resposta pronta em ${ctx.projectName}` : 'Resposta pronta',
    body: `${chatOf(ctx.projectName)} terminou de responder.`,
  };
}

/** A new phone asked to join the account: the person approves or denies it on the web. */
export function deviceRequestText(r: { model: string; city: string | null; country: string | null }): PushText {
  const place = r.city ?? r.country;
  const who = place ? `${r.model} (${place})` : r.model;
  return { title: 'Novo aparelho pede acesso', body: `${who} pediu acesso à sua conta. Confira o código e aprove ou recuse na web.` };
}

/** A tab asked something in a project's chat (spec 2026-09-25 §6.1): which tab, never what it asked. */
export function tabQuestionText(ctx: PushContext, kind: 'choice' | 'permission'): PushText {
  const tab = ctx.tabName ? `A aba ${ctx.tabName}` : 'Uma aba';
  return { title: `${ctx.projectName ?? 'termhub'} precisa de você`, body: kind === 'permission' ? `${tab} pede permissão para continuar.` : `${tab} fez uma pergunta.` };
}
