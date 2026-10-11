import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

const POLL_MS = 60_000;

/** DevicesView dispatches this right after approve/deny/revoke, so the banner drops (or, one day,
 *  regains) its notice without waiting for the next poll. */
const DEVICES_CHANGED_EVENT = 'termhub:devices-changed';

/**
 * Global banner (spec §10.1): tells the signed-in user a phone is waiting for approval, wherever they
 * are in the app. Silent by design — no `can('devices')` means no API call at all, and a failed fetch
 * is treated the same as "nothing pending" rather than shown as an error.
 */
export function DeviceRequestBanner() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('devices');
  const [pending, setPending] = useState(0);

  const load = useCallback(() => {
    api.devices
      .summary()
      .then((s) => setPending(s.pending_requests))
      .catch(() => setPending(0));
  }, []);

  useEffect(() => {
    if (!allowed) return;
    load();
    const timer = window.setInterval(load, POLL_MS);
    window.addEventListener(DEVICES_CHANGED_EVENT, load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(DEVICES_CHANGED_EVENT, load);
    };
  }, [allowed, load]);

  if (!allowed || pending === 0) return null;

  return (
    <div className="bg-attention/10 border-b border-attention/40 px-4 py-2 text-sm">
      <span>{t('Um aparelho pede acesso à sua conta')}</span>{' '}
      <Link to="/settings/devices" className="font-medium text-accent hover:underline">
        {t('Ver pedido')}
      </Link>
    </div>
  );
}
