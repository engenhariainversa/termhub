import { useState } from 'react';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import type { AiAccount, Machine } from '../lib/types';
import { useTranslation } from '../i18n';

/** The machine's `ai_usage_query` switch: optimistic toggle, reverted on error (like AutomationAllowedCard). */
function useAiUsageQuery(machine: Machine) {
  const { t } = useTranslation();
  const { updateMachine } = useData();
  const [checked, setChecked] = useState(machine.ai_usage_query);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setChecked(next);
    setError(null);
    try {
      await updateMachine(machine.id, { ai_usage_query: next });
    } catch (e) {
      setChecked(!next);
      setError(e instanceof ApiError ? e.message : t('Erro ao salvar'));
    }
  };
  return { checked, error, toggle };
}

/**
 * Machine form → Geral (TER-735): whether the termhub queries the usage of this machine's AI accounts.
 * The query runs on the machine itself (agent, SSH script or the server's own host), so the login
 * credential never leaves it; turning it off stops even reading the credential. Every machine type.
 */
export function AiUsageQueryCard({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const { checked, error, toggle } = useAiUsageQuery(machine);
  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <label className="flex items-center gap-2 font-medium text-fg-muted">
        <input type="checkbox" checked={checked} onChange={(e) => void toggle(e.target.checked)} />
        {t('Consultar o uso das contas de IA')}
      </label>
      <p className="mt-1 text-fg-dim">
        {t('A credencial de login das ferramentas é lida e usada só nesta máquina; o termhub recebe apenas os números de uso. Desligado, o termhub não lê a credencial e as contas desta máquina ficam sem as barras de uso.')}
      </p>
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}

function MachineRow({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const { checked, error, toggle } = useAiUsageQuery(machine);
  return (
    <div>
      <label className="flex items-center gap-2 text-sm text-fg-muted">
        <input type="checkbox" checked={checked} onChange={(e) => void toggle(e.target.checked)} />
        {t('Consultar o uso das contas de IA em {{machine}}', { machine: machine.name })}
      </label>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/**
 * Settings → Contas de IA, next to "Troca automática de conta": the same switch for every machine that
 * has an AI account. Shown only to who can update machines, since the setting lives on the machine.
 */
export function AiUsageQuerySettings({ machines, accounts }: { machines: Machine[]; accounts: AiAccount[] }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const rows = machines.filter((m) => accounts.some((a) => a.machine_id === m.id));
  if (!can('machines', 'update') || rows.length === 0) return null;

  return (
    <div className="mt-6 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">{t('Consulta de uso')}</h3>
      <p className="mt-1 text-xs text-fg-dim">
        {t('A credencial de login das ferramentas é lida e usada só na própria máquina; o termhub recebe apenas os números de uso. Desligado, o termhub não lê a credencial e as contas da máquina ficam sem as barras de uso.')}
      </p>
      <div className="mt-3 space-y-2">
        {rows.map((m) => (
          <MachineRow key={m.id} machine={m} />
        ))}
      </div>
    </div>
  );
}
