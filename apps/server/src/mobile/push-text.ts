import { DEFAULT_LOCALE, msg, t, type Locale } from '../i18n/index.js';

/**
 * The words of a push notification (spec §9). Pure: it only ever sees names the caller resolved
 * owner-scoped from ids — never an action's summary, its arguments, its tool or a reply's text.
 * Written in the recipient's language (`users.locale`, null → pt-BR); the history row keeps the
 * language it was sent in.
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

const chatOf = (projectName: string | null) => (projectName ? msg('O chat do projeto {{project}}', { project: projectName }) : msg('O chat geral'));
const needsYou = (locale: Locale, ctx: PushContext) => t(locale, '{{name}} precisa de você', { name: ctx.projectName ?? 'termhub' });

/** A pending action waits for the person's confirmation. */
export function confirmationText(ctx: PushContext, locale: Locale = DEFAULT_LOCALE): PushText {
  const title = needsYou(locale, ctx);
  const chat = chatOf(ctx.projectName);
  if (!ctx.tabName) return { title, body: t(locale, '{{chat}} pediu sua confirmação.', { chat }) };
  const where = ctx.machineName ? msg('na aba {{tab}} ({{machine}})', { tab: ctx.tabName, machine: ctx.machineName }) : msg('na aba {{tab}}', { tab: ctx.tabName });
  return { title, body: t(locale, '{{chat}} pediu confirmação para agir {{where}}.', { chat, where }) };
}

/** A run finished with an answer. */
export function replyText(ctx: PushContext, locale: Locale = DEFAULT_LOCALE): PushText {
  return {
    title: ctx.projectName ? t(locale, 'Resposta pronta em {{project}}', { project: ctx.projectName }) : t(locale, 'Resposta pronta'),
    body: t(locale, '{{chat}} terminou de responder.', { chat: chatOf(ctx.projectName) }),
  };
}

/** A new phone asked to join the account: the person approves or denies it on the web. */
export function deviceRequestText(r: { model: string; city: string | null; country: string | null }, locale: Locale = DEFAULT_LOCALE): PushText {
  const place = r.city ?? r.country;
  const who = place ? `${r.model} (${place})` : r.model;
  return {
    title: t(locale, 'Novo aparelho pede acesso'),
    body: t(locale, '{{device}} pediu acesso à sua conta. Confira o código e aprove ou recuse na web.', { device: who }),
  };
}

/** A tab finished its turn (TER-925, opt-in): which tab, never what it did. */
export function tabFinishedText(ctx: PushContext, locale: Locale = DEFAULT_LOCALE): PushText {
  const tab = ctx.tabName
    ? ctx.machineName
      ? msg('A aba {{tab}} ({{machine}})', { tab: ctx.tabName, machine: ctx.machineName })
      : msg('A aba {{tab}}', { tab: ctx.tabName })
    : msg('Uma aba');
  return {
    title: ctx.projectName ? t(locale, '{{project}}: aba terminou', { project: ctx.projectName }) : t(locale, 'Aba terminou'),
    body: t(locale, '{{tab}} terminou e espera você.', { tab }),
  };
}

/** A tab asked something in a project's chat (spec 2026-09-25 §6.1): which tab, never what it asked. */
export function tabQuestionText(ctx: PushContext, kind: 'choice' | 'permission', locale: Locale = DEFAULT_LOCALE): PushText {
  const tab = ctx.tabName ? msg('A aba {{tab}}', { tab: ctx.tabName }) : msg('Uma aba');
  return {
    title: needsYou(locale, ctx),
    body: kind === 'permission' ? t(locale, '{{tab}} pede permissão para continuar.', { tab }) : t(locale, '{{tab}} fez uma pergunta.', { tab }),
  };
}

/**
 * Automatic work stopped on a card and waits for the person (agentic board spec §9.3, D25): the card's
 * ref and the reason's own text (`escalationReasonText`, already in `locale`), never what the tab showed.
 */
export function automationEscalationText(ctx: PushContext, cardRef: string, reason: string, locale: Locale = DEFAULT_LOCALE): PushText {
  return { title: needsYou(locale, ctx), body: t(locale, '{{ref}} parou: {{reason}}', { ref: cardRef, reason }) };
}

/**
 * A release workflow delivered a new version after an automatic merge (TER-1055): the workflow's name (e.g.
 * "Mobile TestFlight (hulk)") and the version, nothing else.
 */
export function automationReleaseText(ctx: PushContext, workflow: string, version: string, locale: Locale = DEFAULT_LOCALE): PushText {
  return {
    title: t(locale, '{{project}}: versão {{version}} publicada', { project: ctx.projectName ?? 'termhub', version }),
    body: t(locale, '{{workflow}} publicou a versão {{version}}.', { workflow, version }),
  };
}

/** The daily summary of the automatic work (spec D26): what was done and how many things wait; counts only. */
export function automationSummaryText(s: { date: string; cards: number; merges: number; deploys: number; waiting: number }, locale: Locale = DEFAULT_LOCALE): PushText {
  const done = t(locale, 'Feitos: {{cards}} cards, {{merges}} merges, {{deploys}} deploys', { cards: s.cards, merges: s.merges, deploys: s.deploys });
  return {
    title: t(locale, 'Resumo do automático — {{date}}', { date: s.date }),
    body: s.waiting === 0 ? done : `${done}\n${t(locale, 'Esperando você: {{total}}', { total: s.waiting })}`,
  };
}

/** An AI account's CLI login expired on a machine (TER-1047): which CLI and which machine, nothing else. */
export function aiLoginRequiredText(provider: 'claude' | 'chatgpt' | 'gemini' | 'antigravity', machineName: string, locale: Locale = DEFAULT_LOCALE): PushText {
  const name = provider === 'claude' ? 'Claude' : provider === 'chatgpt' ? 'Codex' : provider === 'gemini' ? 'Gemini' : 'Antigravity';
  return {
    title: t(locale, 'Login do {{provider}} expirou', { provider: name }),
    body: t(locale, '{{machine}}: toque para refazer o login', { machine: machineName }),
  };
}
