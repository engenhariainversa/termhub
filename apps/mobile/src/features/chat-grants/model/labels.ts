// Verbatim from apps/web/src/components/chat/grant-list-text.ts
import type { TChatGrantListItem as ChatGrantListItem } from '@/services/api/contract';

type ChatGrantState = ChatGrantListItem['state'];

const pad = (n: number) => String(n).padStart(2, '0');

/** The chat header's link to "Abas confiáveis". */
export const trustedTabsLabel = (n: number): string => (n === 1 ? '1 aba confiável' : `${n} abas confiáveis`);

export const grantTabLabel = (g: Pick<ChatGrantListItem, 'tab_name'>): string => (g.tab_name ? `Aba ${g.tab_name}` : 'Aba que não existe mais');

/** Which conversation granted it; a reset conversation says so. */
export function grantOriginLabel(g: Pick<ChatGrantListItem, 'conversation_project_name' | 'conversation_archived'>): string {
  const base = g.conversation_project_name ? `Chat do projeto ${g.conversation_project_name}` : 'Chat geral';
  return g.conversation_archived ? `${base} · conversa encerrada` : base;
}

export const GRANT_STATE_LABEL: Record<ChatGrantState, string> = { active: 'Ativa', expired: 'Expirou', revoked: 'Revogada', ended: 'Encerrada com a conversa' };

export function endedAtLabel(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
