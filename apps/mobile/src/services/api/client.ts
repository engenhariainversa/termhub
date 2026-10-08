// The one `MobileApi` implementation that talks to a `Transport` (design spec §4.1, P§5.2, P§6).
// The device owns the key: every call signs its own DPoP proof, corrected for the clock skew
// learned from the server's `Date` header, and a single `401 TOKEN_EXPIRED` triggers one
// single-flighted renewal plus one retry — never for any other error code.
import type { z } from 'zod';
import { b64url, utf8 } from '../crypto/encoding';
import type { DeviceKey } from '../key/types';
import {
  ACCOUNT_PENDING_DELETION,
  pushSettings,
  pushTestResponse,
  type PushSettings,
  type PushTestBody,
  accountDeletionStatus,
  automationSetupResponse,
  cardAutoResponse,
  pauseResponse,
  pauseState,
  canonicalHtu,
  challengeResponse,
  decisionChallengesResponse,
  cancelSubagentResponse,
  chatAttachmentResponse,
  chatGrantListResponse,
  chatMemoryResponse,
  chatProjectsResponse,
  chatResponse,
  decisionsResponse,
  deviceActivateResponse,
  devicePollResponse,
  deviceRequestResponse,
  deviceSelf as deviceSelfSchema,
  emptyResponse,
  filePreviewResponse,
  fileRecentResponse,
  hostOptionsResponse,
  lessonForgetSchema,
  lessonItemSchema,
  lessonListSchema,
  meResponse,
  notesResponse,
  notificationsResponse,
  progressResponse,
  projectAiResponse,
  sendAccepted,
  tabLimitAnswerResponse,
  tabQuestionAutoAnswerCancelResponse,
  tabQuestionScreenResponse,
  startSessionResponse,
  tabActionResponse,
  tabChatPage,
  tabFileResponse,
  tabScreenResponse,
  tabsResponse,
  tokenResponse,
  transcriptionConfigResponse,
  transcriptionResponse,
  type AccountDeletionBody,
  type TChallengeBody,
  type TDeviceActivateBody,
  type TDeviceRequestBody,
  type TMobileBatchDecisionBody,
  type TDecisionChallengesBody,
  type TMobileDecisionBody,
  type TMobileMessageBody,
  type TAutomationSetup,
  type TProjectAi,
  type TSetHostBody,
  type TStartSessionBody,
  type TTabChatAction,
  type TFilePreviewQuery,
  type TTabQuestionAnswerBody,
  type TTabSuggestionSendBody,
  type TTokenBody,
} from './contract';
import { buildProof } from './dpop';
import { t } from '@/i18n';
import { ApiError } from './errors';
import { createChatSocket } from './socket';
import { createTabSocket } from './tab-socket';
import type { Transport } from './transport';
import type { Auth, MobileApi } from './types';

// sha2.js, not the package root — the root re-exports every hash family, which pulls code this
// module never uses.
import { sha256 } from '@noble/hashes/sha2.js';

