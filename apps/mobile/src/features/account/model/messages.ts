// Every line the account-deletion flow shows a person (TER-720), pt-BR — the product language.
import { ACCOUNT_DELETION_GRACE_DAYS } from '@/services/api/contract';

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "31 de outubro de 2026", in the phone's own time zone; `null` for a missing or unreadable date. */
export function deletionDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
}

export const ACCOUNT_MSG = {
  deleteButton: 'Excluir minha conta',
  confirmTitle: 'Excluir minha conta',
  confirmWhen: `Sua conta é desativada agora e excluída de vez em ${ACCOUNT_DELETION_GRACE_DAYS} dias.`,
  confirmDeleted:
    'O que é apagado: máquinas, projetos (com cards, notas e tickets), abas, chat e anexos, memória, integrações, contas de IA, tokens de API, aparelhos (este também, no fim) e notificações.',
  confirmKept: 'O que fica, porque a lei pede: registros de acesso por 6 meses e dados fiscais, quando houver.',
  confirmCancel: `Durante esses ${ACCOUNT_DELETION_GRACE_DAYS} dias, você pode cancelar a exclusão por este app ou entrando no termhub. Um e-mail confirma o pedido com a data final.`,
  confirmButton: 'Confirmar exclusão',
  back: 'Voltar',
  pinTitle: 'Excluir minha conta',

  pendingTitle: 'Exclusão agendada',
  pendingOn: (date: string) => `Sua conta será excluída em ${date}.`,
  pendingNoDate: 'Sua conta está marcada para exclusão.',
  pendingBody: 'Até lá ela fica desativada: o chat, os avisos e o resto do termhub param. Se mudar de ideia, cancele a exclusão e tudo volta como estava.',
  cancelButton: 'Cancelar exclusão',
  leaveButton: 'Sair e remover este aparelho',
  leaveTitle: 'Remover este aparelho',
  leaveBody: 'Este aparelho perde o acesso agora. Para cancelar a exclusão depois, entre no termhub pelo navegador.',
  leaveConfirm: 'Remover',
  leaveBack: 'Cancelar',

  network: 'Não foi possível falar com o servidor. Tente de novo.',
} as const;
