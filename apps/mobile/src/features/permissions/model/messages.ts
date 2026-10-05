// Copy of the permission prompts (permission prompts spec §3.4). Getters: each read returns the
// current language.
import { t } from '@/i18n';

export const PERMISSIONS_MSG = {
  get pushTitle() {
    return t('Receba avisos das suas conversas');
  },
  get pushBody() {
    return t('O termhub avisa quando uma aba pede confirmação, faz uma pergunta ou responde no chat.');
  },
  get pushAccept() {
    return t('Ativar notificações');
  },
  get later() {
    return t('Agora não');
  },
  get adTitle() {
    return t('Ajude a medir nossos anúncios');
  },
  get adBody() {
    return t(
      'Com sua permissão, usamos o identificador de publicidade do aparelho só para saber quais anúncios trouxeram novas pessoas ao termhub. Você pode mudar isso em Ajustes.',
    );
  },
  get adAccept() {
    return t('Permitir');
  },
  get adContinue() {
    return t('Continuar');
  },
  notificationStatus: {
    get granted() {
      return t('Ativadas neste aparelho.');
    },
    get denied() {
      return t('Desativadas. Para receber avisos, ative nos Ajustes do sistema.');
    },
    get undetermined() {
      return t('Ainda não ativadas.');
    },
  },
  get openSettings() {
    return t('Abrir Ajustes do sistema');
  },
  get pushTest() {
    return t('Enviar notificação de teste');
  },
  get pushTestHint() {
    return t('Feche o app para ver como ela chega.');
  },
  get adsSwitch() {
    return t('Medição de anúncios');
  },
  get adsHint() {
    return t('Usa o identificador de publicidade do aparelho só para medir quais anúncios trouxeram novas pessoas ao termhub.');
  },
};
