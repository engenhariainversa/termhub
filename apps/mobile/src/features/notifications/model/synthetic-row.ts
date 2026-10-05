// The unread row a live `confirmation` event (design spec §7, ruling) prepends into
// `useNotificationsStore` before the server's own row has been fetched: same shape as a real
// `TNotificationRow`, but with an id the store can tell apart from a server-issued one.
import { t } from '@/i18n';
import type { TChatEvent, TNotificationRow } from '@/services/api/contract';

type ConfirmationEvent = Extract<TChatEvent, { type: 'confirmation' }>;

/** `local:<action_id>` — never collides with a server id, and lets a caller find the placeholder
 * for one `action_id` without keeping its own map. */
export const localRowId = (actionId: string): string => `local:${actionId}`;

/** Whether `id` is a placeholder's (`localRowId`) — the server has never heard of it. */
export const isLocalRowId = (id: string): boolean => id.startsWith('local:');

/**
 * Builds the placeholder row for a `confirmation` event: the fixed title of P§9's first trigger,
 * and a body naming the project when the caller already knows it (the chat store's `projects`
 * list) — otherwise the same generic sentence the mock uses for the account-wide chat, since the
 * row is replaced by the server's own text on the next `load()` anyway.
 */
export function syntheticConfirmationRow(event: ConfirmationEvent, projectName: string | null, now: number): TNotificationRow {
  const body = projectName
    ? t('O chat do projeto {{projectName}} pediu confirmação para agir.', { projectName })
    : t('O chat geral pediu confirmação para agir.');
  return {
    id: localRowId(event.action_id),
    kind: 'confirmation',
    title: t('termhub precisa de você'),
    body,
    data: { conversation_id: event.conversation_id, project_id: event.project_id, action_id: event.action_id },
    created_at: new Date(now).toISOString(),
    read_at: null,
  };
}
