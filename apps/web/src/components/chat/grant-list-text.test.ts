import { expect, it } from 'vitest';
import { endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTabLabel, trustedTabsLabel } from './grant-list-text';

it('counts trusted tabs in pt-BR', () => {
  expect(trustedTabsLabel(1)).toBe('1 aba confiável');
  expect(trustedTabsLabel(3)).toBe('3 abas confiáveis');
});
it('names the tab, the origin and the state', () => {
  expect(grantTabLabel({ tab_name: 'api' })).toBe('Aba api');
  expect(grantTabLabel({ tab_name: null })).toBe('Aba que não existe mais');
  expect(grantOriginLabel({ conversation_project_name: null, conversation_archived: false })).toBe('Chat geral');
  expect(grantOriginLabel({ conversation_project_name: 'termhub', conversation_archived: true })).toBe('Chat do projeto termhub · conversa encerrada');
  expect(GRANT_STATE_LABEL).toEqual({ active: 'Ativa', expired: 'Expirou', revoked: 'Revogada', ended: 'Encerrada com a conversa' });
});
it('formats when it ended as dd/mm/aaaa hh:mm in local time', () => {
  const d = new Date(2026, 8, 5, 7, 3);
  expect(endedAtLabel(d.toISOString())).toBe('05/09/2026 07:03');
});
