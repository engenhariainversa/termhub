// The copy of the sessions (spec 2026-10-01 tab chat §6, §7). Each property is a getter, so a reader
// gets the language the app shows at that moment (i18n spec 2026-10-04).
import { t } from '@/i18n';

export const TAB_CHAT_MSG = {
  get loadFailed() { return t('Não foi possível abrir a sessão.'); },
  get notFound() { return t('Aba não encontrada.'); },
  get noAccess() { return t('Seu acesso não inclui terminais.'); },
  get sendFailed() { return t('Não foi possível enviar. Tente de novo.'); },
  get waitingPermission() { return t('Responda a pergunta acima antes de enviar uma mensagem'); },
  get tooLong() { return t('Mensagem longa demais (máximo de 4000 caracteres)'); },
  get actionFailed() { return t('Não foi possível enviar o comando. Tente de novo.'); },
  get screenFailed() { return t('Não foi possível ler a tela.'); },
  get fileFailed() { return t('Não foi possível enviar o arquivo.'); },
  get degraded() { return t('Não consegui ler parte do histórico. Use Ver tela.'); },
  get listFailed() { return t('Não foi possível carregar as sessões.'); },
  get emptyList() { return t('Nenhuma aba aberta nos seus projetos.'); },
  get startFailed() { return t('Não foi possível iniciar a sessão. Tente de novo.'); },
  get updateApp() { return t('Atualize o app para continuar.'); },
};
