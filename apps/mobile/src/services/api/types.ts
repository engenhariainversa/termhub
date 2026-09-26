// The `MobileApi` port (design spec §4): one method per route of P§6, typed by the contract's
// zod-inferred types. `HttpMobileApi` (`client.ts`) is the one implementation that talks to a
// real (or mocked) server through a `Transport`.
import type {
  TChallengeBody,
  TChallengeResponse,
  TChatEvent,
  TChatGrantListResponse,
  TChatProjectsResponse,
  TChatResponse,
  TDeviceActivateBody,
  TDeviceActivateResponse,
  TDevicePollResponse,
  TDeviceRequestBody,
  TDeviceRequestResponse,
  TDeviceSelf,
  THostOptionsResponse,
  TMeResponse,
  TMobileDecisionBody,
  TMobileMessageBody,
  TNotificationsResponse,
  TSendAccepted,
  TSetHostBody,
  TTabQuestionAnswerBody,
  TTabQuestionScreenResponse,
  TTabSuggestionSendBody,
  TTokenBody,
  TTokenResponse,
} from './contract';

/**
 * The device owns the key and signs every call itself (S§4 ruling): unlike the design spec's
 * `Auth`, there is no proof factory here — the client computes `htm`/`htu`/`ath` and signs the
 * DPoP proof internally, so callers only ever hand it a token.
 */
export type Auth = { accessToken: string };

export interface MobileApi {
  readonly mode: 'mock' | 'http';

  /** Drops the token the last renewal produced, so a relock or wipe can never have a later
   * `TOKEN_EXPIRED` quietly reuse it (the session store calls this). */
  forgetTokens(): void;

  // enrolment (P§4)
  requestDevice(body: TDeviceRequestBody): Promise<TDeviceRequestResponse>;
  pollRequest(requestId: string, requestSecret: string): Promise<TDevicePollResponse>;
  activate(body: TDeviceActivateBody): Promise<TDeviceActivateResponse>;

  // session (P§5)
  challenge(body: TChallengeBody): Promise<TChallengeResponse>;
  token(body: TTokenBody): Promise<TTokenResponse>;
  me(auth: Auth): Promise<TMeResponse>;
  deviceSelf(auth: Auth): Promise<TDeviceSelf>;
  revokeSelf(auth: Auth): Promise<void>;
  setPushToken(auth: Auth, token: string): Promise<void>;

  // chat (P§6, §6.1)
  chatProjects(auth: Auth): Promise<TChatProjectsResponse>;
  chat(auth: Auth, projectId: string | null): Promise<TChatResponse>;
  hostOptions(auth: Auth): Promise<THostOptionsResponse>;
  setHost(auth: Auth, body: TSetHostBody): Promise<void>;
  sendMessage(auth: Auth, body: TMobileMessageBody): Promise<TSendAccepted>;
  reset(auth: Auth, projectId: string | null): Promise<void>;
  decide(auth: Auth, actionId: string, body: TMobileDecisionBody): Promise<void>;
  /** "Revogar" a trusted tab (no PIN: it only takes power away). 404 unknown, 409 already revoked. */
  revokeGrant(auth: Auth, grantId: string): Promise<void>;
  /** "Abas confiáveis": active grants (no paging) or the ended/expired/revoked history (paged, newest first). */
  listGrants(auth: Auth, q: { state: 'active' | 'ended'; cursor?: string | null }): Promise<TChatGrantListResponse>;
  /** Answers a tab's question from its card — no PIN (spec 2026-09-25 §2). 409 `TAB_PROMPT_CHANGED`
   * when the tab moved on, 404 unknown. */
  answerTabQuestion(auth: Auth, questionId: string, body: TTabQuestionAnswerBody): Promise<void>;
  /** The tab's last lines, live, for a permission card; 409 once the question is closed. */
  tabQuestionScreen(auth: Auth, questionId: string): Promise<TTabQuestionScreenResponse>;
  /** Sends a tab's suggestion, as edited — no PIN. 409 `TAB_PROMPT_CHANGED` when the tab's prompt changed, 404 unknown. */
  sendTabSuggestion(auth: Auth, suggestionId: string, body: TTabSuggestionSendBody): Promise<void>;
  /** "Dispensar": closes the card, the tab is not touched. Idempotent; 404 unknown. */
  dismissTabSuggestion(auth: Auth, suggestionId: string): Promise<void>;

  // notifications (P§9)
  notifications(auth: Auth, before?: string): Promise<TNotificationsResponse>;
  markRead(auth: Auth, id: string): Promise<void>;

  // the socket (P§6.1): server -> client events, filtered by user on the server. `onReconnect`
  // fires on every (re)open, before `hello` arrives, so the store re-reads `GET chat` (no
  // replay, design spec §4.1); `onClose`'s `final` is true for the two terminal close codes
  // (`4400`, `4401`) — the socket is not reopened. `auth` may be a factory, read on every
  // (re)connect so a reconnect presents the current token; a refused upgrade (a close that never
  // opened — the server's HTTP 401 for an expired token, a bad proof or a revoked device) or a
  // `1008` close renews the token before the next attempt. Returns the socket's `close`.
  events(
    auth: Auth | (() => Auth),
    handlers: { onEvent(e: TChatEvent): void; onReconnect(): void; onClose(code: number, final: boolean): void },
  ): () => void;
}
