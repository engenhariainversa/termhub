// Every line the chat feature's store shows a person. The sentences under a stopped answer and the
// host line live in `copy.ts`, the same words as the web. Each property is a getter, so a reader gets
// the language the app shows at that moment (i18n spec 2026-10-04).
import { t } from '@/i18n';
import type { StandingGrantKind } from '@/services/api/contract';

export const CHAT_MSG = {
  get busy() { return t('O chat ainda está respondendo. Aguarde.'); },
  get alreadyDecided() { return t('Essa ação já foi decidida.'); },
  get notFound() { return t('Conversa não encontrada.'); },
  get updateApp() { return t('Atualize o app para continuar.'); },
  get network() { return t('Não foi possível falar com o servidor. Tente de novo.'); },
  get tabPromptChanged() { return t('A aba já não mostra esta pergunta: nada foi enviado.'); },
  get tabSuggestionChanged() { return t('A sugestão mudou na aba'); },
  get attachmentType() { return t('Tipo de arquivo não suportado'); },
  get attachmentLegacyOffice() { return t('Envie como .docx/.xlsx'); },
  /** Followed by the kind's limit ("Arquivo acima de 10 MB"): see `attachmentTooLargeText`. */
  get attachmentTooLarge() { return t('Arquivo acima de'); },
  get attachmentTooMany() { return t('No máximo 5 anexos por mensagem'); },
  get attachmentUploadFailed() { return t('Não foi possível enviar o arquivo'); },
  get attachmentUploading() { return t('enviando anexo…'); },
  get attachmentInvalid() { return t('Remova o anexo inválido para enviar'); },
  get attachmentGalleryDenied() { return t('Permissão da galeria negada'); },
  get attachmentCameraDenied() { return t('Permissão da câmera negada'); },
  get attachmentCameraFailed() { return t('Não foi possível abrir a câmera'); },
  get forgetDecisionFailed() { return t('Não foi possível esquecer a decisão'); },
  get autoAnswerAlreadySent() { return t('A resposta automática já foi enviada.'); },
  /** A run that could not even be attempted (`run_finished` with no message id, spec 2026-09-29 §5). */
  get setupFailed() { return t('O concierge não conseguiu começar a resposta. Tente de novo.'); },
};

/** "Arquivo acima de 10 MB": the refusal of a file over its kind's limit, as one sentence. */
export const attachmentTooLargeText = (limit: string): string => t('Arquivo acima de {{limit}}', { limit });

/** The "Liberar sem prazo" button of a card, and the PIN sheet's title for it (spec 2026-09-28 TER-386
 * §6): one whole sentence per standing kind, the contract's `STANDING_KIND_LABEL` wording in the middle. */
export function approveAlwaysLabel(kind: StandingGrantKind): string {
  switch (kind) {
    case 'open_tab':
      return t('Liberar sem prazo: abrir abas neste projeto');
    case 'close_tab':
      return t('Liberar sem prazo: fechar abas paradas neste projeto');
    case 'start_agent':
      return t('Liberar sem prazo: iniciar agentes neste projeto');
    case 'board':
      return t('Liberar sem prazo: mexer no quadro neste projeto');
    case 'terminal':
      return t('Liberar sem prazo: teclas e texto nas abas neste projeto');
  }
}
