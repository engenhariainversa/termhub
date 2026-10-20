import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Machine, NetworkCheck } from '../lib/types';
import { tk, useTranslation } from '../i18n';

const LABEL: Record<NetworkCheck['name'], string> = { hooks: tk('Hooks do monitor'), mcp: tk('MCP das abas') };

/**
 * Machine form: whether the machine reaches the monitor hooks and MCP addresses (TER-586). The agent
 * reaching /agent/ws proves nothing about them, and they may sit on another host: a firewall that lets
 * only the app host through leaves the agent connected and the monitor silent. Same check as
 * `termhub-agent doctor`.
 */
export function NetworkCheckCard({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const [checks, setChecks] = useState<NetworkCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (isCancelled: () => boolean = () => false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.machines.networkCheck(machine.id);
      if (!isCancelled()) setChecks(r.checks);
    } catch (e) {
      if (!isCancelled()) setError(e instanceof ApiError ? e.message : t('Erro ao testar'));
    } finally {
      if (!isCancelled()) setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void run(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id]);

  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <div className="flex items-center gap-2">
        <p className="font-medium text-fg-muted">{t('Endereços dos hooks e do MCP')}</p>
        <button type="button" className="btn-ghost ml-auto border border-line px-2 py-0.5" disabled={busy} onClick={() => void run()}>
          {busy ? t('Testando…') : t('Testar de novo')}
        </button>
      </div>
      <p className="mt-1 text-fg-dim">{t('Da máquina, um POST sem token em cada endereço: o termhub responde 401. Se o firewall liberar só o endereço do agente, ele conecta mas o monitor fica mudo.')}</p>
      {checks && (
        <ul className="mt-1 space-y-0.5">
          {checks.map((c) => (
            <li key={c.name}>
              <span className={c.ok ? 'text-ok' : 'text-danger'}>{c.ok ? '✓' : '✗'}</span> {t(LABEL[c.name])} <span className="font-mono text-fg-dim">({c.host})</span>
              {!c.ok && (
                <>
                  <span className="text-fg-muted">: {c.status !== null ? t('respondeu HTTP {{status}} (esperado 401)', { status: c.status }) : (c.error ?? t('sem resposta'))}</span>
                  <p className="pl-3 text-fg-dim">{t('Libere {{url}} no firewall/proxy desta máquina.', { url: c.url })}</p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
