import { i18n } from '../../i18n';
import { formatDate, formatTime } from '../../lib/format';
import type { ChatGrantListItem, ChatGrantState, ChatStandingKind } from '../../lib/types';

/** The chat header's link to "Permissões do chat": tab grants and project grants together. */
export const activeGrantsLabel = (n: number): string => i18n.t('{{count}} permissões ativas', { count: n });

export const grantTabLabel = (g: Pick<ChatGrantListItem, 'tab_name'>): string => (g.tab_name ? i18n.t('Aba {{name}}', { name: g.tab_name }) : i18n.t('Aba que não existe mais'));

/** How "Liberar sem prazo: <ação> neste projeto" names each standing kind (spec 2026-09-28 TER-386 §6);
 * the same table as `STANDING_KIND_LABEL` in `packages/mobile-api` (the web has no workspace deps).
 * Getters, so each read is in the language on screen. */
export const STANDING_KIND_LABEL: Record<ChatStandingKind, string> = {
  get open_tab() {
    return i18n.t('abrir abas');
  },
  get close_tab() {
    return i18n.t('fechar abas paradas');
  },
  get start_agent() {
    return i18n.t('iniciar agentes');
  },
  get board() {
    return i18n.t('mexer no quadro');
  },
  get terminal() {
    return i18n.t('teclas e texto nas abas');
  },
};

/** The kind's label at the start of a sentence: "Fechar abas paradas". */
export const standingKindLabel = (kind: ChatStandingKind): string => {
  const label = STANDING_KIND_LABEL[kind];
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** A row's own title: a tab grant names the tab (and the terminal level, if it is one), a project grant
 * names the project (and its "tudo" scope, if it is one), a standing grant names its kind and project —
 * or that the tab or project is gone. */
export const grantTitleLabel = (
  g: Pick<ChatGrantListItem, 'kind'> & Partial<Pick<ChatGrantListItem, 'tab_name' | 'project_name' | 'tool' | 'scope' | 'standing_kind'>>,
): string => {
  if (g.kind === 'standing')
    return g.project_name && g.standing_kind
      ? i18n.t('{{kind}} no projeto {{project}} · sem prazo', { kind: standingKindLabel(g.standing_kind), project: g.project_name })
      : i18n.t('Projeto que não existe mais');
  if (g.kind === 'project')
    return g.project_name
      ? g.scope === 'all'
        ? i18n.t('Tudo no projeto {{project}}', { project: g.project_name })
        : i18n.t('Quadro do projeto {{project}}', { project: g.project_name })
      : i18n.t('Projeto que não existe mais');
  const tab = grantTabLabel({ tab_name: g.tab_name ?? null });
  return g.tool === 'terminal' ? i18n.t('{{tab}} · teclas e shell', { tab }) : tab;
};

/** Which conversation granted it; a reset conversation says so, and a standing grant whose granting
 * conversation was deleted (it outlives it, `conversation_id` null) says that. */
export function grantOriginLabel(g: Pick<ChatGrantListItem, 'kind' | 'conversation_id' | 'conversation_project_name' | 'conversation_archived'>): string {
  if (g.kind === 'standing' && g.conversation_id === null) return i18n.t('Conversa apagada');
  const base = g.conversation_project_name ? i18n.t('Chat do projeto {{project}}', { project: g.conversation_project_name }) : i18n.t('Chat geral');
  return g.conversation_archived ? i18n.t('{{base}} · conversa encerrada', { base }) : base;
}

/** Getters, so each read is in the language on screen. */
export const GRANT_STATE_LABEL: Record<ChatGrantState, string> = {
  get active() {
    return i18n.t('Ativa');
  },
  get expired() {
    return i18n.t('Expirou');
  },
  get revoked() {
    return i18n.t('Revogada');
  },
  get ended() {
    return i18n.t('Encerrada com a conversa');
  },
};

/** "05/09/2026 07:03" / "09/05/2026 07:03 AM". */
export function endedAtLabel(iso: string): string {
  const d = new Date(iso);
  return `${formatDate(d, { day: '2-digit', month: '2-digit', year: 'numeric' })} ${formatTime(d)}`;
}
