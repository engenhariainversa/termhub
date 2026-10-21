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

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * The concierge's notices outside the chat (TER-1101): which levels become a push (`needs_you`: it needs the
 * person; `done`: something they asked to follow happened — "só para saber" never pushes), quiet hours on
 * the person's clock (both set or both null) and the grouping window (several notices within it leave as
 * one push; 0 = off). The same rules hold for the phone and the browser.
 */
export const conciergePushSettings = z
  .object({
    needs_you: z.boolean(),
    done: z.boolean(),
    quiet_start: hhmm.nullable(),
    quiet_end: hhmm.nullable(),
    group_minutes: z.number().int().min(0).max(60),
  })
  .refine((s) => (s.quiet_start === null) === (s.quiet_end === null), { message: 'quiet_start and quiet_end go together', path: ['quiet_end'] });
export type ConciergePushSettings = z.infer<typeof conciergePushSettings>;

/** `GET` / `PUT /api/m/v1/push-settings`: the person's opt-in pushes (TER-925). */
export const pushSettings = z.object({
  /** "Avisar quando uma aba terminar": a push when a project tab finishes its turn. Off by default. */
  tab_finished: z.boolean(),
  /** TER-1101: the concierge's notices. Always in a newer server's answer; left out of a PUT, kept as they were
   *  (an older app only sends `tab_finished`). */
  concierge: conciergePushSettings.optional(),
  /** The phone's IANA zone, sent with `concierge` so the quiet hours are read on the person's clock. */
  time_zone: z.string().min(1).max(64).optional(),
});
export type PushSettings = z.infer<typeof pushSettings>;
