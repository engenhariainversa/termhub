import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { i18n, useTranslation } from '../i18n';
import type { Tab } from '../lib/types';

/**
 * Shown above a tab whose Claude stopped on a usage limit (spec 2026-09-26 account swap). `autoSwap` is the
 * machine's setting: when it is off nothing happens by itself, and the banner says so (TER-587).
 */
export function RateLimitBanner({ tab, canSwap, autoSwap = true }: { tab: Pick<Tab, 'id' | 'state' | 'rate_limited_at'>; canSwap: boolean; autoSwap?: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!tab.rate_limited_at || tab.state === 'working') return null;
  const swap = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.tabs.swapAccount(tab.id);
      setDone(r.to.label);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível trocar de conta'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
      <span>{t('Limite de uso da conta atingido.')}</span>
      {!autoSwap && <span>{t('A troca automática está desligada nesta máquina.')}</span>}
      {done ? (
        <span>{t('Retomando em {{account}}…', { account: done })}</span>
      ) : (
        canSwap && (
          <button type="button" className="btn-ghost px-2 py-0.5 text-xs" disabled={busy} onClick={() => void swap()}>
            {busy ? t('Trocando…') : t('Trocar conta e retomar')}
          </button>
        )
      )}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
