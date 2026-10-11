import { t } from '@/i18n';

// Every line the notifications feature's store shows a person. Getters: each read returns the
// current language.
export const NOTIF_MSG = {
  get network() {
    return t('Não foi possível falar com o servidor. Tente de novo.');
  },
};
