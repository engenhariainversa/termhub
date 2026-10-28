import { useState } from 'react';
import { ApiError } from '../lib/api';
import { useData } from '../lib/data';
import type { Machine } from '../lib/types';
import { useTranslation } from '../i18n';

/** What the switch proposes when it is turned on, and the bounds the server accepts (monitor/idle-tabs.ts). */
const IDLE_TAB_CLOSE_DEFAULT_HOURS = 24;
const MIN_HOURS = 2;
const MAX_HOURS = 30 * 24;

/**
 * Machine form → Geral (TER-1138): close the agent tabs left at rest for long on this machine. Off by default;
 * the hours are saved when the field loses focus. Optimistic, reverted on error (like AiUsageQueryCard).
 */
export function IdleTabCloseCard({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const { updateMachine } = useData();
  const [hours, setHours] = useState<number | null>(machine.idle_tab_close_hours ?? null);
  const [draft, setDraft] = useState(String(machine.idle_tab_close_hours ?? IDLE_TAB_CLOSE_DEFAULT_HOURS));
  const [error, setError] = useState<string | null>(null);

  const save = async (next: number | null) => {
    const previous = hours;
    setHours(next);
    setError(null);
    try {
      await updateMachine(machine.id, { idle_tab_close_hours: next });
    } catch (e) {
      setHours(previous);
      setError(e instanceof ApiError ? e.message : t('Erro ao salvar'));
    }
  };

  const commitDraft = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < MIN_HOURS || n > MAX_HOURS) {
      setError(t('Use de {{min}} a {{max}} horas', { min: MIN_HOURS, max: MAX_HOURS }));
      return;
    }
    if (n !== hours) void save(n);
  };

  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <label className="flex items-center gap-2 font-medium text-fg-muted">
        <input type="checkbox" checked={hours !== null} onChange={(e) => void save(e.target.checked ? Number(draft) || IDLE_TAB_CLOSE_DEFAULT_HOURS : null)} />
        {t('Fechar abas paradas')}
      </label>
      {hours !== null && (
        <label className="mt-1 flex items-center gap-2 text-fg-muted">
          {t('Depois de')}
          <input
            className="input w-20"
            type="number"
            min={MIN_HOURS}
            max={MAX_HOURS}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            aria-label={t('Horas parada antes de fechar')}
          />
          {t('horas parada')}
        </label>
      )}
      <p className="mt-1 text-fg-dim">
        {t(
          'Abas de agente (Claude Code, Codex, Cursor, Gemini) que terminaram ou estão ociosas há esse tempo são fechadas sozinhas e aparecem no feed; uma aba esperando você com um relatório fecha depois do triplo. Nunca fecha aba trabalhando, com pergunta ou permissão, com uma execução automática ativa, com um build ou servidor rodando, nem terminais sem agente. A pasta e a sessão ficam: retome com --continue. Com a máquina sem folga, as mais antigas fecham antes do prazo (a partir de 2 h).',
        )}
      </p>
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
