import { useEffect, useRef, useState } from 'react';
import type { ChatEvent } from './types';

const RECONNECT_MS = 5_000;

/**
 * Subscribes to /ws/chat. The socket carries no history, so `onReconnect` re-reads the
 * conversation over REST on every (re)connect — that is what makes a reconnect in the middle
 * of an answer safe: the page never needs a replay buffer, it just asks the server again.
 *
 * `onEvent` is called once for every event as it arrives and is the only delivery point: there is
 * no buffered copy of the stream (there used to be a 500-event window, rebuilt into the live rows on
 * every frame — `lib/chat-live.ts` folds each event in as it comes instead).
 */
export function useChatStream(onReconnect: () => void, onEvent: (event: ChatEvent) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;
  const emit = useRef(onEvent);
  emit.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/chat`);
      ws.onopen = () => {
        setConnected(true);
        reconnect.current();
      };
      ws.onmessage = (ev) => {
        try {
          emit.current(JSON.parse(String(ev.data)) as ChatEvent);
        } catch {
          /* ignore a frame we cannot read */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        ws = null;
        if (!stopped) timer = setTimeout(open, RECONNECT_MS);
      };
      ws.onerror = () => ws?.close();
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { connected };
}
