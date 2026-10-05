// The `MobileApi` port (design spec §4): one method per route of P§6, typed by the contract's
// zod-inferred types. `HttpMobileApi` (`client.ts`) is the one implementation that talks to a
// real (or mocked) server through a `Transport`.
import type {
  AccountDeletionBody,
  AccountDeletionStatus,
  TChallengeBody,
  TChallengeResponse,
  TChatAttachment,
  TChatEvent,
  TChatGrantListResponse,
  TChatMemory,
  TChatProjectsResponse,
  TChatResponse,
  TDecisionsResponse,
  TDeviceActivateBody,
  TDeviceActivateResponse,
  TDevicePollResponse,
  TDeviceRequestBody,
  TDeviceRequestResponse,
  TDeviceSelf,
  THostOptionsResponse,
  TLessonForgetResponse,
  TLessonItem,
  TLessonsResponse,
  TMeResponse,
  TMobileBatchDecisionBody,
  TDecisionChallengesBody,
  TDecisionChallengesResponse,
  TMobileDecisionBody,
  TMobileMessageBody,
  TNotesResponse,
  TNotificationsResponse,
  TProgressResponse,
  TAutomationSetup,
  TProjectAi,
  TProjectAiResponse,
  TSendAccepted,
  TSetHostBody,
  TStartSessionBody,
  TStartSessionResponse,
  TSubagentView,
  TTabActionResponse,
  TTabChatAction,
  TTabChatFrame,
  TTabChatPage,
  TFilePreviewQuery,
  TFilePreviewResponse,
  TTabFileResponse,
  TTabScreenResponse,
  TTabsResponse,
  TTabQuestionAnswerBody,
  TTabQuestionAutoAnswerCancelResponse,
  TTabLimit,
  TTabQuestionScreenResponse,
  TTabSuggestionSendBody,
  TTokenBody,
  TTokenResponse,
  TTranscription,
  TTranscriptionConfigResponse,
} from './contract';

/**
 * The device owns the key and signs every call itself (S§4 ruling): unlike the design spec's
 * `Auth`, there is no proof factory here — the client computes `htm`/`htu`/`ath` and signs the
 * DPoP proof internally, so callers only ever hand it a token.
 */
export type Auth = { accessToken: string };

