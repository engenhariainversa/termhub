import { memo } from 'react';
import { View } from 'react-native';
import { isTabGrantable } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { untilLabel } from '../model/grant-time';
import type { ChatDecision } from '../viewmodel/createChatStore';
import type { ChatAction, ChatGrant } from '../model/types';

const STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: 'autorizada',
  denied: 'recusada',
  expired: 'expirada',
  executed: 'executada',
  failed: 'falhou',
};

type Props = {
  action: ChatAction;
  busy: boolean;
  onDecide(actionId: string, decision: ChatDecision): void;
  /** The grant this card created, while it is still in force. */
  grant?: ChatGrant;
  revoking: boolean;
  onRevoke(grantId: string): void;
};

/** A write the concierge proposed: its server-composed summary, and Autorizar (PIN) / Recusar while
 * pending — plus "Permitir sempre nesta aba" (PIN) for a send_input to a tab — or how it ended
 * ("· aba confiada" when it ran under a grant), and "Permitido até HH:MM · Revogar" on the card
 * that trusted its tab. Memoised: `onDecide` and `onRevoke` are the store's own (stable) actions. */
export const ActionCard = memo(function ActionCard({ action, busy, onDecide, grant, revoking, onRevoke }: Props) {
  return (
    <View className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      <AppText variant="label">Pedido de confirmação</AppText>
      <AppText>{action.summary}</AppText>
      {action.status === 'pending' ? (
        <View className="gap-2">
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label="Autorizar" onPress={() => onDecide(action.id, 'approve')} disabled={busy} />
            </View>
            <View className="flex-1">
              <Button label="Recusar" variant="secondary" onPress={() => onDecide(action.id, 'deny')} disabled={busy} />
            </View>
          </View>
          {/* explicit fields: the contract infers `args` (z.unknown) as optional */}
          {isTabGrantable({ tool: action.tool, args: action.args, tab_id: action.tab_id }) ? (
            <Button label="Permitir sempre nesta aba" variant="secondary" onPress={() => onDecide(action.id, 'approve_tab')} disabled={busy} />
          ) : null}
        </View>
      ) : (
        <AppText variant="muted">{`${STATUS_LABEL[action.status]}${action.grant_id ? ' · aba confiada' : ''}`}</AppText>
      )}
      {grant ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">{`Permitido ${untilLabel(grant.expires_at)}`}</AppText>
          <Button label="Revogar" variant="ghost" onPress={() => onRevoke(grant.id)} disabled={revoking} />
        </View>
      ) : null}
    </View>
  );
});
