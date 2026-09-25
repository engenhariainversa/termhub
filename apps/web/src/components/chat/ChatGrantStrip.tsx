import type { ChatGrant } from '../../lib/types';
import { isGrantActive, untilLabel } from './grant-time';

/**
 * The trusted tabs of this conversation, right above the message box: while one is here the concierge
 * types into that tab without asking (spec 2026-09-25 §6). Presentational: `ChatPanel` owns the list
 * and the revoke call.
 */
export function ChatGrantStrip({ grants, revokingId, onRevoke }: { grants: ChatGrant[]; revokingId: string | null; onRevoke: (id: string) => void }) {
  const active = grants.filter((g) => isGrantActive(g));
  if (active.length === 0) return null;
  return (
    <ul aria-label="Abas confiadas" className="mb-2 space-y-1">
      {active.map((g) => (
        <li key={g.id} className="flex items-center justify-between gap-2 rounded-lg border border-attention/40 bg-bg-2 px-3 py-1.5 text-xs text-fg-dim">
          <span>
            Enviando direto para {g.tab_name ? `a aba ${g.tab_name}` : 'uma aba que não existe mais'} {untilLabel(g.expires_at)}
          </span>
          <button type="button" className="underline hover:text-fg" disabled={revokingId === g.id} onClick={() => onRevoke(g.id)}>
            Revogar
          </button>
        </li>
      ))}
    </ul>
  );
}
