import { useState } from 'react';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import type { AiAccount, Machine } from '../lib/types';
import { useTranslation } from '../i18n';

/** One machine's row: a checkbox with an optimistic toggle, reverted on error (like AgentUpdateCard's `setAuto`). */
function MachineRow({ machine, defaultUnregistered }: { machine: Machine; defaultUnregistered: boolean }) {
  const { t } = useTranslation();
  const { updateMachine } = useData();
  const [checked, setChecked] = useState(machine.claude_auto_swap);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setChecked(next);
    setError(null);
    try {
      await updateMachine(machine.id, { claude_auto_swap: next });
    } catch (e) {
      setChecked(!next);
      setError(e instanceof ApiError ? e.message : t('Erro ao salvar'));
    }
  };

  return (
    <div>
      <label className="flex items-center gap-2 text-sm text-fg-muted">
        <input type="checkbox" checked={checked} onChange={(e) => void toggle(e.target.checked)} />
        {t('Trocar de conta sozinho quando o Claude atingir o limite em {{machine}}', { machine: machine.name })}
      </label>
      {defaultUnregistered && (
        <p className="mt-1 text-xs text-fg-dim">
          {t('A conta padrão do Claude em {{machine}} não está cadastrada: as abas dela passam para as contas cadastradas, mas nenhuma aba volta para ela.', { machine: machine.name })}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/**
 * Settings → Contas de IA: one checkbox per machine with two or more Claude accounts (spec 2026-09-26
 * account swap). The machine's default login (no config dir) counts even when nobody registered it
 * (TER-587): tabs started without an account run on it, so one registered account in another config
 * dir already gives them somewhere to go. The setting lives on the machine, so it is shown only to who
 * can update machines.
 */
export function AutoSwapSettings({ machines, accounts }: { machines: Machine[]; accounts: AiAccount[] }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const claude = accounts.filter((a) => a.provider === 'claude');
  const rows = machines.flatMap((m) => {
    const here = claude.filter((a) => a.machine_id === m.id);
    const defaultUnregistered = m.capabilities.includes('claude') && here.length > 0 && !here.some((a) => a.config_dir === null);
    return here.length + (defaultUnregistered ? 1 : 0) >= 2 ? [{ machine: m, defaultUnregistered }] : [];
  });
  if (!can('machines', 'update') || rows.length === 0) return null;

  return (
    <div className="mt-6 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">{t('Troca automática de conta')}</h3>
      <p className="mt-1 text-xs text-fg-dim">
        {t('Quando uma aba do Claude atingir o limite de uso, o termhub retoma a mesma sessão em outra conta desta máquina.')}
      </p>
      <div className="mt-3 space-y-2">
        {rows.map((r) => (
          <MachineRow key={r.machine.id} machine={r.machine} defaultUnregistered={r.defaultUnregistered} />
        ))}
      </div>
    </div>
  );
}
