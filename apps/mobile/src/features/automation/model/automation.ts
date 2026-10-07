// "Trabalho automático" of the project Setup on the phone (spec 2026-10-04): the pure rules of the
// screen. The copy is the web's (`apps/web/src/lib/automation.ts`), word for word. The server judges what
// is saved; the whole block round-trips, so a field the phone does not edit is sent back as it came.
import { t, tk } from '@/i18n';
import { automationNeedsConfirm, type TAutomationAutonomy, type TAutomationSetup } from '@/services/api/contract';

export type CardType = TAutomationSetup['types'][number];

export const AUTONOMY_LEVELS: readonly TAutomationAutonomy[] = ['pr', 'merge', 'deploy', 'release'];

export const AUTONOMY_LABEL: Record<TAutomationAutonomy, string> = {
  pr: tk('Só código e PR'),
  merge: tk('Merge com CI verde'),
  deploy: tk('Deploy'),
  release: tk('Publicação (npm, OTA)'),
};

export const TYPE_OPTIONS: readonly { type: CardType; label: string }[] = [
  { type: 'story', label: tk('Story') },
  { type: 'task', label: tk('Tarefa') },
  { type: 'bug', label: tk('Bug') },
  { type: 'spike', label: tk('Spike') },
];

const WHAT_THEY_DO: Record<TAutomationAutonomy, string> = {
  pr: tk('Os agentes vão pegar os cards marcados e abrir PRs sozinhos; o merge continua com você.'),
  merge: tk('Os agentes vão pegar os cards marcados, abrir PRs e fazer merge com CI verde sem perguntar.'),
  deploy: tk('Os agentes vão pegar os cards marcados, abrir PRs, fazer merge e deploy sem perguntar.'),
  release: tk('Os agentes vão pegar os cards marcados, abrir PRs, fazer merge, deploy e publicar (npm, OTA) sem perguntar.'),
};

export const autonomyConfirmText = (level: TAutomationAutonomy): string => `${t(WHAT_THEY_DO[level])} ${t('Confirmar?')}`;

export const AUTOMATION_MSG = {
  title: tk('Trabalho automático'),
  intro: tk('Os agentes pegam sozinhos os cards marcados como automáticos. Desligado por padrão.'),
  enable: tk('Ligar trabalho automático neste projeto'),
  types: tk('Tipos de card'),
  level: tk('Até onde os agentes vão sozinhos'),
  storesNever: tk('Envio às lojas nunca é automático.'),
  saved: tk('Trabalho automático salvo.'),
  pinTitle: tk('Trabalho automático'),
  network: tk('Não foi possível falar com o servidor. Tente de novo.'),
  confirmTitle: tk('Trabalho automático'),
  summary: tk('Hora do resumo diário'),
  summaryOff: tk('Sem resumo'),
  summaryHint: tk('O resumo do dia chega nesta hora, no fuso deste aparelho.'),
} as const;

/** Whether saving `to` over `from` asks first (turning on, or raising to Deploy or Publicação). The server enforces the same rule with the PIN. */
export const needsConfirm = (from: TAutomationSetup, to: TAutomationSetup): boolean => automationNeedsConfirm(from, to);

/** Toggles a card type; at least one stays. */
export function toggleType(a: TAutomationSetup, type: CardType): TAutomationSetup {
  const has = a.types.includes(type);
  if (has && a.types.length === 1) return a;
  return { ...a, types: TYPE_OPTIONS.map((o) => o.type).filter((x) => (x === type ? !has : a.types.includes(x))) };
}

const sameBlock = (a: TAutomationSetup, b: TAutomationSetup) => JSON.stringify(a) === JSON.stringify(b);

/** Something differs from what the server has. */
export const isChanged = (saved: TAutomationSetup, draft: TAutomationSetup): boolean => !sameBlock(saved, draft);

/** The hours the daily summary can be sent at (spec D26): 0 to 23, in the person's own zone. */
export const SUMMARY_HOURS: readonly number[] = Array.from({ length: 24 }, (_, h) => h);

/** The block's `summary_hour` (TER-974): a field the server added, kept loose like the rest of the block. */
export function summaryHourOf(a: TAutomationSetup): number | null {
  const h = (a as { summary_hour?: unknown }).summary_hour;
  return typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

/** Sets the summary hour, or turns the summary off with null. */
export const withSummaryHour = (a: TAutomationSetup, hour: number | null): TAutomationSetup => ({ ...a, summary_hour: hour });

/** "08:00": how an hour reads on its chip. */
export const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

/** The phone's IANA zone, sent with a summary hour so the server sends it on this clock; null when unknown. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
