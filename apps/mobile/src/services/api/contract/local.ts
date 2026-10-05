// The app's own schemas: the shapes P§6 needs that `packages/mobile-api` does not carry (the chat
// response, the host state union, and the generic error/empty bodies), transcribed from
// `apps/web/src/lib/types.ts` (`ChatConversation`, `ChatMessage`, `ChatAction`, `ChatHostState`,
// ~lines 586-730) so the mock — and later `HttpMobileApi` — validate against the exact wire shape
// the server serialises for both clients.
import { z } from 'zod';
import {
  agentOnCard,
  cardProgress,
  challengeBody,
  challengeResponse,
  chatActionClass,
  chatActionSchema,
  chatAttachment,
  chatEventSchema,
  chatGrantListItemSchema,
  chatGrantListResponse,
  chatGrantSchema,
  chatMemoryPatchBody,
  chatMemoryResponse,
  chatMessage,
  chatProjectGrantSchema,
  chatProjectItem,
  chatStandingGrantSchema,
  chatProjectsResponse,
  conciergeNoteView,
  decisionChallengesBody,
  decisionChallengesResponse,
  decisionsResponse,
  decisionViewSchema,
  deviceActivateBody,
  deviceActivateResponse,
  deviceInfo,
  deviceRequestBody,
  deviceRequestResponse,
  devicePollResponse,
  deviceSelf,
  epicProgress,
  hostOptionsResponse,
  lessonForgetSchema,
  lessonItemSchema,
  lessonListSchema,
  mobileBatchDecisionBody,
  mobileDecisionBody,
  mobileMessageBody,
  notesResponse,
  notificationRow,
  notificationsResponse,
  p256Jwk,
  progressEstimate,
  progressResponse,
  projectAiBody,
  projectAiOption,
  projectAiResponse,
  projectAiSchema,
  pullRequestBadge,
  pushTokenBody,
  sendAccepted,
  subagentViewSchema,
  tabQuestionAnswerBody,
  tabQuestionAutoAnswerCancelResponse,
  tabQuestionSchema,
  tabQuestionScreenResponse,
  tabQuestionSuggestionSchema,
  tabLimitAnswerBody,
  tabLimitAnswerResponse,
  tabLimitSchema,
  tabSuggestionSchema,
  tabSuggestionSendBody,
  tokenBody,
  tokenResponse,
  verificationCodeSchema,
} from '@termhub/mobile-api';

/** Mirrors `ChatMessage` (web types.ts ~626): the same schema as events' `chatMessage`, re-exported
 * under the app's `*Schema` naming so every schema in this file follows one convention. */
export const chatMessageSchema = chatMessage;

/** Mirrors `ChatHostMachine` = `Pick<Machine, 'id' | 'name'>` (web types.ts). */
const chatHostMachine = z.object({ id: z.string(), name: z.string() });

/** Mirrors `ChatHostAccount` (web types.ts). `via: 'project'` (TER-589) marks a project chat running on
 * the project's configured account: optional, and `kind` keeps its three values, so an app that predates
 * it still parses (`z.object` strips the unknown key). */
const chatHostAccount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chosen'), id: z.string(), label: z.string(), via: z.literal('project').optional() }),
  z.object({ kind: z.literal('default') }),
  z.object({ kind: z.literal('lost') }),
]);

/**
 * Mirrors `ChatHostState` (web types.ts ~658), field names verbatim — `configDir`, `sessionAtStake`,
 * camelCase — because the server serialises the very same object to the phone as it does to the web.
 */
export const chatHostStateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    machine: chatHostMachine,
    configDir: z.string().nullable(),
    account: chatHostAccount,
    sessionAtStake: z.boolean(),
  }),
  z.object({ kind: z.literal('no_machine') }),
  z.object({ kind: z.literal('not_chosen'), machines: z.array(chatHostMachine), sessionAtStake: z.boolean() }),
  z.object({ kind: z.literal('offline'), machine: chatHostMachine }),
  z.object({ kind: z.literal('agent_too_old'), machine: chatHostMachine, version: z.string() }),
]);

