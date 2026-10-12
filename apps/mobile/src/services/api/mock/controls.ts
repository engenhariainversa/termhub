// `MockControls` — the "Aguardando aprovação" screen's simulation buttons and the test-only
// escape hatches for expiry, lock and revoke (design spec §4.2).
import { ACTIVATE_TTL_MS } from './handlers/devices';
import type { TTabChatFrame, TTabChatItem, TTabSummary } from '../contract';
import { appendTabItems, sendTabFrame } from './handlers/tabs';
import { PIN_LOCK_MS, revokeDevice, requestStatus, type MockAction, type MockState } from './state';

export interface MockControls {
  approve(requestId: string): void;
  deny(requestId: string): void;
  expireNow(): void;
  lockNow(): void;
  revokeNow(): void;
  dropSocket(): void;
  pendingRequestIds(): string[];
  /** Test-only: puts a pending action in the chat (e.g. a `send_key` or `run_command` card the
   * fixtures do not have), as if the concierge had proposed it. */
  seedAction(action: MockAction): void;
  /** Sessions (spec 2026-10-01 tab chat): new items in a tab's transcript, relayed to its sockets. */
  appendTabItems(tabId: string, items: TTabChatItem[]): void;
  /** Sends any frame to the sockets open on a tab. */
  tabFrame(tabId: string, frame: TTabChatFrame): void;
  /** Changes a tab's summary (its state, availability...), without telling the sockets. */
  patchTab(tabId: string, patch: Partial<TTabSummary>): void;
  /** Drops every tab socket with a non-final close, so the app reconnects. */
  dropTabSockets(): void;
  /** "Refazer login" (TER-1047): an AI account's login state (`ok`, `login_required`, `unknown`). */
  setAiLoginState(accountId: string, loginState: string): void;
}

export function createMockControls(state: MockState, now: () => number): MockControls {
  return {
    approve(requestId) {
      const req = state.requests.get(requestId);
      if (!req || req.status !== 'pending') return;
      req.status = 'approved';
      req.activateUntil = now() + ACTIVATE_TTL_MS;
    },

    deny(requestId) {
      const req = state.requests.get(requestId);
      if (!req || req.status !== 'pending') return;
      req.status = 'denied';
    },

    expireNow() {
      for (const req of state.requests.values()) {
        if (req.status === 'pending') req.expiresAt = now() - 1;
      }
    },

    lockNow() {
      for (const device of state.devices.values()) {
        device.lockedUntil = now() + PIN_LOCK_MS;
      }
    },

    revokeNow() {
      for (const device of state.devices.values()) {
        revokeDevice(state, device, 'admin');
      }
    },

    // Simulates the connection dropping so the app's reconnect logic can be watched — a normal,
    // non-terminal closure (unlike `4400`/`4401`), so the socket client schedules a reconnect
    // instead of wiping (design spec §4.2 "Controls").
    dropSocket() {
      for (const socket of state.sockets) socket.close(1006);
    },

    pendingRequestIds() {
      const nowMs = now();
      return [...state.requests.values()].filter((req) => requestStatus(req, nowMs) === 'pending').map((req) => req.id);
    },

    seedAction(action) {
      state.actions.set(action.id, action);
    },

    appendTabItems(tabId, items) {
      appendTabItems(state, tabId, items);
    },

    tabFrame(tabId, frame) {
      sendTabFrame(state, tabId, frame);
    },

    patchTab(tabId, patch) {
      const tab = state.tabs.get(tabId);
      if (tab) tab.summary = { ...tab.summary, ...patch };
    },

    dropTabSockets() {
      for (const socket of [...state.tabSockets]) socket.close(1006);
    },

    setAiLoginState(accountId, loginState) {
      state.aiLoginStates.set(accountId, loginState);
    },
  };
}
