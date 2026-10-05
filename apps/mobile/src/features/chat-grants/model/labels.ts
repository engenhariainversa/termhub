// Verbatim from apps/web/src/components/chat/grant-list-text.ts (the pt-BR copy is the translation key)
import { t, tk } from '@/i18n';
import { formatDate, formatTime } from '@/i18n/format';
import { STANDING_KIND_LABEL, type StandingGrantKind as ChatStandingKind, type TChatGrantListItem as ChatGrantListItem } from '@/services/api/contract';

type ChatGrantState = ChatGrantListItem['state'];

/** The chat header's link to "Permissões do chat": tab grants and project grants together. */
export const activeGrantsLabel = (n: number): string => (n === 1 ? t('1 permissão ativa') : t('{{n}} permissões ativas', { n }));

export const grantTabLabel = (g: Pick<ChatGrantListItem, 'tab_name'>): string =>
  g.tab_name ? t('Aba {{tab}}', { tab: g.tab_name }) : t('Aba que não existe mais');

/** How "Liberar sem prazo: <ação> neste projeto" names each standing kind (spec 2026-09-28 TER-386 §6):
 * the web keeps its own copy of the table; the app takes the contract's (pt-BR data, never shown as is). */
export { STANDING_KIND_LABEL };

/** The kind's label at the start of a sentence: "Fechar abas paradas" (the contract's wording). */
export const standingKindLabel = (kind: ChatStandingKind): string => {
  switch (kind) {
    case 'open_tab':
      return t('Abrir abas');
    case 'close_tab':
      return t('Fechar abas paradas');
    case 'start_agent':
      return t('Iniciar agentes');
    case 'board':
      return t('Mexer no quadro');
    case 'terminal':
      return t('Teclas e texto nas abas');
  }
};

/** A row's own title: a tab grant names the tab (and the terminal level, if it is one), a project grant
 * names the project (and its "tudo" scope, if it is one), a standing grant names its kind and project —
 * or that the tab or project is gone. */
export const grantTitleLabel = (
  g: Pick<ChatGrantListItem, 'kind' | 'tab_name' | 'project_name'> & Partial<Pick<ChatGrantListItem, 'tool' | 'scope' | 'standing_kind'>>,
): string => {
  const project = g.project_name;
  if (g.kind === 'standing')
    return project && g.standing_kind
      ? t('{{kind}} no projeto {{project}} · sem prazo', { kind: standingKindLabel(g.standing_kind), project })
      : t('Projeto que não existe mais');
  if (g.kind === 'project')
    return project ? (g.scope === 'all' ? t('Tudo no projeto {{project}}', { project }) : t('Quadro do projeto {{project}}', { project })) : t('Projeto que não existe mais');
  return g.tool === 'terminal' ? t('{{tab}} · teclas e shell', { tab: grantTabLabel(g) }) : grantTabLabel(g);
};

/** Which conversation granted it; a reset conversation says so, and a standing grant whose granting
 * conversation was deleted (it outlives it, `conversation_id` null) says that. */
export function grantOriginLabel(g: Pick<ChatGrantListItem, 'kind' | 'conversation_id' | 'conversation_project_name' | 'conversation_archived'>): string {
  if (g.kind === 'standing' && g.conversation_id === null) return t('Conversa apagada');
  const base = g.conversation_project_name ? t('Chat do projeto {{project}}', { project: g.conversation_project_name }) : t('Chat geral');
  return g.conversation_archived ? t('{{chat}} · conversa encerrada', { chat: base }) : base;
}

/** pt-BR keys: translate where shown, `t(GRANT_STATE_LABEL[state])`. */
export const GRANT_STATE_LABEL: Record<ChatGrantState, string> = {
  active: tk('Ativa'),
  expired: tk('Expirou'),
  revoked: tk('Revogada'),
  ended: tk('Encerrada com a conversa'),
};

/** "05/09/2026 07:03" (pt-BR) / "09/05/2026 07:03 AM" (en), in local time. */
export function endedAtLabel(iso: string): string {
  const d = new Date(iso);
  return `${formatDate(d, { day: '2-digit', month: '2-digit', year: 'numeric' })} ${formatTime(d)}`;
}
