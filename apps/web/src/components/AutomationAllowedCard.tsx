import { useState } from 'react';
import { ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { useTranslation } from '../i18n';
import type { Machine } from '../lib/types';

/** Machine form: whether the board's automatic runs (project automation) may be placed on this machine. */
export function AutomationAllowedCard({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const { updateMachine } = useData();
  const [allowed, setAllowed] = useState(machine.automation_allowed);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setAllowed(next);
    setError(null);
    try {
      await updateMachine(machine.id, { automation_allowed: next });
    } catch (e) {
      setAllowed(!next);
      setError(e instanceof ApiError ? e.message : t('Erro ao salvar'));
    }
  };

  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <label className="flex items-center gap-2 font-medium text-fg-muted">
        <input type="checkbox" checked={allowed} onChange={(e) => void toggle(e.target.checked)} />
        {t('Aceita trabalho automático')}
      </label>
      <p className="mt-1 text-fg-dim">
        {t('Desmarcada, o termhub nunca inicia sozinho um card do quadro nesta máquina. Abas abertas por você continuam como sempre.')}
      </p>
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
