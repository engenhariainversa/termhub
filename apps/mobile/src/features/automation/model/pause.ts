// Copy and helpers of the pause switch ("Pausar tudo", TER-942). pt-BR, the product language.
import type { TPauseState } from '@/services/api/contract';

export const PAUSE_MSG = {
  title: 'Trabalho automático',
  pause: 'Pausar automático',
  pauseAndInterrupt: 'Pausar e interromper as abas',
  resume: 'Retomar automático',
  resumeTitle: 'Retomar o trabalho automático?',
  resumeBody: 'O trabalho automático volta a pegar cards marcados e a agir nas abas dos projetos com ele ligado.',
  resumeConfirm: 'Retomar',
  cancel: 'Cancelar',
  failed: 'Não foi possível mudar o automático. Tente de novo.',
} as const;

/** "Automático pausado desde 10:42." */
export const pausedBanner = (iso: string): string => `Automático pausado desde ${clock(iso)}.`;

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** When the person's work stopped: their "Pausar tudo", else (given a project) that project's own pause. */
export function pausedSince(state: TPauseState | null, projectId?: string): string | null {
  if (!state) return null;
  if (state.paused_at) return state.paused_at;
  return projectId ? (state.projects.find((p) => p.id === projectId)?.paused_at ?? null) : null;
}
