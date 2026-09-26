// The app's own schemas: the shapes P§6 needs that `packages/mobile-api` does not carry (the chat
// response, the host state union, and the generic error/empty bodies), transcribed from
// `apps/web/src/lib/types.ts` (`ChatConversation`, `ChatMessage`, `ChatAction`, `ChatHostState`,
// ~lines 586-730) so the mock — and later `HttpMobileApi` — validate against the exact wire shape
// the server serialises for both clients.
import { z } from 'zod';
import {
  challengeBody,
  challengeResponse,
  chatActionClass,
  chatActionSchema,
  chatEventSchema,
  chatGrantListItemSchema,
  chatGrantListResponse,
  chatGrantSchema,
  chatMessage,
  chatProjectItem,
  chatProjectsResponse,
  deviceActivateBody,
  deviceActivateResponse,
  deviceInfo,
  deviceRequestBody,
  deviceRequestResponse,
  devicePollResponse,
  deviceSelf,
  hostOptionsResponse,
  mobileBatchDecisionBody,
  mobileDecisionBody,
  mobileMessageBody,
  notificationRow,
  notificationsResponse,
  p256Jwk,
  pushTokenBody,
  sendAccepted,
  tabQuestionAnswerBody,
  tabQuestionSchema,
  tabQuestionScreenResponse,
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

/** Mirrors `ChatHostAccount` (web types.ts). */
const chatHostAccount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chosen'), id: z.string(), label: z.string() }),
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

/** `GET chat` and `POST chat/host`'s payload (P§6). */
export const chatResponse = z.object({
  conversation: chatConversationSchema,
  messages: z.array(chatMessageSchema),
  actions: z.array(chatActionSchema),
  grants: z.array(chatGrantSchema).default([]),
  tab_questions: z.array(tabQuestionSchema).default([]),
  tab_suggestions: z.array(tabSuggestionSchema).default([]),
  host: chatHostStateSchema,
});

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
export type TChatGrantListItem = z.infer<typeof chatGrantListItemSchema>;
export type TChatGrantListResponse = z.infer<typeof chatGrantListResponse>;
export type TTabQuestion = z.infer<typeof tabQuestionSchema>;
export type TTabQuestionAnswerBody = z.infer<typeof tabQuestionAnswerBody>;
export type TTabQuestionScreenResponse = z.infer<typeof tabQuestionScreenResponse>;
export type TTabSuggestion = z.infer<typeof tabSuggestionSchema>;
export type TTabSuggestionSendBody = z.infer<typeof tabSuggestionSendBody>;
export type TChatConversation = z.infer<typeof chatConversationSchema>;
export type TChatResponse = z.infer<typeof chatResponse>;
export type TMeResponse = z.infer<typeof meResponse>;
export type TSetHostBody = z.infer<typeof setHostBody>;
export type TResetBody = z.infer<typeof resetBody>;
export type TErrorBody = z.infer<typeof errorBody>;
export type TEmptyResponse = z.infer<typeof emptyResponse>;
