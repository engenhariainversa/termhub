// Copy and helpers of the pause switch ("Pausar tudo", TER-942). The pt-BR keys are shown through t().
import { formatTime } from '@/i18n/format';
import { t, tk } from '@/i18n';
import type { TPauseState } from '@/services/api/contract';

export const PAUSE_MSG = {
  pause: tk('Pausar automático'),
  pauseAndInterrupt: tk('Pausar e interromper as abas'),
  resume: tk('Retomar automático'),
  resumeTitle: tk('Retomar o trabalho automático?'),
  resumeBody: tk('O trabalho automático volta a pegar cards marcados e a agir nas abas dos projetos com ele ligado.'),
  resumeConfirm: tk('Retomar'),
  cancel: tk('Cancelar'),
  failed: tk('Não foi possível mudar o automático. Tente de novo.'),
} as const;

/** "Automático pausado desde 10:42." */
export const pausedBanner = (iso: string): string => t('Automático pausado desde {{time}}.', { time: formatTime(iso) });

/** When the person's work stopped: their "Pausar tudo", else (given a project) that project's own pause. */
export function pausedSince(state: TPauseState | null, projectId?: string): string | null {
  if (!state) return null;
  if (state.paused_at) return state.paused_at;
  return projectId ? (state.projects.find((p) => p.id === projectId)?.paused_at ?? null) : null;
}
