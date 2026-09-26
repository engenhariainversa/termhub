import { useCallback, useState } from 'react';
import type { ChatEvent } from './types';

/** One tool chip of a row being written — the shape `ChatTurn.tools` already takes. */
export type ChatTool = { tool: string };

/** What has streamed for one assistant row so far. */
export interface LiveRow {
  text: string;
  /** The same array reference until a new tool call lands: `ChatTurn`'s memo depends on that. */
  tools: readonly ChatTool[];
  /**
   * The row's run has shown a sign of life: its announcement (`message` with no text yet), a delta or a
   * tool call. A page opened after the run began never sees the announcement, and a tool-only phase can
   * run for tens of seconds with nothing else to show — and an empty row that nothing ever started is a
   * process death, which must read as the failure it is instead of waiting for ever.
   */
  started: boolean;
}

export interface LiveFold {
  /** Folds one event in. `true` when something changed (and `version` moved). */
  apply(ev: ChatEvent): boolean;
  get(messageId: string): LiveRow | undefined;
  /** Counts changes; a React consumer stores it in state to re-render. */
  version: number;
}

const NO_TOOLS: readonly ChatTool[] = Object.freeze([]);
const EMPTY_ROW: LiveRow = { text: '', tools: NO_TOOLS, started: false };

/**
 * Folds WebSocket events incrementally, per message id: each frame costs O(1) instead of a rebuild over
 * the whole buffer. A row is replaced by a new object when it changes (so a reader can compare by
 * identity) and left as is otherwise. A `reset` drops the id's entry — the server retried the run on a
 * fresh CLI session, and the abandoned half-answer must never show glued to the real one.
 */
export function createLiveFold(): LiveFold {
  const rows = new Map<string, LiveRow>();
  const fold: LiveFold = {
    version: 0,
    get: (id) => rows.get(id),
    apply(ev) {
      let changed = false;
      switch (ev.type) {
        case 'delta': {
          const row = rows.get(ev.message_id) ?? EMPTY_ROW;
          rows.set(ev.message_id, { text: row.text + ev.delta, tools: row.tools, started: true });
          changed = true;
          break;
        }
        case 'action': {
          const row = rows.get(ev.message_id) ?? EMPTY_ROW;
          rows.set(ev.message_id, { text: row.text, tools: [...row.tools, { tool: ev.tool }], started: true });
          changed = true;
          break;
        }
        case 'reset':
          changed = rows.delete(ev.message_id);
          break;
        case 'message': {
          const m = ev.message;
          // The announcement of a run: an assistant row with nothing in it yet.
          if (m.role === 'assistant' && !m.text && !m.error_code) {
            const row = rows.get(m.id);
            if (!row) {
              rows.set(m.id, { text: '', tools: NO_TOOLS, started: true });
              changed = true;
            } else if (!row.started) {
              rows.set(m.id, { ...row, started: true });
              changed = true;
            }
          } else {
            // The stored row (text, or the error it ended in): the panel merges it into `messages` in
            // the same event, so what streamed for it is no longer needed and is let go of here.
            changed = rows.delete(m.id);
          }
          break;
        }
        default:
          break;
      }
      if (changed) fold.version += 1;
      return changed;
    },
  };
  return fold;
}

/**
 * The fold as React state: one fold per mounted panel, a `version` that moves on every change (so the
 * panel re-renders and reads the rows it needs through `fold.get`), and a `push` that never changes
 * identity, so the handler that calls it can be memoised.
 */
export function useChatLive(): { fold: LiveFold; version: number; push(ev: ChatEvent): void } {
  const [fold] = useState(createLiveFold);
  const [version, setVersion] = useState(0);
  const push = useCallback(
    (ev: ChatEvent) => {
      if (fold.apply(ev)) setVersion(fold.version);
    },
    [fold],
  );
  return { fold, version, push };
}
