/**
 * TER-1099: what a screen shows of a watch ("Acompanhando: PR #511 até o merge"), and the bus event that
 * keeps every open screen of the chat scope in step. Structured on purpose: the screens compose the
 * sentence in the person's language; `label` is the target's own name (data, not copy).
 */
import type { Repositories } from '../../db/repositories/index.js';
import type { ChatWatch } from '../../db/repositories/chat-watches.js';
import { chatBus } from '../bus.js';
import type { WatchKind } from './kinds.js';

export interface WatchView {
  id: string;
  kind: WatchKind;
  target_id: string | null;
  label: string;
  events: string[];
  recurring: boolean;
  note: string;
  created_at: string;
  expires_at: string;
  fire_count: number;
}

export const watchView = (w: ChatWatch): WatchView => ({
  id: w.id,
  kind: w.kind,
  target_id: w.target_id,
  label: w.label,
  events: w.params.events,
  recurring: w.recurring,
  note: w.note,
  created_at: w.created_at,
  expires_at: w.expires_at,
  fire_count: w.fire_count,
});

/** The open watches of a chat scope, for `GET /api/chat` and the phone's. */
export async function activeWatches(repos: Pick<Repositories, 'chatWatches'>, userId: string, projectId: string | null): Promise<WatchView[]> {
  return (await repos.chatWatches.listOpen(userId, projectId)).map(watchView);
}

/** Tells every open screen of the scope's active conversation its list changed. Never throws. */
export async function publishWatches(repos: Pick<Repositories, 'chat' | 'chatWatches'>, userId: string, projectId: string | null): Promise<void> {
  try {
    const conversation = projectId ? await repos.chat.getOrCreateForProject(userId, projectId) : await repos.chat.getOrCreateForUser(userId);
    chatBus.publish({ type: 'watches', user_id: userId, conversation_id: conversation.id, watches: await activeWatches(repos, userId, projectId) });
  } catch (err) {
    console.error('chat watches: the list could not be published', { user_id: userId, project_id: projectId, error: err instanceof Error ? err.name : 'unknown' });
  }
}

/** Cancels one of the person's open watches and tells the scope's screens; null when it is not theirs or no
 *  longer open. The concierge's `cancel_watch` and the chat's "Cancelar" (routes) both end here. */
export async function cancelWatchRow(repos: Pick<Repositories, 'chat' | 'chatWatches'>, userId: string, watchId: string): Promise<WatchView | null> {
  const row = await repos.chatWatches.cancel(watchId, userId);
  if (!row) return null;
  await publishWatches(repos, row.user_id, row.project_id);
  return watchView(row);
}
