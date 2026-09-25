import type { ChatAction, ChatGrant } from '../../lib/types';
import { untilLabel } from './grant-time';

/** How a decided action reads once there is nothing left to click. `pending` has its own buttons
 * instead of a label here. */
const ACTION_STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: 'Autorizado',
  denied: 'Recusado',
  expired: 'Expirou sem resposta',
  executed: 'Executado',
  failed: 'Falhou',
};

/** Mirrors the server's `grantable` (apps/server/src/chat/gate.ts): the server refuses anything else. */
export function isTabGrantable(action: ChatAction): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return action.tool === 'send_input' && args.answering_permission !== true && Boolean(action.tab_id);
}

export interface ChatActionCardProps {
  action: ChatAction;
  /** This card's decision is in flight (`decidingId` in `ChatPage`): its buttons are disabled. */
  deciding: boolean;
  /** The server's pt-BR note for a decision queued behind a busy run (`queuedNotes` in `ChatPage`). */
  note?: string;
  /** The active grant this card created ("Permitir sempre nesta aba"), if it is still in force. */
  grant?: ChatGrant;
  revoking?: boolean;
  onRevoke?: () => void;
  onDecide: (decision: 'approve' | 'deny' | 'approve_tab') => void;
}

/**
 * One gate card, inline in the thread where the concierge proposed it. Presentational only: the
 * request, the decision call and the queued note all live in `ChatPage`.
 */
export function ChatActionCard({ action, deciding, note, grant, revoking, onRevoke, onDecide }: ChatActionCardProps) {
  return (
    <li className="rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm">
      {/* Plain text only — never HTML: this sentence can carry a command the model read off a real terminal screen. */}
      <p className="whitespace-pre-wrap text-fg">{action.summary}</p>
      {action.status === 'pending' ? (
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn-primary" disabled={deciding} onClick={() => onDecide('approve')}>
            Autorizar
          </button>
          {isTabGrantable(action) && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide('approve_tab')}>
              Permitir sempre nesta aba
            </button>
          )}
          <button type="button" className="btn-danger" disabled={deciding} onClick={() => onDecide('deny')}>
            Recusar
          </button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-fg-dim">
          {ACTION_STATUS_LABEL[action.status]}
          {action.grant_id ? ' · aba confiada' : ''}
        </p>
      )}
      {grant && (
        <p className="mt-1 flex items-center gap-2 text-xs text-fg-dim">
          <span>Permitido nesta aba {untilLabel(grant.expires_at)}</span>
          <button type="button" className="underline hover:text-fg" disabled={revoking} onClick={onRevoke}>
            Revogar
          </button>
        </p>
      )}
      {note && <p className="mt-1 text-xs text-fg-dim">{note}</p>}
    </li>
  );
}
