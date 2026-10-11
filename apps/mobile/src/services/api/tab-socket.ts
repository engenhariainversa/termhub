// The `/ws/m/tabs/:id?v=1&after=<cursor>` client (spec 2026-10-01 tab chat §5.5): one socket per open
// session screen, server to phone only. The same state machine as `socket.ts` (the chat's), with two
// differences: every (re)connect asks from the cursor the store holds then (`after()`), so a reconnect
// continues where the conversation stopped; and `hello` is handed to `onFrame` too, since it carries
// the tab's availability. Never imports `react-native`: the foreground signal is injected.
import { tabChatFrame, type TTabChatFrame } from './contract';
import type { Transport, TransportSocket } from './transport';

export interface CreateTabSocketOptions {
  transport: Transport;
  /** The socket's url for a cursor (`null`: from the end of the transcript). */
  url(after: string | null): string;
  /** Fresh upgrade headers for every (re)connect: a new DPoP proof, the current token. */
  headers(): Promise<Record<string, string>>;
  /** The `live` cursor the store holds, read right before each connect. */
  after(): string | null;
  /** Every frame that parses with `tabChatFrame`, `hello` included; one that does not is dropped. */
  onFrame(f: TTabChatFrame): void;
  /** `final` for 4400 (protocol), 4401 (device revoked), 4403 (no `terminals:read`) and 4404 (not the
   * caller's tab): not reopened. Any other close reconnects with backoff. */
  onClose(code: number, final: boolean): void;
  /** A non-final close of a connection that never opened (the server refused the upgrade). Fires
   * just before `onClose`. */
  onRefused?(): void;
  /** `hello.server_time`, for the client's clock-skew correction. */
  onServerTime(iso: string): void;
  foreground?: { subscribe(fn: () => void): () => void };
  backoff?: { min: number; max: number };
}

const DEFAULT_BACKOFF = { min: 1000, max: 30000 };
const FINAL_CODES = new Set([4400, 4401, 4403, 4404]);

export function createTabSocket(o: CreateTabSocketOptions): { close(): void } {
  const backoff = o.backoff ?? DEFAULT_BACKOFF;

  let stopped = false;
  let connecting = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let socket: TransportSocket | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    clearTimer();
    const delay = Math.min(backoff.min * 2 ** attempt, backoff.max);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void open();
    }, delay);
  };

  async function open(): Promise<void> {
    if (stopped || socket !== null || connecting) return;
    connecting = true;
    let headers: Record<string, string>;
    try {
      headers = await o.headers();
    } catch {
      // Treated like a dropped connection, never surfaced nor logged.
      connecting = false;
      if (!stopped) scheduleReconnect();
      return;
    }
    connecting = false;
    if (stopped) return;

    let helloSeen = false;
    let opened = false;
    // Own to this attempt: a real WebSocket's `.close()` fires its own `onclose` later, which must not
    // reach a newer connection (see `socket.ts`).
    let abandoned = false;
    const abandonAndCloseTransport = () => {
      if (abandoned) return;
      abandoned = true;
      const dead = socket;
      socket = null;
      dead?.close();
    };

    socket = o.transport.connect(o.url(o.after()), headers, {
      onOpen: () => {
        if (abandoned || stopped) return;
        opened = true;
        attempt = 0;
      },
      onMessage: (text) => {
        if (abandoned || stopped) return;
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        const result = tabChatFrame.safeParse(json);
        if (!helloSeen) {
          helloSeen = true;
          if (result.success && result.data.type === 'hello') {
            o.onServerTime(result.data.server_time);
            o.onFrame(result.data);
            return;
          }
          // The server always sends `hello` first: anything else is a broken connection, retried.
          abandonAndCloseTransport();
          scheduleReconnect();
          return;
        }
        // Never fatal, and the content is never logged.
        if (!result.success) return;
        o.onFrame(result.data);
      },
      onClose: (code) => {
        if (abandoned) return;
        abandoned = true;
        socket = null;
        if (stopped) return;
        if (FINAL_CODES.has(code)) {
          o.onClose(code, true);
          return;
        }
        if (!opened) o.onRefused?.();
        o.onClose(code, false);
        scheduleReconnect();
      },
    });
  }

  const unsubscribeForeground = o.foreground?.subscribe(() => {
    if (stopped || socket !== null || connecting) return;
    clearTimer();
    void open();
  });

  void open();

  return {
    close(): void {
      stopped = true;
      clearTimer();
      unsubscribeForeground?.();
      const dead = socket;
      socket = null;
      dead?.close();
    },
  };
}
