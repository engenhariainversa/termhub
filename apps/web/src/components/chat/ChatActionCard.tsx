import { i18n, tk, useTranslation } from '../../i18n';
import { memo, useState } from 'react';
import type { ChatAction, ChatDecisionWord, ChatGrant, ChatProjectGrant, ChatStandingGrant, ChatStandingKind } from '../../lib/types';
import { actionAutoDecision, AutoDecisionBadge } from './AutoDecisionBadge';
import { STANDING_KIND_LABEL, standingKindLabel } from './grant-list-text';
import { untilLabel } from './grant-time';
import { ChatReplyButton } from './ChatReplyButton';

/** How a decided action reads once there is nothing left to click. `pending` has its own buttons
 * instead of a label here. */
const ACTION_STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: tk('Autorizado'),
  denied: tk('Recusado'),
  expired: tk('Expirou sem resposta'),
  executed: tk('Executado'),
  failed: tk('Falhou'),
};

/** Why a `failed` card went stale rather than failing to run (TER-477): the gate refused to run a
 * decision that no longer fits the tab. Read as "Expirou", with the reason. */
const STALE_REASON: Record<string, string> = {
  TAB_GONE: tk('Expirou: a aba foi fechada'),
  WAITING_PERMISSION: tk('Expirou: a aba passou a pedir uma permissão'),
  PROMPT_CHANGED: tk('Expirou: a aba está pedindo outra permissão'),
};

/** The line an expired or stale card reads, or null for any other card (TER-477). */
export function staleLabel(action: ChatAction): string | null {
  if (action.status === 'expired') return i18n.t(ACTION_STATUS_LABEL.expired);
  if (action.status === 'failed') {
    const reason = STALE_REASON[action.error_code ?? ''];
    return reason ? i18n.t(reason) : null;
  }
  return null;
}

/** Mirrors the server's `grantable` (apps/server/src/chat/gate.ts): the server refuses anything else. */
export function isTabGrantable(action: ChatAction): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return action.tool === 'send_input' && args.answering_permission !== true && Boolean(action.tab_id);
}

/** The tools "Permitir sempre neste projeto" can trust: every write that only ever touches the board. */
const BOARD_GRANT_TOOLS = new Set(['create_task', 'add_subtasks', 'update_task', 'move_task']);
/** Mirrors the server's `BOARD_GRANT_TOOLS`; the server still refuses a card whose project does not resolve. */
export const isBoardGrantable = (action: ChatAction): boolean => BOARD_GRANT_TOOLS.has(action.tool);

/** Mirrors the server's `terminalGrantable` (apps/server/src/chat/gate.ts). */
export function isTerminalGrantable(action: ChatAction): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return (action.tool === 'send_input' || action.tool === 'send_key') && args.answering_permission !== true && Boolean(action.tab_id);
}

/** Mirrors the server's `standingKindOf` (apps/server/src/chat/gate.ts, and its copy in
 * `packages/mobile-api`): which "Liberar sem prazo" kind this card may offer, or null. The server is the
 * judge and also refuses a card whose project (or tab) does not resolve. */
export function standingKindOf(action: ChatAction): ChatStandingKind | null {
  if (action.tool === 'open_tab' || action.tool === 'start_agent') return action.project_id ? action.tool : null;
  if (action.tool === 'close_tab') return action.tab_id ? 'close_tab' : null;
  if (isBoardGrantable(action)) return 'board';
  if (isTerminalGrantable(action)) return 'terminal';
  return null;
}

/** Tools whose standing grant trusts the project's tabs themselves (open, close, start an agent). */
const TAB_LIFECYCLE_TOOLS = new Set(['open_tab', 'close_tab', 'start_agent']);