export type CreateHttpMobileApiOptions = {
  transport: Transport;
  baseUrl: string;
  /** `X-Termhub-App` value, already formatted (e.g. `ios/1.2.0+34`) — see `app-header.ts`. */
  app: string;
  key: DeviceKey;
  /** The session store's single-flighted `challenge` + `token`; `null` means renewal failed. */
  onTokenExpired: () => Promise<string | null>;
  /** Milliseconds; defaults to `Date.now`. A test clock, so proofs are deterministic. */
  now?: () => number;
  /** Defaults to `'http'`: the singleton (`index.ts`) passes `'mock'` when it points this client
   * at a `MockTransport` (Task 8), so the UI can tell the two apart without touching `Transport`. */
  mode?: 'mock' | 'http';
  /** The chat socket's reconnect backoff; defaults to `createChatSocket`'s own `{1s, 30s}`. */
  backoff?: { min: number; max: number };
  /** Reconnects the chat socket at once when the app comes to the foreground while disconnected
   * (P§6.1). The singleton passes `socketWake` (`wake.ts`), which `_layout.tsx` emits on AppState
   * `active` — `services/api` must not import `react-native` itself. */
  foreground?: { subscribe(fn: () => void): () => void };
  /** Whether the access token is missing or about to expire (the session store's `tokenStale`). A
   * refused socket renews only then; a refusal with a fresh token is not a token problem and only
   * backs off (TER-93: the Origin refusal used to renew every 1–30 s). Defaults to always stale. */
  tokenStale?: () => boolean;
  /** Called on every `403 ACCOUNT_PENDING_DELETION` (TER-720): the account is deactivated until the
   * person cancels its deletion. The singleton passes `accountPendingDeletion.emit`. */
  onAccountPendingDeletion?: () => void;
  /** The language the app shows (`'pt-BR'` | `'en'` | `'es'`), sent as `Accept-Language` on every call and
   * socket upgrade so the server answers its errors in it (i18n spec §2). Read per request: a
   * change in Ajustes applies to the next call. */
  language?: () => string;
};

type CallOptions = {
  /** A bearer token (access token, or the enrolment request secret for `pollRequest`). */
  token?: string | null;
  body?: unknown;
  /** `session/token`'s DPoP `chal`, bound to the challenge it is redeeming. */
  chal?: string;
  /** `false` skips the `DPoP` header entirely (`devices/requests`, `session/challenge`). */
  proof?: boolean;
  /** `false` skips the single-retry-on-renewal dance (already a retry, or a call that has no
   * access token to renew in the first place). */
  retry?: boolean;
};

