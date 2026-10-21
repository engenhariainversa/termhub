// What a working agent is doing, as the server classifies it from the tool it is about to call
// (`TabActivity`, apps/server/src/monitor/activity.ts), in the language the app shows (TER-1102).
import { t, tk } from '@/i18n';

const LABEL: Record<string, string> = {
  coding: tk('editando arquivos'),
  reading: tk('lendo arquivos'),
  researching: tk('pesquisando'),
  planning: tk('planejando'),
  terminal: tk('rodando comandos'),
};

/** null for `working` (no tool classified) and for none at all; a value a newer server adds reads as itself. */
export function activityLabel(activity: string | null | undefined): string | null {
  if (!activity || activity === 'working') return null;
  return Object.prototype.hasOwnProperty.call(LABEL, activity) ? t(LABEL[activity]!) : activity;
}