/** What a call run under a grant adds to its "Executado" line (after a space). */
function grantedLabel(action: ChatAction): string {
  // TER-627: a default allowance, not a grant the person gave (`default:<kind>:<user>`).
  if (action.grant_id?.startsWith('default:')) return i18n.t('· liberado por padrão');
  if (isBoardGrantable(action)) return i18n.t('· quadro confiado');
  if (TAB_LIFECYCLE_TOOLS.has(action.tool)) return i18n.t('· liberado no projeto');
  return i18n.t('· aba confiada');
}

export interface ChatActionCardProps {
  action: ChatAction;
  /** This card's decision is in flight (`decidingId` in `ChatPanel`): its buttons are disabled. */
  deciding: boolean;
  /** The server's note (in the request's language) for a decision queued behind a busy run (`queuedNotes` in `ChatPanel`). */
  note?: string;
  /** The active grant this card created ("Permitir sempre nesta aba"), if it is still in force. */
  grant?: ChatGrant;
  /** The active project grant this card created ("Permitir sempre neste projeto"), if still in force. */
  projectGrant?: ChatProjectGrant;
  /** The standing grant this card created ("Liberar sem prazo"), if it has not been revoked. */
  standingGrant?: ChatStandingGrant;
  revoking?: boolean;
  /** Takes the grant's id, so the panel can pass one stable callback to every card. */
  onRevoke?: (grantId: string) => void;
  /** Takes the action's id, for the same reason. */
  onDecide: (id: string, decision: ChatDecisionWord) => void;
  /** "Propor de novo" on an expired or stale card (TER-477): asks the concierge for a fresh card. */
  onRepropose?: (action: ChatAction) => void;
  /** "Responder" (TER-849): quotes this card in the composer; absent, the button is not offered. */
  onReply?: (action: ChatAction) => void;
}

/**
 * One gate card, inline in the thread where the concierge proposed it. Presentational only: the
 * request, the decision call and the queued note all live in `ChatPanel`. Memoised, with callbacks
 * that take the id: a streamed delta re-renders the panel, and this card must not follow.
 */
