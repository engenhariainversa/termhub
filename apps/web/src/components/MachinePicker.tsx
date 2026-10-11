import type { Machine, Project } from '../lib/types';
import { readLastMachine } from '../lib/last-machine';
import { machineLabel } from '../lib/machine-labels';
import { Modal } from './Modal';
import { useTranslation } from '../i18n';

interface Props {
  open: boolean;
  project: Project;
  machines: Machine[];
  onPick: (machineId: string) => void;
  onClose: () => void;
}

/** "Abrir em qual máquina?" — shared by TerminalsView (new tab) and TasksBoard (task terminal). */
export function MachinePicker({ open, project, machines, onPick, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <Modal title={t('Abrir em qual máquina?')} open={open} onClose={onClose}>
      <ul className="space-y-1">
        {machines.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className={`btn w-full justify-start border ${readLastMachine(project.id) === m.id ? 'border-accent' : 'border-line'} hover:bg-bg-3`}
              onClick={() => onPick(m.id)}
            >
              {machineLabel(m)}
              <span className="ml-2 font-mono text-[11px] text-fg-dim">{project.machines.find((l) => l.machine_id === m.id)?.cwd}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
