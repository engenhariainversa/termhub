import { z } from 'zod';

/** Mirrors `ChatMessage` in `apps/server/src/db/repositories/chat.ts`. */
export const chatMessage = z.object({
  id: z.string(),
  conversation_id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  usage: z.unknown().nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
});

/** Mirrors `ChatActionClass` in `apps/server/src/db/repositories/chat-actions.ts`. */
export const chatActionClass = z.enum(['read', 'write', 'irreversible']);

export const chatActionStatus = z.enum(['pending', 'approved', 'denied', 'expired', 'executed', 'failed']);

/** Mirrors the server's `ChatActionCard` (chat-actions-view.ts): a write the concierge proposed, with
 * the server-composed pt-BR `summary`. `grant_id` names the tab grant it ran under (optional: older
 * servers do not send it). */
export const chatActionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.unknown(),
  class: chatActionClass,
  status: chatActionStatus,
  machine_id: z.string().nullable(),
  project_id: z.string().nullable(),
  tab_id: z.string().nullable(),
  grant_id: z.string().nullable().optional(),
  summary: z.string(),
  created_at: z.string(),
});

/** "Permitir sempre nesta aba" while it holds (server `ChatGrantView`). */
export const chatGrantSchema = z.object({
  id: z.string(),
  tab_id: z.string(),
  tool: z.string(),
  source_action_id: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  tab_name: z.string().nullable(),
});

// Mirrors the `ChatEvent` union in `apps/server/src/chat/bus.ts`, plus the `hello` variant the
// mobile socket sends first (there is no browser-side equivalent: the app has no other way to
// learn the protocol version and the server's clock before its first real event).
export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int(), server_time: z.string() }),
  z.object({ type: z.literal('message'), user_id: z.string(), conversation_id: z.string(), message: chatMessage }),
  z.object({ type: z.literal('delta'), user_id: z.string(), conversation_id: z.string(), message_id: z.string(), delta: z.string() }),
  z.object({ type: z.literal('action'), user_id: z.string(), conversation_id: z.string(), message_id: z.string(), tool: z.string(), tool_use_id: z.string(), args: z.unknown() }),
  z.object({ type: z.literal('action_result'), user_id: z.string(), conversation_id: z.string(), message_id: z.string(), tool_use_id: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal('reset'), user_id: z.string(), conversation_id: z.string(), message_id: z.string() }),
  z.object({
    type: z.literal('confirmation'),
    user_id: z.string(),
    conversation_id: z.string(),
    action_id: z.string(),
    tool: z.string(),
    args: z.unknown(),
    class: chatActionClass,
    machine_id: z.string().nullable(),
    project_id: z.string().nullable(),
    tab_id: z.string().nullable(),
    summary: z.string(),
    created_at: z.string(),
  }),
  z.object({ type: z.literal('decision'), user_id: z.string(), conversation_id: z.string(), action_id: z.string(), status: z.enum(['approved', 'denied']) }),
  z.object({ type: z.literal('grant'), user_id: z.string(), conversation_id: z.string(), grant: chatGrantSchema }),
  z.object({ type: z.literal('grant_revoked'), user_id: z.string(), conversation_id: z.string(), grant_id: z.string() }),
  z.object({ type: z.literal('granted_action'), user_id: z.string(), conversation_id: z.string(), action: chatActionSchema }),
  z.object({
    type: z.literal('run_finished'),
    user_id: z.string(),
    conversation_id: z.string(),
    message_id: z.string().nullable(),
    ok: z.boolean(),
    error_code: z.string().nullable(),
  }),
]);