/** Mirrors `ChatConversation` (web types.ts ~587), the fields the phone needs. */
export const chatConversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  project_id: z.string().nullable(),
  machine_id: z.string().nullable().optional(),
  ai_account_id: z.string().nullable().optional(),
  archived_at: z.string().nullable(),
  last_message_at: z.string().nullable(),
});

/** `GET chat` and `POST chat/host`'s payload (P§6). `subagents` (spec 2026-09-26 panel §4) defaults
 * to `[]`, like the other panel arrays, so a server that predates it still parses. */
export const chatResponse = z.object({
  conversation: chatConversationSchema,
  messages: z.array(chatMessageSchema),
  actions: z.array(chatActionSchema),
  grants: z.array(chatGrantSchema).default([]),
  /** "Permitir sempre neste projeto" grants still in force for this conversation (design spec
   * 2026-09-26 §7). Defaulted: an older server never sends the field. */
  project_grants: z.array(chatProjectGrantSchema).default([]),
  /** "Liberar sem prazo" grants (spec 2026-09-28 TER-386): the project's, or all of the user's in the
   * account-wide chat — not bound to the conversation. Defaulted: an older server never sends the field. */
  standing_grants: z.array(chatStandingGrantSchema).default([]),
  tab_questions: z.array(tabQuestionSchema).default([]),
  tab_suggestions: z.array(tabSuggestionSchema).default([]),
  /** The usage-limit cards of the project's tabs (spec 2026-09-30 project AI accounts §7.2). Defaulted:
   * an older server never sends the field. */
  tab_limits: z.array(tabLimitSchema).default([]),
  subagents: z.array(subagentViewSchema).default([]),
  /** The answer rows still to be answered (spec 2026-09-29): what the screen shows as "pensando…"
   * when it opens in the middle of a run. Defaulted: an older server never sends the field. */
  open_answer_ids: z.array(z.string()).default([]),
  host: chatHostStateSchema,
});

/** `POST chat/subagents/:id/cancel`'s `202` payload (spec 2026-09-26 panel §5.4). */
export const cancelSubagentResponse = z.object({ subagent: subagentViewSchema });

/** `GET me` (P§6). */
export const meResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  permissions: z.array(z.string()),
  device: deviceSelf,
});

/** `POST chat/host`'s body — the same shape as the web's (`hostBody` in `apps/server/src/routes/m-chat.ts`). */
export const setHostBody = z.object({ machine_id: z.string().min(1).max(64), ai_account_id: z.string().min(1).max(64).nullish() });

/** `POST chat/reset`'s body. */
export const resetBody = z.object({ project_id: z.string().min(1).max(64).nullish() });

/** The wire shape of every non-2xx response (P§6, design spec §4): `error` is pt-BR text, `code` is
 * the machine-readable one `ApiError` carries. */
export const errorBody = z.object({
  error: z.string(),
  code: z.string(),
  attempts_left: z.number().int().optional(),
  retry_after: z.number().optional(),
});

/** Routes that answer `{}` / `204` (`revokeSelf`, `setPushToken`, `decide`, `markRead`). */
export const emptyResponse = z.object({}).passthrough();

/** `POST transcriptions` (`202`) and `GET transcriptions/:id`: the server's `TranscriptionView`
 * (`apps/server/src/terminal/transcription.ts`), the same object the web polls. */
export const transcriptionSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'done', 'error']),
  text: z.string().optional(),
  /** audio length in seconds */
  duration: z.number().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  /** pending only: estimated seconds until the text is ready */
  eta_seconds: z.number().optional(),
  /** pending only: 0..1 share of the estimated time already elapsed */
  progress: z.number().optional(),
});
export const transcriptionResponse = z.object({ transcription: transcriptionSchema });
/** `GET transcriptions/config`: whether the server transcribes audio at all. */
export const transcriptionConfigResponse = z.object({ enabled: z.boolean() });

