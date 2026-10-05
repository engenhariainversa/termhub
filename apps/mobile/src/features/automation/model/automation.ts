// "Trabalho automático" of the project Setup on the phone (spec 2026-10-04): the pure rules of the
// screen. The copy is the web's (`apps/web/src/lib/automation.ts`), word for word. The server judges what
// is saved; the whole block round-trips, so a field the phone does not edit is sent back as it came.
import { automationNeedsConfirm, type TAutomationAutonomy, type TAutomationSetup } from '@/services/api/contract';

export type CardType = TAutomationSetup['types'][number];

export const AUTONOMY_LEVELS: readonly TAutomationAutonomy[] = ['pr', 'merge', 'deploy', 'release'];

export const AUTONOMY_LABEL: Record<TAutomationAutonomy, string> = {
  pr: 'Só código e PR',
  merge: 'Merge com CI verde',
  deploy: 'Deploy',
  release: 'Publicação (npm, OTA)',
};

export const TYPE_OPTIONS: readonly { type: CardType; label: string }[] = [
  { type: 'story', label: 'Story' },
  { type: 'task', label: 'Tarefa' },
  { type: 'bug', label: 'Bug' },
  { type: 'spike', label: 'Spike' },
];

const WHAT_THEY_DO: Record<TAutomationAutonomy, string> = {
  pr: 'Os agentes vão pegar os cards marcados e abrir PRs sozinhos; o merge continua com você.',
  merge: 'Os agentes vão pegar os cards marcados, abrir PRs e fazer merge com CI verde sem perguntar.',
  deploy: 'Os agentes vão pegar os cards marcados, abrir PRs, fazer merge e deploy sem perguntar.',
  release: 'Os agentes vão pegar os cards marcados, abrir PRs, fazer merge, deploy e publicar (npm, OTA) sem perguntar.',
};

export const autonomyConfirmText = (level: TAutomationAutonomy): string => `${WHAT_THEY_DO[level]} Confirmar?`;

export const AUTOMATION_MSG = {
  title: 'Trabalho automático',
  intro: 'Os agentes pegam sozinhos os cards marcados como automáticos. Desligado por padrão.',
  enable: 'Ligar trabalho automático neste projeto',
  types: 'Tipos de card',
  level: 'Até onde os agentes vão sozinhos',
  storesNever: 'Envio às lojas nunca é automático.',
  saved: 'Trabalho automático salvo.',
  pinTitle: 'Trabalho automático',
  network: 'Não foi possível falar com o servidor. Tente de novo.',
  confirmTitle: 'Trabalho automático',
} as const;

/** Whether saving `to` over `from` asks first (turning on, or raising to Deploy or Publicação). The server enforces the same rule with the PIN. */
export const needsConfirm = (from: TAutomationSetup, to: TAutomationSetup): boolean => automationNeedsConfirm(from, to);

/** Toggles a card type; at least one stays. */
export function toggleType(a: TAutomationSetup, type: CardType): TAutomationSetup {
  const has = a.types.includes(type);
  if (has && a.types.length === 1) return a;
  return { ...a, types: TYPE_OPTIONS.map((o) => o.type).filter((t) => (t === type ? !has : a.types.includes(t))) };
}

const sameBlock = (a: TAutomationSetup, b: TAutomationSetup) => JSON.stringify(a) === JSON.stringify(b);

/** Something differs from what the server has. */
export const isChanged = (saved: TAutomationSetup, draft: TAutomationSetup): boolean => !sameBlock(saved, draft);
