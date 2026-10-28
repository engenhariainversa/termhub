/**
 * TER-1099: what a screen shows of a watch ("Acompanhando: PR #511 até o merge"), and the bus event that
 * keeps every open screen of the chat scope in step. Structured on purpose: the screens compose the
 * sentence in the person's language; `label` is the target's own name (data, not copy).
 *
 * TER-1115: `summary` is the concierge's line for the person ("Te aviso quando a aba OPM-568 parar"); its
 * `note` is its own instructions to itself and never reaches a screen (`forScreen` blanks it). The screens
 * also get what already happened (`last_event`, `last_fired_at`, `fire_count`) and, for a tab, its state now.
 */
import type { Repositories } from '../../db/repositories/index.js';
import type { TabState } from '../../db/repositories/types.js';
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
  /** The concierge's own note: `list_watches` only. Always '' on a screen (an installed app still expects the field). */
  note: string;
  /** TER-1115: the concierge's line for the person; null on watches made before it. */
  summary: string | null;
  created_at: string;
  expires_at: string;
  fire_count: number;
  /** TER-1115: the last event it caught and when; null until it fires. */
  last_event: string | null;
  last_fired_at: string | null;
  /** TER-1141: when the person last asked the concierge for its status ("status pedido às 14:32"). */
  last_pinged_at: string | null;
  /** TER-1115, tabs only (null otherwise): the tab's state now (`working`, `finished`…), for "trabalhando agora". */
  target_state: TabState | null;
  /** TER-1100, reminders only (null otherwise): when it is due next, and every how many minutes it repeats. */
  next_at: string | null;
  every_minutes: number | null;
}

export const watchView = (w: ChatWatch): WatchView => ({
  id: w.id,
  kind: w.kind,
  target_id: w.target_id,
  label: w.label,
  events: w.params.events,
  recurring: w.recurring,
  note: w.note,
  summary: w.summary,
  created_at: w.created_at,
  expires_at: w.expires_at,
  fire_count: w.fire_count,
  last_event: w.last_event,
  last_fired_at: w.last_fired_at,
  last_pinged_at: w.last_pinged_at,
  target_state: null,
  next_at: w.kind === 'reminder' && typeof w.baseline.next === 'string' ? w.baseline.next : null,
  every_minutes: w.kind === 'reminder' ? (w.params.every_minutes ?? null) : null,
});

/** What a screen gets of a watch: everything but the concierge's note. */
export const forScreen = (v: WatchView): WatchView => ({ ...v, note: '' });

type ScreenRepos = Pick<Repositories, 'chatWatches'> & Partial<Pick<Repositories, 'tabs'>>;

/** The open watches of a chat scope as the screens show them (`GET /api/chat`, the phone's, the `watches`
 *  event): no note, and a watched tab's state now. A tab that cannot be read keeps `target_state` null. */
export async function activeWatches(repos: ScreenRepos, userId: string, projectId: string | null): Promise<WatchView[]> {
  const rows = await repos.chatWatches.listOpen(userId, projectId);
  return Promise.all(
    rows.map(async (w) => {
      const view = forScreen(watchView(w));
      if (w.kind !== 'tab' || !w.target_id || !repos.tabs) return view;
      const tab = await repos.tabs.findById(w.target_id).catch(() => null);
      return { ...view, target_state: tab?.state ?? null };
    }),
  );
}

/** Tells every open screen of the scope's active conversation its list changed. Never throws. */
export async function publishWatches(repos: Pick<Repositories, 'chat'> & ScreenRepos, userId: string, projectId: string | null): Promise<void> {
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
