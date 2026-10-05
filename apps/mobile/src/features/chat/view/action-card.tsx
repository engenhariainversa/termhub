import { memo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { t, tk, useTranslation } from '@/i18n';
import { actionAutoDecision, isBoardGrantable, isTabGrantable, isTerminalGrantable, standingKindOf, type StandingGrantKind } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { untilLabel } from '../model/grant-time';
import { approveAlwaysLabel } from '../model/messages';
import { AutoDecisionBadge } from './auto-decision-badge';
import type { ChatDecision } from '../viewmodel/createChatStore';
import type { ChatAction, ChatGrant, ChatProjectGrant, ChatStandingGrant } from '../model/types';

const STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: tk('autorizada'),
  denied: tk('recusada'),
  expired: tk('expirada'),
  executed: tk('executada'),
  failed: tk('falhou'),
};

/** Why a `failed` card went stale rather than failing to run (spec 2026-09-30 §2.3): the gate refused
 * a decision that no longer fits the tab. Read as expired, with the reason — the web's `STALE_REASON`. */
const STALE_REASON: Record<string, string> = {
  TAB_GONE: tk('expirou: a aba foi fechada'),
  WAITING_PERMISSION: tk('expirou: a aba passou a pedir uma permissão'),
  PROMPT_CHANGED: tk('expirou: a aba está pedindo outra permissão'),
};

/** The line an expired or stale card reads, or null for any other card (TER-477). */
export function staleLabel(action: ChatAction): string | null {
  if (action.status === 'expired') return t('expirou sem resposta');
  if (action.status === 'failed') {
    const reason = STALE_REASON[action.error_code ?? ''];
    return reason ? t(reason) : null;
  }
  return null;
}

/** Tools whose standing grant trusts the project's tabs themselves (open, close, start an agent). */
const TAB_LIFECYCLE_TOOLS = new Set(['open_tab', 'close_tab', 'start_agent']);

/** What a call run under a grant adds to its status line — the web's `grantedLabel`. */
function grantedLabel(action: ChatAction): string {
  // TER-627: a default allowance of the chat, not a grant the person gave (`default:<kind>:<user>`).
  if (action.grant_id?.startsWith('default:')) return ` · ${t('liberado por padrão')}`;
  if (isBoardGrantable({ tool: action.tool })) return ` · ${t('quadro confiado')}`;
  if (TAB_LIFECYCLE_TOOLS.has(action.tool)) return ` · ${t('liberado no projeto')}`;
  return ` · ${t('aba confiada')}`;
}

/** "<Ação> liberado neste projeto, sem prazo" on the card that created a standing grant: one whole
 * sentence per standing kind (the contract's `STANDING_KIND_LABEL` is pt-BR only). */
function standingGrantedLabel(kind: StandingGrantKind): string {
  switch (kind) {
    case 'open_tab':
      return t('Abrir abas liberado neste projeto, sem prazo');
    case 'close_tab':
      return t('Fechar abas paradas liberado neste projeto, sem prazo');
    case 'start_agent':
      return t('Iniciar agentes liberado neste projeto, sem prazo');
    case 'board':
      return t('Mexer no quadro liberado neste projeto, sem prazo');
    case 'terminal':
      return t('Teclas e texto nas abas liberado neste projeto, sem prazo');
  }
}

type Props = {
  action: ChatAction;
  busy: boolean;
  onDecide(actionId: string, decision: ChatDecision): void;
  /** The tab grant this card created ("Permitir sempre nesta aba"), while it is still in force. */
  grant?: ChatGrant;
  /** The project grant this card created ("Permitir sempre neste projeto"), while it is still in force. */
  projectGrant?: ChatProjectGrant;
  /** The standing grant this card created ("Liberar sem prazo"), until it is revoked. */
  standingGrant?: ChatStandingGrant;
  revoking: boolean;
  onRevoke(grantId: string): void;
  /** "Propor de novo" on an expired or stale card (TER-477): asks the concierge for a fresh card. */
  onRepropose?(action: ChatAction): void;
};

/** A write the concierge proposed: its server-composed summary, and Autorizar (PIN) / Recusar while
 * pending — plus "Permitir sempre nesta aba" (PIN) for a send_input to a tab, or "Permitir sempre
 * neste projeto" (PIN) for one of the four board tools, and the wider "Liberar teclas e shell nesta
 * aba" (a send_input/send_key to a tab) and "Liberar tudo neste projeto" (either kind), each with the
 * PIN and its own proof word, and "Liberar sem prazo: <ação> neste projeto" (PIN, TER-386) when the card
 * maps to a standing kind — or how it ended ("· aba confiada" / "· quadro confiado" / "· liberado no
 * projeto" when it ran under a grant), and "Permitido até HH:MM · Revogar" (or "…, sem prazo · Revogar")
 * on the card that created the grant. An expired or stale card says why and offers "Propor de novo"
 * (TER-477), with a muted border: it waits on nobody. Memoised: `onDecide` and `onRevoke` are the store's own
 * (stable) actions. */
