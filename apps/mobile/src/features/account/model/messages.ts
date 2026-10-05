// Every line the account-deletion flow shows a person (TER-720). Getters: each read returns the
// current language.
import { t } from '@/i18n';
import { formatDate } from '@/i18n/format';
import { ACCOUNT_DELETION_GRACE_DAYS } from '@/services/api/contract';

/** "31 de outubro de 2026" / "October 31, 2026", in the phone's own time zone; `null` for a missing
 * or unreadable date. */
export function deletionDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatDate(d, { day: 'numeric', month: 'long', year: 'numeric' });
}

const days = ACCOUNT_DELETION_GRACE_DAYS;

export const ACCOUNT_MSG = {
  get deleteButton() {
    return t('Excluir minha conta');
  },
  get confirmTitle() {
    return t('Excluir minha conta');
  },
  get confirmWhen() {
    return t('Sua conta é desativada agora e excluída de vez em {{days}} dias.', { days });
  },
  get confirmDeleted() {
    return t(
      'O que é apagado: máquinas, projetos (com cards, notas e tickets), abas, chat e anexos, memória, integrações, contas de IA, tokens de API, aparelhos (este também, no fim) e notificações.',
    );
  },
  get confirmKept() {
    return t('O que fica, porque a lei pede: registros de acesso por 6 meses e dados fiscais, quando houver.');
  },
  get confirmCancel() {
    return t(
      'Durante esses {{days}} dias, você pode cancelar a exclusão por este app ou entrando no termhub. Um e-mail confirma o pedido com a data final.',
      { days },
    );
  },
  get confirmButton() {
    return t('Confirmar exclusão');
  },
  get back() {
    return t('Voltar');
  },
  get pinTitle() {
    return t('Excluir minha conta');
  },

  get pendingTitle() {
    return t('Exclusão agendada');
  },
  pendingOn: (date: string) => t('Sua conta será excluída em {{date}}.', { date }),
  get pendingNoDate() {
    return t('Sua conta está marcada para exclusão.');
  },
  get pendingBody() {
    return t(
      'Até lá ela fica desativada: o chat, os avisos e o resto do termhub param. Se mudar de ideia, cancele a exclusão e tudo volta como estava.',
    );
  },
  get cancelButton() {
    return t('Cancelar exclusão');
  },
  get leaveButton() {
    return t('Sair e remover este aparelho');
  },
  get leaveTitle() {
    return t('Remover este aparelho');
  },
  get leaveBody() {
    return t('Este aparelho perde o acesso agora. Para cancelar a exclusão depois, entre no termhub pelo navegador.');
  },
  get leaveConfirm() {
    return t('Remover');
  },
  get leaveBack() {
    return t('Cancelar');
  },

  get network() {
    return t('Não foi possível falar com o servidor. Tente de novo.');
  },
};
