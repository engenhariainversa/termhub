import { taskTypeLabel } from '../lib/board';
import type { TaskType } from '../lib/types';
import { useTranslation } from '../i18n';

const STYLE: Record<TaskType, { mark: string; className: string }> = {
  epic: { mark: 'É', className: 'bg-accent/20 text-accent' },
  story: { mark: 'H', className: 'bg-ok/20 text-ok' },
  task: { mark: 'T', className: 'bg-bg-4 text-fg-muted' },
  subtask: { mark: 's', className: 'bg-bg-4 text-fg-dim' },
  bug: { mark: 'B', className: 'bg-danger/20 text-danger' },
  spike: { mark: 'S', className: 'bg-warn/20 text-warn' },
};

/** A card's type as a small letter; the full name is its tooltip and accessible label. */
export function TypeBadge({ type }: { type: TaskType }) {
  useTranslation(); // re-render on a language change
  const s = STYLE[type];
  const label = taskTypeLabel(type);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold ${s.className}`}
    >
      {s.mark}
    </span>
  );
}
