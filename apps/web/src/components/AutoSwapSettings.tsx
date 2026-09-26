import { useState } from 'react';
import { ApiError } from '../lib/api';
import { useData } from '../lib/data';
import type { AiAccount, Machine } from '../lib/types';

/** One machine's row: a checkbox with an optimistic toggle, reverted on error (like AgentUpdateCard's `setAuto`). */
function MachineRow({ machine }: { machine: Machine }) {
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
      setError(e instanceof ApiError ? e.message : 'Erro ao salvar');
    }
  };

  return (
    <div>
      <label className="flex items-center gap-2 text-sm text-fg-muted">
        <input type="checkbox" checked={checked} onChange={(e) => void toggle(e.target.checked)} />
        Trocar de conta sozinho quando o Claude atingir o limite em {machine.name}
      </label>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Settings → Contas de IA: one checkbox per machine with 2+ Claude accounts (spec 2026-09-26 account swap). */
export function AutoSwapSettings({ machines, accounts }: { machines: Machine[]; accounts: AiAccount[] }) {
  const counts = new Map<string, number>();
  for (const a of accounts) if (a.provider === 'claude') counts.set(a.machine_id, (counts.get(a.machine_id) ?? 0) + 1);
  const eligible = machines.filter((m) => (counts.get(m.id) ?? 0) >= 2);
  if (eligible.length === 0) return null;

  return (
    <div className="mt-6 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">Troca automática de conta</h3>
      <p className="mt-1 text-xs text-fg-dim">
        Quando uma aba do Claude atingir o limite de uso, o termhub retoma a mesma sessão em outra conta desta máquina.
      </p>
      <div className="mt-3 space-y-2">
        {eligible.map((m) => (
          <MachineRow key={m.id} machine={m} />
        ))}
      </div>
    </div>
  );
}
