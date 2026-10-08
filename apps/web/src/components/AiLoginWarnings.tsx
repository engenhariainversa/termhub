import { useState } from 'react';
import { useTranslation } from '../i18n';
import { useAiLoginStatus } from '../lib/ai-login-status';
import type { AiLoginStatusRow } from '../lib/types';
import { AI_CLI_LABEL, AiLoginDialog } from './AiLoginDialog';

/**
 * Red "the login of X expired on Y" lines (TER-1047), each with "Refazer login" opening the modal: in the
 * sidebar (every account) and on a machine's row in Máquinas (`machineId`). Nothing when all is well.
 */
export function AiLoginWarnings({ machineId, className = '' }: { machineId?: string; className?: string }) {
  const { t } = useTranslation();
  const { needsLogin } = useAiLoginStatus();
  const [open, setOpen] = useState<AiLoginStatusRow | null>(null);
  const rows = machineId ? needsLogin.filter((r) => r.machine_id === machineId) : needsLogin;
  if (rows.length === 0 && !open) return null;
  return (
    <>
      {rows.length > 0 && (
        <ul className={`space-y-1 ${className}`} aria-label={t('Logins de IA expirados')}>
          {rows.map((r) => (
            <li key={r.account_id} className="flex items-center gap-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger">
              <span className="min-w-0 flex-1 truncate" title={r.label}>
                {t('O login do {{provider}} expirou em {{machine}}', { provider: AI_CLI_LABEL[r.provider], machine: r.machine_name ?? t('Máquina desconhecida') })}
              </span>
              <button type="button" className="shrink-0 rounded px-1 font-medium underline hover:bg-danger/20" onClick={() => setOpen(r)}>
                {t('Refazer login')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <AiLoginDialog account={open} onClose={() => setOpen(null)} />}
    </>
  );
}
