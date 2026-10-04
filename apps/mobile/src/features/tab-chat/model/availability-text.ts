// Why a tab cannot be read as a conversation, in pt-BR (spec 2026-10-01 tab chat §6, §7). The value
// travels as a plain string: one a newer server adds reads as the generic line.
const TEXT: Record<string, string> = {
  offline: 'Máquina offline',
  agent_outdated: 'Atualize o agente desta máquina',
  no_session: 'Sem sessão do Claude nesta aba',
  unsupported_tool: 'Só Claude Code por enquanto',
  unsupported_machine: 'Esta máquina não usa o agente do termhub',
};

/** `null` for `ready`: nothing to say. */
export function availabilityText(availability: string): string | null {
  if (availability === 'ready') return null;
  return Object.prototype.hasOwnProperty.call(TEXT, availability) ? TEXT[availability]! : 'Indisponível no momento';
}
