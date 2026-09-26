// Every line the session feature shows a person (pt-BR, the product language).
export const MSG = {
  closed: 'O pedido expirou ou foi recusado. Tente de novo.',
  revoked: 'Este aparelho foi removido da sua conta.',
  locked: 'Aparelho bloqueado por tentativas de PIN.',
  pinInvalid: 'PIN incorreto.',
  pinFormat: 'O PIN tem 6 dígitos.',
  pinMismatch: 'Os dois PINs não são iguais.',
  usePin: 'Use o PIN.',
  biometricsOff: 'Não foi possível ativar a biometria.',
  network: 'Não foi possível falar com o servidor. Tente de novo.',
  dataLost: 'Os dados deste aparelho foram perdidos. Entre de novo.',
  storeFailed: 'Não foi possível guardar o PIN neste aparelho. Tente de novo.',
  sessionExpired: 'Sessão expirada. Desbloqueie para continuar.',
} as const;

/** " N tentativas restantes." after a wrong PIN (Desbloquear and the approval sheet). */
export function attemptsSuffix(n: number): string {
  return n === 1 ? ' 1 tentativa restante.' : ` ${n} tentativas restantes.`;
}
