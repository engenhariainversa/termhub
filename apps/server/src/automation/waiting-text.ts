import { t, tk, type Locale } from '../i18n/index.js';
import type { AccountVerdict, MachineVerdict, PlaceDetail } from './placement.js';

const MACHINE_TEXT: Record<MachineVerdict, string> = {
  not_agent: tk('não é uma máquina com agente'),
  offline: tk('agente desligado'),
  no_worktree: tk('agente sem worktree (precisa da 0.18)'),
  no_claude: tk('sem o Claude instalado'),
  not_allowed: tk('não aceita trabalho automático'),
  no_room: tk('sem folga (memória/disco/carga)'),
};

const ACCOUNT_TEXT: Record<AccountVerdict, string> = {
  not_listed: tk('fora das contas do projeto no Setup'),
  exclusive: tk('exclusiva de outro projeto'),
  exhausted: tk('no limite de uso'),
  busy: tk('uso em {{peak}}% (o automático para em 80%)'),
  taken: tk('já recebeu um início nesta rodada'),
  machine_no_room: tk('máquina sem folga'),
};

/**
 * TER-985: what a waiting card's reason adds after its short text — each machine and account the
 * placement left out and why, so "Sem conta com folga" says which ones were looked at. Names only.
 */
export function placeDetailText(locale: Locale, detail: PlaceDetail): string {
  const parts: string[] = [];
  if (detail.listed === 0) parts.push(t(locale, 'nenhuma conta escolhida em Setup → Contas de IA e modelo'));
  for (const m of detail.machines) parts.push(t(locale, 'máquina {{machine}}: {{why}}', { machine: m.name, why: t(locale, MACHINE_TEXT[m.why]) }));
  for (const a of detail.accounts) {
    const why = t(locale, ACCOUNT_TEXT[a.why], a.peak === undefined ? undefined : { peak: a.peak });
    parts.push(t(locale, 'conta {{account}} ({{machine}}): {{why}}', { account: a.label, machine: a.machine, why }));
  }
  return parts.join('; ');
}