/** `POST chat/attachments`' answer (spec 2026-09-26 §5.3), and `GET chat/attachments/:id/status`. */
export const chatAttachmentResponse = z.object({ attachment: chatAttachment });

// `z.infer` companions for every schema of the contract, prefixed `T` — including the ones of
// `@termhub/mobile-api`, which exports its schemas but not these app-side type names.
export type TVerificationCode = z.infer<typeof verificationCodeSchema>;
export type TP256Jwk = z.infer<typeof p256Jwk>;
export type TDeviceInfo = z.infer<typeof deviceInfo>;
export type TDeviceRequestBody = z.infer<typeof deviceRequestBody>;
export type TDeviceRequestResponse = z.infer<typeof deviceRequestResponse>;
export type TDevicePollResponse = z.infer<typeof devicePollResponse>;
export type TDeviceActivateBody = z.infer<typeof deviceActivateBody>;
export type TDeviceActivateResponse = z.infer<typeof deviceActivateResponse>;
export type TDeviceSelf = z.infer<typeof deviceSelf>;

export type TChallengeBody = z.infer<typeof challengeBody>;
export type TChallengeResponse = z.infer<typeof challengeResponse>;
export type TTokenBody = z.infer<typeof tokenBody>;
export type TTokenResponse = z.infer<typeof tokenResponse>;
export type TPushTokenBody = z.infer<typeof pushTokenBody>;

export type TMobileMessageBody = z.infer<typeof mobileMessageBody>;
export type TSendAccepted = z.infer<typeof sendAccepted>;
export type TMobileDecisionBody = z.infer<typeof mobileDecisionBody>;
export type TMobileBatchDecisionBody = z.infer<typeof mobileBatchDecisionBody>;
export type TDecisionChallengesBody = z.infer<typeof decisionChallengesBody>;
export type TDecisionChallengesResponse = z.infer<typeof decisionChallengesResponse>;
export type TChatProjectItem = z.infer<typeof chatProjectItem>;
export type TChatProjectsResponse = z.infer<typeof chatProjectsResponse>;
export type THostOptionsResponse = z.infer<typeof hostOptionsResponse>;

export type TChatMessage = z.infer<typeof chatMessageSchema>;
export type TChatActionClass = z.infer<typeof chatActionClass>;
export type TChatEvent = z.infer<typeof chatEventSchema>;

export type TNotificationRow = z.infer<typeof notificationRow>;
export type TNotificationsResponse = z.infer<typeof notificationsResponse>;

export type TChatHostState = z.infer<typeof chatHostStateSchema>;
export type TChatAction = z.infer<typeof chatActionSchema>;
export type TChatGrant = z.infer<typeof chatGrantSchema>;
/** "Permitir sempre neste projeto" (server `ChatProjectGrantView`). */
export type TChatProjectGrant = z.infer<typeof chatProjectGrantSchema>;
/** "Liberar sem prazo" (server `ChatStandingGrantView`, spec 2026-09-28 TER-386). */
export type TChatStandingGrant = z.infer<typeof chatStandingGrantSchema>;
export type TChatGrantListItem = z.infer<typeof chatGrantListItemSchema>;
export type TChatGrantListResponse = z.infer<typeof chatGrantListResponse>;
export type TTabQuestion = z.infer<typeof tabQuestionSchema>;
export type TTabQuestionAnswerBody = z.infer<typeof tabQuestionAnswerBody>;
export type TTabQuestionScreenResponse = z.infer<typeof tabQuestionScreenResponse>;
export type TTabQuestionSuggestion = z.infer<typeof tabQuestionSuggestionSchema>;
/** `POST chat/tab-questions/:id/auto-answer/cancel` (concierge memory spec 2026-09-26 §6). */
export type TTabQuestionAutoAnswerCancelResponse = z.infer<typeof tabQuestionAutoAnswerCancelResponse>;

