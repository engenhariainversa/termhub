import { t } from '@/i18n';

// Every line the session feature shows a person. Getters: each read returns the current language.
export const MSG = {
  get closed() {
    return t('O pedido expirou ou foi recusado. Tente de novo.');
  },
  get revoked() {
    return t('Este aparelho foi removido da sua conta.');
  },
  get locked() {
    return t('Aparelho bloqueado por tentativas de PIN.');
  },
  get pinInvalid() {
    return t('PIN incorreto.');
  },
  get pinFormat() {
    return t('O PIN tem 6 dígitos.');
  },
  get pinMismatch() {
    return t('Os dois PINs não são iguais.');
  },
  get usePin() {
    return t('Use o PIN.');
  },
  get biometricsOff() {
    return t('Não foi possível ativar a biometria.');
  },
  get network() {
    return t('Não foi possível falar com o servidor. Tente de novo.');
  },
  get dataLost() {
    return t('Os dados deste aparelho foram perdidos. Entre de novo.');
  },
  get storeFailed() {
    return t('Não foi possível guardar o PIN neste aparelho. Tente de novo.');
  },
  get sessionExpired() {
    return t('Sessão expirada. Desbloqueie para continuar.');
  },
};

/** " N tentativas restantes." after a wrong PIN (Desbloquear and the approval sheet). */
export function attemptsSuffix(n: number): string {
  return ` ${n === 1 ? t('1 tentativa restante.') : t('{{n}} tentativas restantes.', { n })}`;
}
