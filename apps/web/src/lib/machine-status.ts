import type { MachineStatus } from './data';
import type { MachineType } from './types';
import { tk } from '../i18n';

/** Shared status-dot styling/labels for a machine's online/offline/checking state (sidebar, Máquinas page, project walkthrough). */
export const STATUS_DOT: Record<MachineStatus, string> = {
  checking: 'bg-warn animate-pulse',
  online: 'bg-ok',
  offline: 'bg-danger',
};

/** pt-BR keys; show them with `t(STATUS_LABEL[status])`. */
export const STATUS_LABEL: Record<MachineStatus, string> = { checking: tk('verificando'), online: tk('online'), offline: tk('offline') };

/** Legacy transports (kept for machines that already exist; new machines are agent-only). pt-BR keys: `t(TYPE_LABEL[type])`. */
export const TYPE_LABEL: Record<MachineType, string> = { agent: tk('Agente'), ssh: tk('SSH (legado)'), local: tk('Servidor do termhub (legado)') };
