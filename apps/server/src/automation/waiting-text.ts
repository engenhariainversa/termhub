import { t, tk, type Locale } from '../i18n/index.js';
import { MIN_AVAILABLE_MEMORY_KB, MIN_FREE_DISK_KB, type RoomReading } from './machine-room.js';
import type { AccountVerdict, MachineVerdict, PlaceDetail } from './placement.js';

const MACHINE_TEXT: Record<MachineVerdict, string> = {
  not_agent: tk('não é uma máquina com agente'),
  offline: tk('agente desligado'),
  no_worktree: tk('agente sem worktree (precisa da 0.18)'),
  no_guard: tk('agente sem a trava atual; atualize o agente (0.36)'),
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

const NUMBER_LOCALE: Record<Locale, string> = { 'pt-BR': 'pt-BR', en: 'en-US', es: 'es' };
const num = (locale: Locale, n: number) => n.toLocaleString(NUMBER_LOCALE[locale], { maximumFractionDigits: 1 });
const gb = (locale: Locale, kb: number) => num(locale, kb / (1024 * 1024));

/**
 * TER-1138: the limit a machine without room hit, with what was read and the way out — "memória disponível
 * 2,1 GB < 4 GB (33 abas abertas); feche abas paradas ou use outra máquina do projeto".
 */
export function roomText(locale: Locale, room: RoomReading, tabs?: number): string {
  const open = tabs === undefined ? '' : ` ${t(locale, '({{n}} abas abertas)', { n: tabs })}`;
  switch (room.limit) {
    case 'memory':
      return room.mem_available_kb === null
        ? t(locale, 'memória não lida')
        : `${t(locale, 'memória disponível {{value}} GB < {{min}} GB', { value: gb(locale, room.mem_available_kb), min: gb(locale, MIN_AVAILABLE_MEMORY_KB) })}${open}; ${t(locale, 'feche abas paradas ou use outra máquina do projeto')}`;
    case 'disk':
      return room.disk_free_kb === null
        ? t(locale, 'disco da pasta de worktrees não encontrado')
        : `${t(locale, 'disco livre em {{mount}} {{value}} GB < {{min}} GB', { mount: room.disk_mount ?? '/', value: gb(locale, room.disk_free_kb), min: gb(locale, MIN_FREE_DISK_KB) })}; ${t(locale, 'libere disco ou use outra máquina do projeto')}`;
    case 'load':
      return room.load1 === null || room.ncpu === null
        ? t(locale, 'carga não lida')
        : `${t(locale, 'carga {{load}} ≥ {{ncpu}} CPUs', { load: num(locale, room.load1), ncpu: room.ncpu })}${open}; ${t(locale, 'espere a carga baixar ou use outra máquina do projeto')}`;
    case 'reading':
      return t(locale, 'a leitura de memória/disco/carga falhou');
    default:
      return t(locale, MACHINE_TEXT.no_room);
  }
}

/**
 * TER-985: what a waiting card's reason adds after its short text — each machine and account the
 * placement left out and why, so "Sem conta com folga" says which ones were looked at. Names only.
 */
export function placeDetailText(locale: Locale, detail: PlaceDetail): string {
  const parts: string[] = [];
  if (detail.listed === 0) parts.push(t(locale, 'nenhuma conta escolhida em Setup → Contas de IA e modelo'));
  for (const m of detail.machines) {
    const why = m.why === 'no_room' && m.room ? `${t(locale, 'sem folga')}: ${roomText(locale, m.room, m.tabs)}` : t(locale, MACHINE_TEXT[m.why]);
    parts.push(t(locale, 'máquina {{machine}}: {{why}}', { machine: m.name, why }));
  }
  for (const a of detail.accounts) {
    const why = t(locale, ACCOUNT_TEXT[a.why], a.peak === undefined ? undefined : { peak: a.peak });
    parts.push(t(locale, 'conta {{account}} ({{machine}}): {{why}}', { account: a.label, machine: a.machine, why }));
  }
  return parts.join('; ');
}