export const ActionCard = memo(function ActionCard({ action, busy, onDecide, grant, projectGrant, standingGrant, revoking, onRevoke, onRepropose }: Props) {
  const { t } = useTranslation();
  // explicit fields: the contract infers `args` (z.unknown) as optional
  const terminal = isTerminalGrantable({ tool: action.tool, args: action.args, tab_id: action.tab_id });
  const standingKind = standingKindOf({ tool: action.tool, args: action.args, tab_id: action.tab_id, project_id: action.project_id });
  const stale = staleLabel(action);
  const autoDecision = actionAutoDecision(action);
  // TER-984: a call that ran under a grant asked nobody, so it reads as one line — what it did and how
  // it ended — and opens to the whole card on a tap. A card that asks (or asked) keeps its full form.
  const compact = Boolean(action.grant_id) && action.status !== 'pending' && !stale;
  const [expanded, setExpanded] = useState(false);
  const statusLine = action.status === 'pending' ? '' : `${t(STATUS_LABEL[action.status])}${action.grant_id ? grantedLabel(action) : ''}`;
  if (compact && !expanded) {
    return (
      <Pressable
        testID={`action-card-${action.id}`}
        accessibilityRole="button"
        accessibilityLabel={t('Ver detalhes')}
        accessibilityState={{ expanded: false }}
        onPress={() => setExpanded(true)}
        className="flex-row items-center gap-2 rounded-xl px-2 py-1"
      >
        <AppText variant="muted">{action.status === 'failed' ? '✗' : '✓'}</AppText>
        {/* First line only: the whole sentence is in the expanded card. */}
        <AppText variant="muted" numberOfLines={1} className="flex-1">
          {action.summary.split('\n')[0]}
        </AppText>
        <AppText variant="muted">{statusLine}</AppText>
        {autoDecision ? <AutoDecisionBadge decision={autoDecision} /> : null}
      </Pressable>
    );
  }
  return (
    <View testID={`action-card-${action.id}`} className={`gap-3 rounded-2xl border ${stale ? 'border-app-border' : 'border-app-accent'} bg-app-surface2 p-4`}>
      <View className="flex-row items-center justify-between gap-2">
        <AppText variant="label">{t('Pedido de confirmação')}</AppText>
        {compact ? <Button label={t('Recolher')} variant="ghost" onPress={() => setExpanded(false)} /> : null}
      </View>
      <AppText>{action.summary}</AppText>
      {/* The subagent whose turn proposed this action (spec 2026-09-26 §4), when there is one. */}
      {action.subagent ? <AppText variant="muted">{t('Pedido pelo subagente «{{description}}»', { description: action.subagent.description })}</AppText> : null}
      {action.status === 'pending' ? (
        <View className="gap-2">
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label={t('Autorizar')} onPress={() => onDecide(action.id, 'approve')} disabled={busy} />
            </View>
            <View className="flex-1">
              <Button label={t('Recusar')} variant="secondary" onPress={() => onDecide(action.id, 'deny')} disabled={busy} />
            </View>
          </View>
          {/* explicit fields: the contract infers `args` (z.unknown) as optional */}
          {isTabGrantable({ tool: action.tool, args: action.args, tab_id: action.tab_id }) ? (
            <Button label={t('Permitir sempre nesta aba')} variant="secondary" onPress={() => onDecide(action.id, 'approve_tab')} disabled={busy} />
          ) : null}
          {isBoardGrantable({ tool: action.tool }) ? (
            <Button label={t('Permitir sempre neste projeto')} variant="secondary" onPress={() => onDecide(action.id, 'approve_project')} disabled={busy} />
          ) : null}
          {terminal ? (
            <Button label={t('Liberar teclas e shell nesta aba')} variant="secondary" onPress={() => onDecide(action.id, 'approve_tab_terminal')} disabled={busy} />
          ) : null}
          {terminal || isBoardGrantable({ tool: action.tool }) ? (
            <Button label={t('Liberar tudo neste projeto')} variant="secondary" onPress={() => onDecide(action.id, 'approve_project_all')} disabled={busy} />
          ) : null}
          {standingKind ? (
            <Button label={approveAlwaysLabel(standingKind)} variant="secondary" onPress={() => onDecide(action.id, 'approve_project_always')} disabled={busy} />
          ) : null}
        </View>
      ) : stale ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">
            {stale}
          </AppText>
          {onRepropose ? <Button label={t('Propor de novo')} variant="ghost" onPress={() => onRepropose(action)} /> : null}
        </View>
      ) : (
        <AppText variant="muted">{statusLine}</AppText>
      )}
      {/* TER-641: sent without a click on a precedent from memory — apart from the allowance it ran under. */}
      {autoDecision ? <AutoDecisionBadge decision={autoDecision} /> : null}
      {grant ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">{grant.tool === 'terminal' ? t('Teclas e shell liberados nesta aba {{until}}', { until: untilLabel(grant.expires_at) }) : t('Permitido {{until}}', { until: untilLabel(grant.expires_at) })}</AppText>
          <Button label={t('Revogar')} variant="ghost" onPress={() => onRevoke(grant.id)} disabled={revoking} />
        </View>
      ) : null}
      {projectGrant ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">{projectGrant.scope === 'all' ? t('Tudo liberado neste projeto {{until}}', { until: untilLabel(projectGrant.expires_at) }) : t('Permitido neste projeto {{until}}', { until: untilLabel(projectGrant.expires_at) })}</AppText>
          <Button label={t('Revogar')} variant="ghost" onPress={() => onRevoke(projectGrant.id)} disabled={revoking} />
        </View>
      ) : null}
      {standingGrant ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">{standingGrantedLabel(standingGrant.kind)}</AppText>
          <Button label={t('Revogar')} variant="ghost" onPress={() => onRevoke(standingGrant.id)} disabled={revoking} />
        </View>
      ) : null}
    </View>
  );
});
