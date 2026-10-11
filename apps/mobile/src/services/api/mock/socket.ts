// The fake WebSocket (design spec §4.2 "Events", P§6.1): validates the upgrade — protocol
// version, bearer token, DPoP proof for `GET /ws/m/chat` — asynchronously on the next tick, then
// opens and sends `hello` first. Registered in `state.sockets` for the connection's lifetime, so
// `handlers/chat.ts`'s `broadcast`, `revokeDevice` and `controls.dropSocket` can all reach it.
import { canonicalHtu } from '../contract';
import type { Transport, TransportSocket, TransportSocketHandlers } from '../transport';
import { catchUp } from './handlers/tabs';
import { type MockSocket, type MockState, type MockTabSocket, verifyAuth } from './state';

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

/** `client.ts`'s `wsUrl` inverse: the client signs its DPoP proof's `htu` against the http(s)
 * base it calls, never the `ws(s)` one it upgrades to, so verification must undo that swap
 * before deriving `htu` the same way `canonicalHtu` does for every other route. */
function httpOrigin(wsUrl: string): string {
  return new URL(wsUrl.replace(/^ws/, 'http')).origin;
}

export function createFakeSocketConnect(state: MockState, now: () => number): Transport['connect'] {
  return (url: string, headers: Record<string, string>, handlers: TransportSocketHandlers): TransportSocket => {
    let entry: MockSocket | null = null;

    let tabEntry: MockTabSocket | null = null;

    const timer = setTimeout(() => {
      const parsed = new URL(url);
      if (parsed.searchParams.get('v') !== '1') {
        handlers.onClose(4400);
        return;
      }
      // `/ws/m/tabs/:id` (spec 2026-10-01 tab chat §5.5): the proof is over that path.
      const tabMatch = /^\/ws\/m\/tabs\/([^/]+)$/.exec(parsed.pathname);

      let auth;
      try {
        auth = verifyAuth(state, {
          headers: lowerCaseHeaders(headers),
          htm: 'GET',
          htu: canonicalHtu(httpOrigin(url), tabMatch ? parsed.pathname : '/ws/m/chat'),
          now: now(),
        });
      } catch {
        // Like the server, which answers an expired or unknown token, a bad proof or a revoked
        // device with an HTTP 401 before the upgrade: the socket never opens, and React Native
        // reports a `1006` close. The client renews its token, and a revoked device learns it
        // from that renewal's `DEVICE_REVOKED`. `4401` is only sent to an open socket.
        handlers.onClose(1006);
        return;
      }

      handlers.onOpen();
      if (tabMatch) {
        const tabId = decodeURIComponent(tabMatch[1]!);
        const tab = state.tabs.get(tabId);
        if (!tab) {
          handlers.onClose(4404);
          return;
        }
        const tabSocket: MockTabSocket = {
          tabId,
          send: (frame) => handlers.onMessage(JSON.stringify(frame)),
          close: (code) => {
            if (!state.tabSockets.has(tabSocket)) return;
            state.tabSockets.delete(tabSocket);
            handlers.onClose(code);
          },
        };
        tabEntry = tabSocket;
        state.tabSockets.add(tabSocket);
        tabSocket.send({ type: 'hello', protocol: 1, server_time: new Date(now()).toISOString(), availability: tab.summary.availability });
        const missed = catchUp(state, tabId, parsed.searchParams.get('after'));
        if (missed) tabSocket.send(missed);
        return;
      }
      const socket: MockSocket = {
        deviceId: auth.device.id,
        send: (event) => handlers.onMessage(JSON.stringify(event)),
        close: (code) => {
          if (!state.sockets.has(socket)) return;
          state.sockets.delete(socket);
          handlers.onClose(code);
        },
      };
      entry = socket;
      state.sockets.add(socket);
      socket.send({ type: 'hello', protocol: 1, server_time: new Date(now()).toISOString() });
    }, 0);

    return {
      // The client's own `.close()`: just teardown, no `onClose` callback — mirrors
      // `FetchTransport`, where closing a real `WebSocket` relies on its own `onclose` event
      // rather than the caller invoking anything itself.
      close: () => {
        clearTimeout(timer);
        if (tabEntry) {
          state.tabSockets.delete(tabEntry);
          tabEntry = null;
        }
        if (entry) {
          state.sockets.delete(entry);
          entry = null;
        }
      },
    };
  };
}