// "Memória do chat" (spec 2026-09-26 §4.6/§5.2, concierge memory D8/D12): a remembered decision, its
// page, the suggestion/autodecide switches and a concierge note's page — mirrors
// `apps/web/src/lib/api.ts`'s `chatDecisions`/`chatMemory`/`setChatMemory`/`chatNotes`/`forgetChatNote`.
export type TChatDecision = z.infer<typeof decisionViewSchema>;
export type TDecisionsResponse = z.infer<typeof decisionsResponse>;
export type TChatMemory = z.infer<typeof chatMemoryResponse>;
export type TChatMemoryPatchBody = z.infer<typeof chatMemoryPatchBody>;
export type TConciergeNote = z.infer<typeof conciergeNoteView>;
export type TNotesResponse = z.infer<typeof notesResponse>;
// "Lições" (spec 2026-09-27 failure lessons §6/§8): mirrors `apps/web/src/lib/api.ts`'s
// `api.chat.lessons.list`/`verify`/`unverify`/`forget`.
export type TLessonItem = z.infer<typeof lessonItemSchema>;
export type TLessonsResponse = z.infer<typeof lessonListSchema>;
export type TLessonForgetResponse = z.infer<typeof lessonForgetSchema>;
export type TTabSuggestion = z.infer<typeof tabSuggestionSchema>;
export type TTabSuggestionSendBody = z.infer<typeof tabSuggestionSendBody>;
// The project's AI accounts and models, and the usage-limit card (spec 2026-09-30 project AI accounts
// §7.2, §8): `@termhub/mobile-api`'s schemas under this file's `T`-prefixed convention.
export type TTabLimit = z.infer<typeof tabLimitSchema>;
export type TTabLimitAnswerBody = z.infer<typeof tabLimitAnswerBody>;
export type TTabLimitAnswerResponse = z.infer<typeof tabLimitAnswerResponse>;
export type TProjectAi = z.infer<typeof projectAiSchema>;
export type TProjectAiOption = z.infer<typeof projectAiOption>;
export type TProjectAiResponse = z.infer<typeof projectAiResponse>;
export type TProjectAiBody = z.infer<typeof projectAiBody>;
// Trabalho automático (spec 2026-10-04): `@termhub/mobile-api`'s automation schemas.
export type { AutomationAutonomy as TAutomationAutonomy, AutomationSetup as TAutomationSetup, AutomationSetupResponse as TAutomationSetupResponse, CardAutoResponse as TCardAutoResponse, PauseState as TPauseState } from '@termhub/mobile-api';
export type TChatConversation = z.infer<typeof chatConversationSchema>;
export type TChatResponse = z.infer<typeof chatResponse>;
export type TMeResponse = z.infer<typeof meResponse>;
export type TSetHostBody = z.infer<typeof setHostBody>;
export type TResetBody = z.infer<typeof resetBody>;
export type TErrorBody = z.infer<typeof errorBody>;
export type TEmptyResponse = z.infer<typeof emptyResponse>;
export type TTranscription = z.infer<typeof transcriptionSchema>;
export type TTranscriptionResponse = z.infer<typeof transcriptionResponse>;
export type TTranscriptionConfigResponse = z.infer<typeof transcriptionConfigResponse>;
export type TChatAttachment = z.infer<typeof chatAttachment>;
export type TChatAttachmentResponse = z.infer<typeof chatAttachmentResponse>;

// Progress panel (spec 2026-09-26 progress-panel D10): `@termhub/mobile-api`'s schemas, under this
// file's `T`-prefixed convention.
export type TProgressResponse = z.infer<typeof progressResponse>;
export type TEpicProgress = z.infer<typeof epicProgress>;
export type TCardProgress = z.infer<typeof cardProgress>;
export type TAgentOnCard = z.infer<typeof agentOnCard>;
export type { AutomationFeedEvent as TAutomationFeedEvent } from '@termhub/mobile-api';
export type TProgressEstimate = z.infer<typeof progressEstimate>;
export type TPullRequestBadge = z.infer<typeof pullRequestBadge>;
export type TCancelSubagentResponse = z.infer<typeof cancelSubagentResponse>;