/** A file on the phone, as the pickers hand it over: the upload task streams it from `uri`. */
export type UploadFile = { uri: string; name: string; mime: string };

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

  // account deletion (TER-720): the only routes, besides the session ones, that answer while a
  // deletion is pending — every other one is `403 ACCOUNT_PENDING_DELETION` until it is cancelled.
  accountDeletion(auth: Auth): Promise<AccountDeletionStatus>;
  /** Needs a PIN proof over a decision challenge for `ACCOUNT_DELETION_ACTION_ID`, signed with
   * `delete_account`. Same errors as an approval (PIN_INVALID, DEVICE_LOCKED, DEVICE_REVOKED,
   * CHALLENGE_INVALID), plus `409 LAST_ADMIN`. */
  requestAccountDeletion(auth: Auth, body: AccountDeletionBody): Promise<AccountDeletionStatus>;
  cancelAccountDeletion(auth: Auth): Promise<AccountDeletionStatus>;

  // chat (P§6, §6.1)
  chatProjects(auth: Auth): Promise<TChatProjectsResponse>;
  /** Pins or unpins a project in the person's Favoritos, the web sidebar's group (TER-541). */
  setProjectFavorite(auth: Auth, projectId: string, favorite: boolean): Promise<void>;
  chat(auth: Auth, projectId: string | null): Promise<TChatResponse>;
  hostOptions(auth: Auth): Promise<THostOptionsResponse>;
  setHost(auth: Auth, body: TSetHostBody): Promise<void>;
  sendMessage(auth: Auth, body: TMobileMessageBody): Promise<TSendAccepted>;
  reset(auth: Auth, projectId: string | null): Promise<void>;
  decide(auth: Auth, actionId: string, body: TMobileDecisionBody): Promise<void>;
  /** A grouped confirmation: every approval carries its own proof, all checked before anything is
   * decided (a wrong PIN is a 401 and leaves the whole batch pending). */
  decideMany(auth: Auth, body: TMobileBatchDecisionBody): Promise<void>;
  /** One decision challenge per action of a grouped confirmation, in one call (TER-530). */
  decisionChallenges(auth: Auth, body: TDecisionChallengesBody): Promise<TDecisionChallengesResponse>;
  /** "Revogar" a trusted tab (no PIN: it only takes power away). 404 unknown, 409 already revoked. */
  revokeGrant(auth: Auth, grantId: string): Promise<void>;
  /** "Permissões do chat": active grants (no paging) or the ended/expired/revoked history (paged,
   * newest first) — tab, project and standing grants together (`HttpMobileApi` always asks `kinds=all_standing`). */
  listGrants(auth: Auth, q: { state: 'active' | 'ended'; cursor?: string | null }): Promise<TChatGrantListResponse>;
  /** Answers a tab's question from its card — no PIN (spec 2026-09-25 §2). 409 `TAB_PROMPT_CHANGED`
   * when the tab moved on, 404 unknown. */
  answerTabQuestion(auth: Auth, questionId: string, body: TTabQuestionAnswerBody): Promise<void>;
  /** "Cancelar" on a countdown (concierge memory spec 2026-09-26 §6): nothing is sent, the proposed
   * answer stays on the card as its own pre-selection. No PIN. 404 for another user's card, 409
   * `NOT_SCHEDULED` when no countdown runs (already sent, failed, cancelled, or never scheduled). */
  cancelAutoAnswer(auth: Auth, questionId: string): Promise<TTabQuestionAutoAnswerCancelResponse>;
  /** The tab's last lines, live, for a permission card; 409 once the question is closed. */
  tabQuestionScreen(auth: Auth, questionId: string): Promise<TTabQuestionScreenResponse>;
  /** Sends a tab's suggestion, as edited — no PIN. 409 `TAB_PROMPT_CHANGED` when the tab's prompt changed, 404 unknown. */
  sendTabSuggestion(auth: Auth, suggestionId: string, body: TTabSuggestionSendBody): Promise<void>;
  /** "Dispensar": closes the card, the tab is not touched. Idempotent; 404 unknown. */
  dismissTabSuggestion(auth: Auth, suggestionId: string): Promise<void>;
  /** A usage-limit card's answer (spec 2026-09-30 project AI accounts §7.2) — no PIN: the account to swap
   * the tab to, or `null` for "Esperar". Answers the card as it now stands. 409 with a pt-BR `error` when
   * the swap failed (the card stays open), 404 unknown. */
  answerTabLimit(auth: Auth, limitId: string, accountId: string | null): Promise<TTabLimit>;
  /** "Cancelar" on a subagent's row (spec 2026-09-26 panel §5.4) — no PIN. Answers the row now
   * `stopping`; the panel's own update arrives over the socket. 404 unknown, 409 `SUBAGENT_NOT_RUNNING`
   * (already at rest) or `SUBAGENT_GONE` (its process is no longer around to ask). */
  cancelSubagent(auth: Auth, subagentId: string): Promise<TSubagentView>;

  // the project's AI accounts and models (spec 2026-09-30 project AI accounts §8)
  /** The project's accounts (ids, priority order) and default models, with every account its linked
   * machines offer. 404 outside the person's scope. */
  getProjectAi(auth: Auth, projectId: string): Promise<TProjectAiResponse>;
  /** Saves them; answers the same shape. 400 with a pt-BR `error` for an account or model the server refuses. */
  saveProjectAi(auth: Auth, projectId: string, ai: TProjectAi): Promise<TProjectAiResponse>;

  // Trabalho automático (spec 2026-10-04)
  /** The project's automation block, whole (the app sends it back as it got it). 404 outside the scope. */
  getAutomationSetup(auth: Auth, projectId: string): Promise<TAutomationSetup>;
  /** Saves the block. Turning it on, or raising the level to deploy/release, needs `proof` (a PIN proof over a
   * decision challenge for `automationSetupActionId(projectId)`, signed `automation_setup`): without one the
   * server answers 401 `PIN_REQUIRED`. Lowering the level or turning off never asks. */
  saveAutomationSetup(auth: Auth, projectId: string, automation: TAutomationSetup, proof?: { challenge: string; pin_proof: string }): Promise<TAutomationSetup>;
  /** Tags or untags a card for automatic work; answers the tag as it now stands. No PIN. 404 outside the scope. */
  setCardAuto(auth: Auth, taskId: string, auto: boolean): Promise<boolean>;

  // attachments (spec 2026-09-26 §5.3, §5.6)
  /** Streams the file as the raw body; `onProgress` is 0..1. 415 ATTACHMENT_TYPE, 413 ATTACHMENT_TOO_LARGE / ATTACHMENT_QUOTA. */
  uploadAttachment(auth: Auth, file: UploadFile, projectId: string | null, onProgress?: (fraction: number) => void): Promise<TChatAttachment>;
  /** Only while unsent: 404 unknown, 409 once it was sent with a message. */
  deleteAttachment(auth: Auth, id: string): Promise<void>;
  /** The download url plus the headers a `<Image source>` needs to fetch it (bearer and a fresh DPoP proof). */
  attachmentSource(auth: Auth, id: string): Promise<{ uri: string; headers: Record<string, string> }>;

  // voice (P§6 `/transcriptions`, guarded `terminals`; `routes/m-transcriptions.ts`)
  /** Whether the server transcribes audio at all (whisper configured). */
  transcriptionConfig(auth: Auth): Promise<TTranscriptionConfigResponse>;
  /** Uploads a clip (a `file://` URI, one of the server's accepted audio types) as the raw body;
   * `seconds` is the recorded length (at most 300). Answers the accepted job, to be polled with
   * `transcription` until `done` or `error`. 400 for an empty clip or a mime the server refuses,
   * 429 past 10 uploads per 10 min. */
  transcribe(auth: Auth, fileUri: string, mime: string, seconds: number, onProgress?: (fraction: number) => void): Promise<TTranscription>;
  transcription(auth: Auth, id: string): Promise<TTranscription>;

  // "Memória do chat" (spec 2026-09-26 §4.6/§5.2, concierge memory D8/D12): the twin of the web's
  // `chatDecisions` / `forgetChatDecision` / `chatMemory` / `setChatMemory` / `chatNotes` /
  // `forgetChatNote`. No PIN.
  /** Newest first, 50 per page; `q` filters question/answer/project, `cursor` is `next_cursor`. */
  chatDecisions(auth: Auth, q?: string, cursor?: string | null): Promise<TDecisionsResponse>;
  /** Idempotent and silent about whether `id` ever existed or was someone else's — always 204. */
  forgetChatDecision(auth: Auth, id: string): Promise<void>;
  chatMemory(auth: Auth): Promise<TChatMemory>;
  /** A plain boolean is the same as `{ enabled: boolean }` (the pre-D8 shape every caller still
   *  uses); `{ enabled?, autodecide? }` is the D8 shape for "Responder sozinho quando houver
   *  precedente" — the server refuses a body with neither key. */
  setChatMemory(auth: Auth, body: boolean | { enabled?: boolean; autodecide?: boolean; codex_replies?: boolean }): Promise<TChatMemory>;
  /** "Anotações do concierge" (spec D12/§8): newest first, 50 per page, `cursor` is `next_cursor`. */
  chatNotes(auth: Auth, cursor?: string | null): Promise<TNotesResponse>;
  /** Idempotent and silent about whether `id` ever existed, was someone else's, or was some other
   *  memory kind — always 204. */
  forgetChatNote(auth: Auth, id: string): Promise<void>;
  /** "Lições" (spec 2026-09-27 failure lessons §6/§8): the twin of the web's
   *  `api.chat.lessons.list`/`verify`/`unverify`/`forget`. Newest `source_at` first, 50 per page;
   *  `q` filters title/text, `cursor` is `next_cursor`. No PIN. */
  chatLessons(auth: Auth, q?: string, cursor?: string | null): Promise<TLessonsResponse>;
  /** "Verificar": 404 for another user's row (or not a lesson at all), never a 403 that would
   *  confirm the id exists. */
  verifyChatLesson(auth: Auth, id: string): Promise<TLessonItem>;
  /** "Desfazer verificação": the inverse, same scope. */
  unverifyChatLesson(auth: Auth, id: string): Promise<TLessonItem>;
  /** "Esquecer": `note` is present only for a file-origin lesson, saying the file itself stays in
   *  the repository until a PR removes it. 404 for another user's row (or not a lesson at all). */
  forgetChatLesson(auth: Auth, id: string): Promise<TLessonForgetResponse>;

  // notifications (P§9)
  notifications(auth: Auth, before?: string): Promise<TNotificationsResponse>;
  markRead(auth: Auth, id: string): Promise<void>;

  // progress panel (spec 2026-09-26 progress-panel D10)
  progress(auth: Auth, scope?: 'active' | 'all'): Promise<TProgressResponse>;

  // sessions: a terminal tab read as a conversation (spec 2026-10-01 tab chat §5.4, §5.5). Reads need
  // `terminals:read`, the rest `terminals:write`; a tab outside the person's scope is a 404.
  /** A file an agent wrote, read on its machine (spec 2026-10-04 file preview): the body, or why not.
   *  409 `AGENT_OUTDATED` when the machine's agent cannot read files yet. */
  filePreview(auth: Auth, q: TFilePreviewQuery): Promise<TFilePreviewResponse>;
  /** The terminal tabs of the person's projects, with each one's state and availability. */
  tabs(auth: Auth): Promise<TTabsResponse>;
  /** Starts Claude Code in a new tab of the project with `prompt` as its first message. */
  startSession(auth: Auth, body: TStartSessionBody): Promise<TStartSessionResponse>;
  /** The newest page of the conversation, or the one before `before` (an opaque cursor). */
  tabChat(auth: Auth, tabId: string, before?: string): Promise<TTabChatPage>;
  /** Types `text` into the tab. 409 `WAITING_PERMISSION` while the tab waits on a permission dialog. */
  sendTabMessage(auth: Auth, tabId: string, text: string): Promise<void>;
  /** Escape, Shift+Tab, `/clear` or `/compact`; `cycle_mode` answers the mode the footer shows then. */
  tabAction(auth: Auth, tabId: string, action: TTabChatAction): Promise<TTabActionResponse>;
  /** Saves a file on the tab's machine (raw body, its mime as content type); answers its path there. */
  uploadTabFile(auth: Auth, tabId: string, fileUri: string, name: string, mime: string): Promise<TTabFileResponse>;
  /** The last `lines` lines of the tab's pane, as plain text. */
  tabScreen(auth: Auth, tabId: string, lines?: number): Promise<TTabScreenResponse>;
  /** The tab's live socket (`/ws/m/tabs/:id`), opened from `after()` on every (re)connect. `onClose`'s
   * `final` is true for 4400, 4401, 4403 and 4404. A refused upgrade renews a stale token before the next
   * attempt, as `events` does. Returns the socket's `close`. */
  tabEvents(
    auth: () => Auth,
    tabId: string,
    handlers: { after(): string | null; onFrame(f: TTabChatFrame): void; onClose(code: number, final: boolean): void },
  ): () => void;

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
