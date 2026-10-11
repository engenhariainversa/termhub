// Why a tab cannot be read as a conversation (spec 2026-10-01 tab chat §6, §7), in the language the
// app shows. The value travels as a plain string: one a newer server adds reads as the generic line.
import { t, tk } from '@/i18n';

const TEXT: Record<string, string> = {
  offline: tk('Máquina offline'),
  agent_outdated: tk('Atualize o agente desta máquina'),
  no_session: tk('Sem sessão do Claude nesta aba'),
  unsupported_tool: tk('Só Claude Code por enquanto'),
  unsupported_machine: tk('Esta máquina não usa o agente do termhub'),
};

/** `null` for `ready`: nothing to say. */
export function availabilityText(availability: string): string | null {
  if (availability === 'ready') return null;
  return Object.prototype.hasOwnProperty.call(TEXT, availability) ? t(TEXT[availability]!) : t('Indisponível no momento');
}
