import { z } from 'zod';

export const notificationRow = z.object({
  id: z.string(),
  kind: z.enum(['confirmation', 'reply', 'device_request']),
  title: z.string(),
  body: z.string(),
  data: z.record(z.unknown()),
  created_at: z.string(),
  read_at: z.string().nullable(),
});
export const notificationsResponse = z.object({ notifications: z.array(notificationRow), unread: z.number().int(), next_before: z.string().nullable() });

/** Which real push a test push imitates (TER-913): the same text and `data`, with "[Teste] " in front. */
export const pushTestKind = z.enum(['confirmation', 'tab_question', 'reply', 'device_request']);
export type PushTestKind = z.infer<typeof pushTestKind>;

/** `POST /api/m/v1/push-test` (the calling device) and `POST /api/devices/:id/test-push` (web). */
export const pushTestBody = z.object({
  kind: pushTestKind.default('confirmation'),
  /** Time to close the app or lock the phone before it is sent. */
  delay_seconds: z.number().int().min(0).max(120).default(0),
});
export type PushTestBody = z.input<typeof pushTestBody>;

/** 202: `ticket` is Expo's answer for an immediate send, `null` when delayed (the outcome comes later
 * as the device's `push_test` event). */
export const pushTestResponse = z.object({
  scheduled_for: z.string(),
  ticket: z.union([z.object({ status: z.literal('ok') }), z.object({ status: z.literal('error'), error: z.string() })]).nullable(),
});
export type PushTestResponse = z.infer<typeof pushTestResponse>;
