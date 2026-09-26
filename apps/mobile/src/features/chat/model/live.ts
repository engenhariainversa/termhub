// The answer being written, keyed by message id (design spec §6; chat redesign spec §4.2
// "Incremental fold"): the web's `lib/chat-live.ts` in the immutable form zustand state needs.
// `applyLive` costs O(1) per event and hands back the very same fold when the event changes nothing,
// replacing only the map it touched otherwise — so a selector on one row's text changes only when
// that row's text does. `foldLive` is the batch form over a list of events.
import type { ChatEvent, ChatMessage } from './types';

export interface LiveFold {
  deltas: Map<string, string>;
  actions: Map<string, { tool: string }[]>;
  /**
   * Assistant rows this fold has seen any sign of life from: the `message` event that announces a
   * run, but also its deltas and its tool calls — a store hydrated (or reconnected) after the run
   * began never sees the announcement, and a tool-only phase can run for tens of seconds with
   * nothing else to show. An empty bubble only deserves a "pensando…" while its run can still be
   * alive; a row left empty by a process death — which happens on every deploy — is never mentioned
   * here at all, so it reads as the failure it is instead of waiting for ever.
   */
  started: Set<string>;
}

export const emptyFold = (): LiveFold => ({ deltas: new Map(), actions: new Map(), started: new Set() });

const withStarted = (fold: LiveFold, id: string): Set<string> => (fold.started.has(id) ? fold.started : new Set(fold.started).add(id));

function without<K, V>(map: Map<K, V>, key: K): Map<K, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** Drops what streamed for `id`. A `reset` (the server retrying the run on a fresh CLI session) keeps
 * the row started — the run is still alive; a final `message` drops that too. */
function drop(fold: LiveFold, id: string, keepStarted: boolean): LiveFold {
  const hasDeltas = fold.deltas.has(id);
  const hasActions = fold.actions.has(id);
  const hasStarted = !keepStarted && fold.started.has(id);
  if (!hasDeltas && !hasActions && !hasStarted) return fold;
  const started = hasStarted ? new Set(fold.started) : fold.started;
  if (hasStarted) started.delete(id);
  return { deltas: hasDeltas ? without(fold.deltas, id) : fold.deltas, actions: hasActions ? without(fold.actions, id) : fold.actions, started };
}

/**
 * The fold after one event. `hello`, `confirmation`, `decision`, `action_result`, the grant, tab
 * question and suggestion events and `run_finished` touch none of this and fall through unchanged,
 * same as on the web: `ChatPanel`'s own `onEvent` handles those. A `message` for an assistant row
 * that is final (text or an error code) drops that id — the row itself now carries the text; an
 * empty one announces a run and only marks it started. A user message changes nothing here.
 */
export function applyLive(fold: LiveFold, e: ChatEvent): LiveFold {
  switch (e.type) {
    case 'delta':
      return {
        deltas: new Map(fold.deltas).set(e.message_id, (fold.deltas.get(e.message_id) ?? '') + e.delta),
        actions: fold.actions,
        started: withStarted(fold, e.message_id),
      };
    case 'action':
      return {
        deltas: fold.deltas,
        actions: new Map(fold.actions).set(e.message_id, [...(fold.actions.get(e.message_id) ?? []), { tool: e.tool }]),
        started: withStarted(fold, e.message_id),
      };
    case 'reset':
      return drop(fold, e.message_id, true);
    case 'message': {
      const { message } = e;
      if (message.role !== 'assistant') return fold;
      if (!message.text && !message.error_code) {
        return fold.started.has(message.id) ? fold : { ...fold, started: withStarted(fold, message.id) };
      }
      return drop(fold, message.id, false);
    }
    default:
      return fold;
  }
}

/**
 * The fold after a re-read of the thread (a reconnect, most often): a row the thread shows finished
 * — text or an error — carries its answer now, so what streamed for it goes, as its final `message`
 * event would have done; a row still empty keeps its streamed prefix on screen, and an id the thread
 * does not have is left alone (its events may still be on their way). The very same fold back when
 * nothing was finished.
 */
export function pruneLive(fold: LiveFold, messages: readonly ChatMessage[]): LiveFold {
  return messages.reduce((f, m) => (m.role === 'assistant' && (m.text || m.error_code) ? drop(f, m.id, false) : f), fold);
}

/** The fold of a whole list of events, from nothing — the batch form, for tests and re-folds. */
export function foldLive(events: ChatEvent[]): LiveFold {
  return events.reduce(applyLive, emptyFold());
}
