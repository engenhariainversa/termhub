import { useState } from 'react';
import { ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { useTranslation } from '../i18n';
import type { Machine } from '../lib/types';

/**
 * Machine form, Monitor tab: whether this machine's Claude permission cards show what they approve — the
 * start of the command or the file's name (TER-614). Off by default: on, the prompt leaves the machine
 * whole and the server keeps a filtered excerpt of it, which the text below says plainly. The server
 * changes the machine first, so a refusal (offline, outdated agent) reverts the box with its reason.
 */
export function PermissionHintCard({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const { setMachinePermissionHint } = useData();
  const [enabled, setEnabled] = useState(machine.permission_hint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setEnabled(next);
    setBusy(true);
    setError(null);
    try {
      await setMachinePermissionHint(machine.id, next);
    } catch (e) {
      setEnabled(!next);
      setError(e instanceof ApiError ? e.message : t('Erro ao salvar'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <label className="flex items-center gap-2 font-medium text-fg-muted">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        {t('Mostrar o que a permissão aprova')}
      </label>
      <p className="mt-1 text-fg-dim">
        {t('O card de permissão do Claude passa a mostrar o começo do comando ou o nome do arquivo, e só aprova o diálogo que mostra esse trecho. Para isso o pedido de permissão sai inteiro da máquina; o termhub guarda só o trecho, com tokens, senhas e chaves trocados por •••. O filtro não pega todo segredo possível: ligue só se aceitar isso.')}
      </p>
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
