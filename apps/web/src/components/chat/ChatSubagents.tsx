import { useTranslation } from '../../i18n';
import { elapsedLabel, SUBAGENT_STATUS_LABEL } from '../../lib/subagents';
import type { SubagentView } from '../../lib/types';

export interface ChatSubagentsProps {
  subagents: SubagentView[];
  /** Ids whose "Cancelar" click came back with `subagent_cancel_failed` (spec 2026-09-26 panel §5.4). */
  failed: Set<string>;
  onCancel: (id: string) => void;
  /** Defaults to `Date.now()`: a prop only so a test can pin the elapsed labels. */
  now?: number;
}

/**
 * The subagents panel (spec 2026-09-26 §4): one row per subagent of the conversation, newest first —
 * `ChatPanel` owns the list and the toolbar button that opens it. Same tokens as `ChatActionCard`.
 */
export function ChatSubagents({ subagents, failed, onCancel, now }: ChatSubagentsProps) {
  const { t } = useTranslation();
  const at = now ?? Date.now();
  return (
    <ul className="space-y-2">
      {subagents.map((s) => (
        <li key={s.id} className="rounded-xl border border-line bg-bg-2 px-4 py-3 text-sm">
          <p className="text-fg">{s.description}</p>
          <p className="mt-1 text-xs text-fg-dim">
            {t(SUBAGENT_STATUS_LABEL[s.status])} · {elapsedLabel(s, at)}
          </p>
          {s.status === 'running' && (
            <button type="button" className="btn-ghost mt-2" aria-label={t('Cancelar {{name}}', { name: s.description })} onClick={() => onCancel(s.id)}>
              {t('Cancelar')}
            </button>
          )}
          {failed.has(s.id) && <p className="mt-1 text-xs text-danger">{t('Não foi possível cancelar')}</p>}
        </li>
      ))}
    </ul>
  );
}
