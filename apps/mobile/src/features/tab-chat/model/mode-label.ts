// Claude Code's permission mode as the session header shows it (spec 2026-10-01 tab chat §6).
const LABEL: Record<string, string> = {
  default: 'Padrão',
  acceptEdits: 'Aceitar edições',
  plan: 'Plano',
  bypassPermissions: 'Sem confirmações',
  auto: 'Automático',
};

/** A mode this build does not know reads as itself; `unknown` (the footer could not be read) and no
 * mode at all read as nothing. */
export function modeLabel(mode: string | null): string | null {
  if (mode === null || mode === 'unknown' || mode === '') return null;
  return Object.prototype.hasOwnProperty.call(LABEL, mode) ? LABEL[mode]! : mode;
}