export const ChatActionCard = memo(function ChatActionCard({ action, deciding, note, grant, projectGrant, standingGrant, revoking, onRevoke, onDecide, onRepropose, onReply }: ChatActionCardProps) {
  const { t } = useTranslation();
  const standingKind = standingKindOf(action);
  const stale = staleLabel(action);
  const autoDecision = actionAutoDecision(action);
  // TER-984: a call that ran under a grant asked nobody, so it reads as one line — what it did and how
  // it ended — and opens to the whole card on a click. A card that asks (or asked) keeps its full form.
  const compact = Boolean(action.grant_id) && action.status !== 'pending' && !stale;
  const [expanded, setExpanded] = useState(false);
  const statusLine = action.status === 'pending' ? '' : `${t(ACTION_STATUS_LABEL[action.status])}${action.grant_id ? ` ${grantedLabel(action)}` : ''}`;
  if (compact && !expanded) {
    return (
      <li data-chat-card={action.id} data-compact="" className="chat-enter flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-xs text-fg-dim">
        <span aria-hidden="true" className={action.status === 'failed' ? 'text-danger' : 'text-ok'}>
          {action.status === 'failed' ? '✗' : '✓'}
        </span>
        {/* Plain text, first line only: the whole sentence (never HTML) is in the expanded card. */}
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={action.summary}>
          {action.summary.split('\n')[0]}
        </span>
        <span className="shrink-0">{statusLine}</span>
        {autoDecision && <AutoDecisionBadge decision={autoDecision} />}
        <button type="button" className="shrink-0 underline hover:text-fg" aria-expanded={false} onClick={() => setExpanded(true)}>
          {t('Ver detalhes')}
        </button>
      </li>
    );
  }
  return (
    // `data-chat-card`: how the pending bar finds this card to scroll to it (TER-477). A stale card waits
    // on nobody, so it drops the attention border.
    <li data-chat-card={action.id} className={`chat-enter group rounded-xl border ${stale ? 'border-line' : 'border-attention/40'} bg-bg-2 px-4 py-3 text-sm`}>
      <div className="flex items-start gap-2">
        {/* Plain text only — never HTML: this sentence can carry a command the model read off a real terminal screen. */}
        <p className="flex-1 whitespace-pre-wrap text-fg">{action.summary}</p>
        {onReply && <ChatReplyButton onClick={() => onReply(action)} />}
        {compact && (
          <button type="button" className="text-xs text-fg-dim underline hover:text-fg" aria-expanded onClick={() => setExpanded(false)}>
            {t('Recolher')}
          </button>
        )}
      </div>
      {/* The subagent whose turn proposed this action (spec 2026-09-26 §4), when there is one. */}
      {action.subagent && <p className="text-xs text-fg-dim">{t('Pedido pelo subagente «{{name}}»', { name: action.subagent.description })}</p>}
      {action.status === 'pending' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={deciding} onClick={() => onDecide(action.id, 'approve')}>
            {t('Autorizar')}
          </button>
          {isTabGrantable(action) && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_tab')}>
              {t('Permitir sempre nesta aba')}
            </button>
          )}
          {isBoardGrantable(action) && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_project')}>
              {t('Permitir sempre neste projeto')}
            </button>
          )}
          {isTerminalGrantable(action) && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_tab_terminal')}>
              {t('Liberar teclas e shell nesta aba')}
            </button>
          )}
          {(isTerminalGrantable(action) || isBoardGrantable(action)) && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_project_all')}>
              {t('Liberar tudo neste projeto')}
            </button>
          )}
          {standingKind && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_project_always')}>
              {t('Liberar sem prazo: {{kind}} neste projeto', { kind: STANDING_KIND_LABEL[standingKind] })}
            </button>
          )}
          <button type="button" className="btn-danger" disabled={deciding} onClick={() => onDecide(action.id, 'deny')}>
            {t('Recusar')}
          </button>
        </div>
      ) : stale ? (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-dim">
          <span>{stale}</span>
          {onRepropose && (
            <button type="button" className="btn-ghost text-xs" onClick={() => onRepropose(action)}>
              {t('Propor de novo')}
            </button>
          )}
        </p>
      ) : (
        <p className="mt-1 text-xs text-fg-dim">{statusLine}</p>
      )}
      {/* TER-641: sent without a click on a precedent from memory — apart from the allowance it ran under. */}
      {autoDecision && <AutoDecisionBadge decision={autoDecision} />}
      {grant && (
        <p className="mt-1 flex items-center gap-2 text-xs text-fg-dim">
          <span>
            {grant.tool === 'terminal' ? t('Teclas e shell liberados nesta aba') : t('Permitido nesta aba')} {untilLabel(grant.expires_at)}
          </span>
          <button type="button" className="underline hover:text-fg" disabled={revoking} onClick={() => onRevoke?.(grant.id)}>
            {t('Revogar')}
          </button>
        </p>
      )}
      {projectGrant && (
        <p className="mt-1 flex items-center gap-2 text-xs text-fg-dim">
          <span>
            {projectGrant.scope === 'all' ? t('Tudo liberado neste projeto') : t('Permitido neste projeto')} {untilLabel(projectGrant.expires_at)}
          </span>
          <button type="button" className="underline hover:text-fg" disabled={revoking} onClick={() => onRevoke?.(projectGrant.id)}>
            {t('Revogar')}
          </button>
        </p>
      )}
      {standingGrant && (
        <p className="mt-1 flex items-center gap-2 text-xs text-fg-dim">
          <span>{t('{{kind}} liberado neste projeto, sem prazo', { kind: standingKindLabel(standingGrant.kind) })}</span>
          <button type="button" className="underline hover:text-fg" disabled={revoking} onClick={() => onRevoke?.(standingGrant.id)}>
            {t('Revogar')}
          </button>
        </p>
      )}
      {note && <p className="mt-1 text-xs text-fg-dim">{note}</p>}
    </li>
  );
});