export function createHttpMobileApi(o: CreateHttpMobileApiOptions): MobileApi & { readonly skewSeconds: number } {
  // Server seconds minus device seconds. The latest response wins: `learn` overwrites `skew`
  // unconditionally from every answer's `Date` header, rather than keeping whichever estimate has
  // the largest magnitude — pinning to a single past reading would let one bad or stale response
  // poison `iat` forever, which is worse than the server's own ±60 s tolerance window is meant to
  // absorb.
  let skew = 0;
  const deviceNowS = () => Math.floor((o.now ?? Date.now)() / 1000);
  const nowS = () => deviceNowS() + skew;

  // Shared by every response's `Date` header and by the socket's `hello.server_time` (design
  // spec §4.1): whichever reading arrives last wins.
  const learnFrom = (raw: string) => {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return;
    skew = Math.round(parsed / 1000) - deviceNowS();
  };

  const learn = (headers: Record<string, string>) => {
    const raw = headers.date ?? headers.Date;
    if (!raw) return;
    learnFrom(raw);
  };

  const proofFor = async (htm: string, path: string, token: string | null, chal?: string) =>
    buildProof(o.key, {
      htm,
      htu: canonicalHtu(o.baseUrl, path),
      iat: nowS(),
      ...(token ? { ath: b64url(sha256(utf8(token))) } : {}),
      ...(chal ? { chal } : {}),
    });

  // `/ws/m/chat?v=1` (P§6.1). `canonicalHtu` drops the query, so the DPoP proof is signed over
  // the bare path regardless of what `wsUrl` appends to it.
  const languageHeader = (): Record<string, string> => (o.language ? { 'Accept-Language': o.language() } : {});
  const wsUrl = (base: string) => `${base.replace(/^http/, 'ws')}/ws/m/chat?v=1`;
  const socketHeaders = async (a: Auth): Promise<Record<string, string>> => ({
    ...languageHeader(),
    Authorization: `Bearer ${a.accessToken}`,
    DPoP: await proofFor('GET', '/ws/m/chat', a.accessToken),
  });

  // The single-flighted renewal only covers calls that fail *while it is in flight*: A gets a
  // 401, starts renewing, and B's 401 (sent with the same stale token) arrives before the
  // renewal settles — both await the same `renewing` promise, one real renewal. But if B's 401
  // arrives *after* A's renewal has already settled (`renewing` is back to `null`), a plain
  // single-flight would renew a second time for a token that is already known to be current.
  // `latestToken` remembers the last token a renewal produced so that case reuses it instead.
  let latestToken: string | null = null;
  let renewing: Promise<string | null> | null = null;
  const renewOnce = (): Promise<string | null> => {
    renewing ??= o.onTokenExpired().finally(() => {
      renewing = null;
    });
    return renewing;
  };

  const pendingDeletion = (err: ApiError) => {
    if (err.status === 403 && err.code === ACCOUNT_PENDING_DELETION) o.onAccountPendingDeletion?.();
  };

  // `z.ZodType<T, z.ZodTypeDef, any>`, not the one-arg `z.ZodType<T>`: a schema with a `.default(...)`
  // field (e.g. `chatResponse.grants`) has an Input type stricter (optional) than its Output type T,
  // and pinning T's Input parameter to T too — what `z.ZodType<T>` does — makes inference pick up that
  // narrower Input, so callers below end up with an optional field TypeScript then refuses to hand to
  // `MobileApi`'s (output-typed) return type. Leaving Input as `any` infers T from Output alone.
  /** A 2xx body: JSON that matches `schema`. Anything else — a captive portal, a Cloudflare
   * interstitial, a shape this build does not know — is one `BAD_RESPONSE`, never a raw SyntaxError
   * quoting arbitrary response text. */
  function decode<T>(text: string, schema: z.ZodType<T, z.ZodTypeDef, any>): T {
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(502, 'BAD_RESPONSE', t('Resposta inesperada do servidor'));
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError(502, 'BAD_RESPONSE', t('Resposta inesperada do servidor'));
    return parsed.data;
  }

  async function call<T>(htm: string, path: string, schema: z.ZodType<T, z.ZodTypeDef, any>, opts: CallOptions = {}): Promise<T> {
    const headers: Record<string, string> = { 'X-Termhub-App': o.app, Accept: 'application/json', ...languageHeader() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.proof !== false) headers.DPoP = await proofFor(htm, path, opts.token ?? null, opts.chal);

    const res = await o.transport.fetch({
      method: htm,
      url: o.baseUrl + path,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    learn(res.headers);

    if (res.status >= 200 && res.status < 300) return decode(res.text, schema);

    const err = ApiError.fromBody(res.status, res.headers, res.text);
    pendingDeletion(err);
    if (err.status === 401 && err.code === 'TOKEN_EXPIRED' && opts.token && opts.retry !== false) {
      if (latestToken && latestToken !== opts.token) {
        // Someone else already renewed while this call was in flight; reuse that token instead
        // of renewing again.
        return call(htm, path, schema, { ...opts, token: latestToken, retry: false });
      }
      const fresh = await renewOnce();
      if (fresh) {
        latestToken = fresh;
        return call(htm, path, schema, { ...opts, token: fresh, retry: false });
      }
    }
    throw err;
  }

  /** `call` for a raw-body upload through `Transport.upload`: bearer, DPoP over the bare path (the
   * query is not part of the proof, `canonicalHtu` drops it), the same single retry on a renewed
   * token. Only ever with a token: nothing is uploaded before enrolment. */
  async function uploadCall<T>(path: string, fileUri: string, mime: string, schema: z.ZodType<T, z.ZodTypeDef, any>, token: string, onProgress?: (fraction: number) => void, retry = true): Promise<T> {
    const headers: Record<string, string> = { 'X-Termhub-App': o.app, Accept: 'application/json', ...languageHeader(), Authorization: `Bearer ${token}`, DPoP: await proofFor('POST', path, token) };
    const res = await o.transport.upload(o.baseUrl + path, fileUri, mime, headers, onProgress);
    if (res.status >= 200 && res.status < 300) return decode(res.body, schema);

    const err = ApiError.fromBody(res.status, {}, res.body);
    pendingDeletion(err);
    if (err.status === 401 && err.code === 'TOKEN_EXPIRED' && retry) {
      const fresh = latestToken && latestToken !== token ? latestToken : await renewOnce();
      if (fresh) {
        latestToken = fresh;
        return uploadCall(path, fileUri, mime, schema, fresh, onProgress, false);
      }
    }
    throw err;
  }

  const empty = (htm: string, path: string, opts: CallOptions = {}): Promise<void> =>
    call(htm, path, emptyResponse, opts).then(() => undefined);

  const api: MobileApi = {
    mode: o.mode ?? 'http',

    forgetTokens: () => {
      latestToken = null;
    },

    requestDevice: (body: TDeviceRequestBody) => call('POST', '/api/m/v1/devices/requests', deviceRequestResponse, { body, proof: false }),
    pollRequest: (requestId, requestSecret) =>
      call('GET', `/api/m/v1/devices/requests/${requestId}`, devicePollResponse, { token: requestSecret, proof: false, retry: false }),
    activate: (body: TDeviceActivateBody) => call('POST', '/api/m/v1/devices/activate', deviceActivateResponse, { body }),

    challenge: (body: TChallengeBody) => call('POST', '/api/m/v1/session/challenge', challengeResponse, { body, proof: false }),
    token: (body: TTokenBody) => call('POST', '/api/m/v1/session/token', tokenResponse, { body, chal: body.challenge, retry: false }),
    me: (a: Auth) => call('GET', '/api/m/v1/me', meResponse, { token: a.accessToken }),
    deviceSelf: (a: Auth) => call('GET', '/api/m/v1/devices/self', deviceSelfSchema, { token: a.accessToken }),
    revokeSelf: (a: Auth) => empty('POST', '/api/m/v1/devices/self/revoke', { token: a.accessToken }),
    setPushToken: (a: Auth, token: string) => empty('PUT', '/api/m/v1/push-token', { token: a.accessToken, body: { token } }),
    pushTest: (a: Auth, body: PushTestBody) => call('POST', '/api/m/v1/push-test', pushTestResponse, { token: a.accessToken, body }),
    pushSettings: (a: Auth) => call('GET', '/api/m/v1/push-settings', pushSettings, { token: a.accessToken }),
    setPushSettings: (a: Auth, body: PushSettings) => call('PUT', '/api/m/v1/push-settings', pushSettings, { token: a.accessToken, body }),

    accountDeletion: (a: Auth) => call('GET', '/api/m/v1/account/deletion', accountDeletionStatus, { token: a.accessToken }),
    requestAccountDeletion: (a: Auth, body: AccountDeletionBody) => call('POST', '/api/m/v1/account/deletion', accountDeletionStatus, { token: a.accessToken, body }),
    cancelAccountDeletion: (a: Auth) => call('DELETE', '/api/m/v1/account/deletion', accountDeletionStatus, { token: a.accessToken }),

    chatProjects: (a: Auth) => call('GET', '/api/m/v1/chat/projects', chatProjectsResponse, { token: a.accessToken }),
    setProjectFavorite: (a: Auth, projectId: string, favorite: boolean) =>
      empty('PUT', `/api/m/v1/chat/projects/${encodeURIComponent(projectId)}/favorite`, { token: a.accessToken, body: { favorite } }),
    chat: (a: Auth, projectId: string | null) =>
      call('GET', `/api/m/v1/chat${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`, chatResponse, { token: a.accessToken }),
    hostOptions: (a: Auth) => call('GET', '/api/m/v1/chat/host/options', hostOptionsResponse, { token: a.accessToken }),
    setHost: (a: Auth, body: TSetHostBody) => empty('POST', '/api/m/v1/chat/host', { token: a.accessToken, body }),
    sendMessage: (a: Auth, body: TMobileMessageBody) => call('POST', '/api/m/v1/chat/messages', sendAccepted, { token: a.accessToken, body }),
    reset: (a: Auth, projectId: string | null) => empty('POST', '/api/m/v1/chat/reset', { token: a.accessToken, body: { project_id: projectId } }),
    decide: (a: Auth, actionId: string, body: TMobileDecisionBody) =>
      empty('POST', `/api/m/v1/chat/actions/${actionId}/decision`, { token: a.accessToken, body }),
    decideMany: (a: Auth, body: TMobileBatchDecisionBody) => empty('POST', '/api/m/v1/chat/actions/decisions', { token: a.accessToken, body }),
    decisionChallenges: (a: Auth, body: TDecisionChallengesBody) => call('POST', '/api/m/v1/chat/actions/challenges', decisionChallengesResponse, { token: a.accessToken, body }),
    revokeGrant: (a: Auth, grantId: string) => empty('DELETE', `/api/m/v1/chat/grants/${encodeURIComponent(grantId)}`, { token: a.accessToken }),
    // `kinds=all_standing` unconditionally: "Permissões do chat" always wants tab, project and standing
    // grants together (design spec 2026-09-26 §7, TER-386).
    listGrants: (a: Auth, q: { state: 'active' | 'ended'; cursor?: string | null }) =>
      call('GET', `/api/m/v1/chat/grants?state=${q.state}${q.cursor ? `&cursor=${encodeURIComponent(q.cursor)}` : ''}&kinds=all_standing`, chatGrantListResponse, { token: a.accessToken }),
    answerTabQuestion: (a: Auth, id: string, body: TTabQuestionAnswerBody) =>
      empty('POST', `/api/m/v1/chat/tab-questions/${encodeURIComponent(id)}/answer`, { token: a.accessToken, body }),
    cancelAutoAnswer: (a: Auth, id: string) =>
      call('POST', `/api/m/v1/chat/tab-questions/${encodeURIComponent(id)}/auto-answer/cancel`, tabQuestionAutoAnswerCancelResponse, { token: a.accessToken, body: {} }),
    tabQuestionScreen: (a: Auth, id: string) =>
      call('GET', `/api/m/v1/chat/tab-questions/${encodeURIComponent(id)}/screen`, tabQuestionScreenResponse, { token: a.accessToken }),
    sendTabSuggestion: (a: Auth, id: string, body: TTabSuggestionSendBody) =>
      empty('POST', `/api/m/v1/chat/tab-suggestions/${encodeURIComponent(id)}/send`, { token: a.accessToken, body }),
    dismissTabSuggestion: (a: Auth, id: string) => empty('POST', `/api/m/v1/chat/tab-suggestions/${encodeURIComponent(id)}/dismiss`, { token: a.accessToken, body: {} }),
    answerTabLimit: (a: Auth, id: string, accountId: string | null) =>
      call('POST', `/api/m/v1/chat/tab-limits/${encodeURIComponent(id)}/answer`, tabLimitAnswerResponse, { token: a.accessToken, body: { account_id: accountId } }).then((r) => r.tab_limit),
    getProjectAi: (a: Auth, projectId: string) => call('GET', `/api/m/v1/projects/${encodeURIComponent(projectId)}/setup/ai`, projectAiResponse, { token: a.accessToken }),
    saveProjectAi: (a: Auth, projectId: string, ai: TProjectAi) =>
      call('PUT', `/api/m/v1/projects/${encodeURIComponent(projectId)}/setup/ai`, projectAiResponse, { token: a.accessToken, body: { ai } }),
    getAutomationSetup: (a: Auth, projectId: string) =>
      call('GET', `/api/m/v1/projects/${encodeURIComponent(projectId)}/setup/automation`, automationSetupResponse, { token: a.accessToken }).then((r) => r.automation),
    saveAutomationSetup: (a: Auth, projectId: string, automation: TAutomationSetup, proof?: { challenge: string; pin_proof: string }) =>
      call('PUT', `/api/m/v1/projects/${encodeURIComponent(projectId)}/setup/automation`, automationSetupResponse, { token: a.accessToken, body: { automation, ...proof } }).then((r) => r.automation),
    getPauseState: (a: Auth) => call('GET', '/api/m/v1/automation/state', pauseState, { token: a.accessToken }),
    pauseAutomation: (a: Auth, scope: string, interrupt = false) =>
      call('POST', '/api/m/v1/automation/pause', pauseResponse, { token: a.accessToken, body: { scope, interrupt } }).then((r) => r.paused_at),
    resumeAutomation: (a: Auth, scope: string) => empty('POST', '/api/m/v1/automation/resume', { token: a.accessToken, body: { scope } }),
    setCardAuto: (a: Auth, taskId: string, auto: boolean) =>
      call('PUT', `/api/m/v1/tasks/${encodeURIComponent(taskId)}/auto`, cardAutoResponse, { token: a.accessToken, body: { auto } }).then((r) => r.auto),
    cancelSubagent: (a: Auth, id: string) =>
      call('POST', `/api/m/v1/chat/subagents/${encodeURIComponent(id)}/cancel`, cancelSubagentResponse, { token: a.accessToken }).then((r) => r.subagent),
    // The name and project ride in the query (the body is the file itself); `uploadCall` signs the proof
    // over the bare path, as the server checks it.
    uploadAttachment: (a: Auth, file, projectId, onProgress) =>
      uploadCall(`/api/m/v1/chat/attachments?name=${encodeURIComponent(file.name)}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}`, file.uri, file.mime, chatAttachmentResponse, a.accessToken, onProgress).then((r) => r.attachment),
    deleteAttachment: (a: Auth, id: string) => empty('DELETE', `/api/m/v1/chat/attachments/${encodeURIComponent(id)}`, { token: a.accessToken }),
    retryAttachment: (a: Auth, id: string) =>
      call('POST', `/api/m/v1/chat/attachments/${encodeURIComponent(id)}/retry`, chatAttachmentResponse, { token: a.accessToken }).then((r) => r.attachment),
    attachmentSource: async (a: Auth, id: string) => {
      const path = `/api/m/v1/chat/attachments/${encodeURIComponent(id)}`;
      return {
        uri: o.baseUrl + path,
        headers: { 'X-Termhub-App': o.app, ...languageHeader(), Authorization: `Bearer ${a.accessToken}`, DPoP: await proofFor('GET', path, a.accessToken) },
      };
    },
    transcriptionConfig: (a: Auth) => call('GET', '/api/m/v1/transcriptions/config', transcriptionConfigResponse, { token: a.accessToken }),
    transcribe: (a: Auth, fileUri, mime, seconds, onProgress) =>
      uploadCall(`/api/m/v1/transcriptions?seconds=${Math.round(seconds)}`, fileUri, mime, transcriptionResponse, a.accessToken, onProgress).then((r) => r.transcription),
    transcription: (a: Auth, id) => call('GET', `/api/m/v1/transcriptions/${encodeURIComponent(id)}`, transcriptionResponse, { token: a.accessToken }).then((r) => r.transcription),

    chatDecisions: (a: Auth, q, cursor) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      return call('GET', `/api/m/v1/chat/decisions${qs ? `?${qs}` : ''}`, decisionsResponse, { token: a.accessToken });
    },
    forgetChatDecision: (a: Auth, id: string) => empty('DELETE', `/api/m/v1/chat/decisions/${encodeURIComponent(id)}`, { token: a.accessToken }),
    chatMemory: (a: Auth) => call('GET', '/api/m/v1/chat/memory', chatMemoryResponse, { token: a.accessToken }),
    setChatMemory: (a: Auth, body: boolean | { enabled?: boolean; autodecide?: boolean; codex_replies?: boolean; context_limit?: number | null }) =>
      call('PATCH', '/api/m/v1/chat/memory', chatMemoryResponse, { token: a.accessToken, body: typeof body === 'boolean' ? { enabled: body } : body }),
    chatNotes: (a: Auth, cursor) => {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      return call('GET', `/api/m/v1/chat/notes${qs ? `?${qs}` : ''}`, notesResponse, { token: a.accessToken });
    },
    forgetChatNote: (a: Auth, id: string) => empty('DELETE', `/api/m/v1/chat/notes/${encodeURIComponent(id)}`, { token: a.accessToken }),
    chatLessons: (a: Auth, q, cursor) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      return call('GET', `/api/m/v1/chat/lessons${qs ? `?${qs}` : ''}`, lessonListSchema, { token: a.accessToken });
    },
    verifyChatLesson: (a: Auth, id: string) => call('POST', `/api/m/v1/chat/lessons/${encodeURIComponent(id)}/verify`, lessonItemSchema, { token: a.accessToken, body: {} }),
    unverifyChatLesson: (a: Auth, id: string) => call('DELETE', `/api/m/v1/chat/lessons/${encodeURIComponent(id)}/verify`, lessonItemSchema, { token: a.accessToken }),
    forgetChatLesson: (a: Auth, id: string) => call('DELETE', `/api/m/v1/chat/lessons/${encodeURIComponent(id)}`, lessonForgetSchema, { token: a.accessToken }),

    notifications: (a: Auth, before?: string) =>
      call('GET', `/api/m/v1/notifications${before ? `?before=${encodeURIComponent(before)}` : ''}`, notificationsResponse, {
        token: a.accessToken,
      }),
    markRead: (a: Auth, id: string) => empty('POST', `/api/m/v1/notifications/${id}/read`, { token: a.accessToken }),

    progress: (a: Auth, scope: 'active' | 'all' = 'active') => call('GET', `/api/m/v1/progress?scope=${scope}`, progressResponse, { token: a.accessToken }),

    filePreview: (a: Auth, q: TFilePreviewQuery) => {
      const p = new URLSearchParams({ path: q.path });
      if (q.tab_id) p.set('tab_id', q.tab_id);
      if (q.project_id) p.set('project_id', q.project_id);
      if (q.machine_id) p.set('machine_id', q.machine_id);
      return call('GET', `/api/m/v1/file-preview?${p.toString()}`, filePreviewResponse, { token: a.accessToken });
    },
    fileRecent: (a: Auth, projectId: string) =>
      call('GET', `/api/m/v1/file-recent?project_id=${encodeURIComponent(projectId)}`, fileRecentResponse, { token: a.accessToken }),
    tabs: (a: Auth) => call('GET', '/api/m/v1/tabs', tabsResponse, { token: a.accessToken }),
    startSession: (a: Auth, body: TStartSessionBody) => call('POST', '/api/m/v1/tabs', startSessionResponse, { token: a.accessToken, body }),
    tabChat: (a: Auth, tabId: string, before?: string) =>
      call('GET', `/api/m/v1/tabs/${encodeURIComponent(tabId)}/chat${before ? `?before=${encodeURIComponent(before)}` : ''}`, tabChatPage, { token: a.accessToken }),
    sendTabMessage: (a: Auth, tabId: string, text: string) => empty('POST', `/api/m/v1/tabs/${encodeURIComponent(tabId)}/chat/messages`, { token: a.accessToken, body: { text } }),
    tabAction: (a: Auth, tabId: string, action: TTabChatAction) =>
      call('POST', `/api/m/v1/tabs/${encodeURIComponent(tabId)}/chat/actions`, tabActionResponse, { token: a.accessToken, body: { action } }),
    // Always sent as octet-stream: the server saves the bytes under `name` and never reads the type, and a
    // JSON file sent as `application/json` would be parsed as a request body instead of saved.
    uploadTabFile: (a: Auth, tabId: string, fileUri: string, name: string, _mime: string) =>
      uploadCall(`/api/m/v1/tabs/${encodeURIComponent(tabId)}/chat/files?name=${encodeURIComponent(name)}`, fileUri, 'application/octet-stream', tabFileResponse, a.accessToken),
    tabScreen: (a: Auth, tabId: string, lines?: number) =>
      call('GET', `/api/m/v1/tabs/${encodeURIComponent(tabId)}/screen${lines ? `?lines=${lines}` : ''}`, tabScreenResponse, { token: a.accessToken }),

    tabEvents: (auth, tabId, handlers) => {
      // The same renewal rule as `events` below: a refused upgrade or a 1008 renews only a stale token.
      const path = `/ws/m/tabs/${encodeURIComponent(tabId)}`;
      let renewBeforeNext = false;
      const refusedByServer = () => {
        if (o.tokenStale?.() ?? true) renewBeforeNext = true;
      };
      const headers = async (): Promise<Record<string, string>> => {
        let fresh: string | null = null;
        if (renewBeforeNext) {
          renewBeforeNext = false;
          fresh = await renewOnce();
          if (fresh) latestToken = fresh;
        }
        const token = fresh ?? auth().accessToken;
        return { ...languageHeader(), Authorization: `Bearer ${token}`, DPoP: await proofFor('GET', path, token) };
      };
      const socket = createTabSocket({
        transport: o.transport,
        url: (after) => `${o.baseUrl.replace(/^http/, 'ws')}${path}?v=1${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        headers,
        after: handlers.after,
        onFrame: handlers.onFrame,
        onRefused: refusedByServer,
        onClose: (code, final) => {
          if (code === 1008) refusedByServer();
          handlers.onClose(code, final);
        },
        onServerTime: learnFrom,
        backoff: o.backoff,
        foreground: o.foreground,
      });
      return () => socket.close();
    },

    events: (a, handlers) => {
      const current = typeof a === 'function' ? a : () => a;
      // A refused upgrade (the server's HTTP 401 before switching protocols, seen as a close that
      // never opened) or a `1008` close means the server refused the token or the proof, or
      // refused the upgrade for an unrelated reason (TER-93: a bad Origin) — renewing on every
      // such refusal renewed a perfectly fresh token every 1–30 s. So the next attempt only runs
      // the same single-flighted renewal as an HTTP `TOKEN_EXPIRED` when the token is actually
      // stale (`o.tokenStale`, defaulting to always stale) — once per attempt, so a failed
      // renewal backs off with the socket. When it yields nothing (locked), the attempt goes on
      // with whatever `current()` gives — or throws, which the socket treats as a dropped
      // connection — and keeps backing off; never final.
      let renewBeforeNext = false;
      const refusedByServer = () => {
        if (o.tokenStale?.() ?? true) renewBeforeNext = true;
      };
      const headers = async () => {
        let fresh: string | null = null;
        if (renewBeforeNext) {
          renewBeforeNext = false;
          fresh = await renewOnce();
          if (fresh) latestToken = fresh;
        }
        return socketHeaders(fresh ? { accessToken: fresh } : current());
      };
      const socket = createChatSocket({
        transport: o.transport,
        url: wsUrl(o.baseUrl),
        headers,
        onEvent: handlers.onEvent,
        onReconnect: handlers.onReconnect,
        onRefused: refusedByServer,
        onClose: (code, final) => {
          if (code === 1008) refusedByServer();
          handlers.onClose(code, final);
        },
        onServerTime: learnFrom,
        backoff: o.backoff,
        foreground: o.foreground,
      });
      return () => socket.close();
    },
  };

  // Not `Object.assign(api, { get skewSeconds() {...} })`: `Object.assign` reads the getter once
  // and copies the resulting *value*, which would freeze `skewSeconds` at construction time
  // instead of tracking `skew` live. `defineProperty` installs a real accessor.
  Object.defineProperty(api, 'skewSeconds', { get: () => skew, enumerable: true });
  return api as MobileApi & { readonly skewSeconds: number };
}
