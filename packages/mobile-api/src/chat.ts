import { z } from 'zod';
import { MAX_ATTACHMENTS_PER_MESSAGE } from './attachments.js';

/** `POST chat/messages`: text, or attachments, or both (spec 2026-09-26 §5.5). An empty text with ids
 * is a message made of files alone; neither is refused before anything is stored. */
export const mobileMessageBody = z
  .object({
    text: z.string().trim().max(8000).default(''),
    project_id: z.string().min(1).max(64).nullish(),
    attachment_ids: z.array(z.string().min(1).max(64)).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  })
  .refine((b) => b.text.length > 0 || (b.attachment_ids?.length ?? 0) > 0, { message: 'Escreva uma mensagem ou anexe um arquivo', path: ['text'] });
export const sendAccepted = z.object({ conversation_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string() });
const proof = { challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) };

export const mobileDecisionBody = z
  .discriminatedUnion('decision', [
    z.object({ decision: z.literal('deny') }),
    /** A `write` card approves with the session alone; an irreversible one needs the PIN proof (the server decides). */
    z.object({ decision: z.literal('approve'), challenge: proof.challenge.optional(), pin_proof: proof.pin_proof.optional() }),
    /** Approve *and* trust the tab for send_input in this conversation (24 h max). Always PIN-proven. */
    z.object({ decision: z.literal('approve_tab'), ...proof }),
  ])
  .refine((b) => b.decision !== 'approve' || (b.challenge === undefined) === (b.pin_proof === undefined), { message: 'challenge e pin_proof vão juntos' });

/** A grouped confirmation from the phone (spec 2026-09-26 §7). Each approval follows the single
 * decision's rule (TER-92): a `write` card approves with the session alone, an irreversible one
 * carries its own proof, bound to that action and the word `approve` (the server decides). There is
 * no `approve_tab` here: "Permitir sempre" is always a single, PIN-proven decision. */
export const mobileBatchDecisionBody = z.object({
  decisions: z
    .array(
      z.discriminatedUnion('decision', [
        z.object({ id: z.string().min(1).max(64), decision: z.literal('deny') }),
        z.object({ id: z.string().min(1).max(64), decision: z.literal('approve'), challenge: proof.challenge.optional(), pin_proof: proof.pin_proof.optional() }),
      ]),
    )
    .min(1)
    .max(20)
    .refine((d) => new Set(d.map((x) => x.id)).size === d.length, 'Ações repetidas')
    .refine((d) => d.every((x) => x.decision !== 'approve' || (x.challenge === undefined) === (x.pin_proof === undefined)), 'challenge e pin_proof vão juntos'),
});

/** Mirrors the server's `grantable` (apps/server/src/chat/gate.ts), which is the judge: only
 * `send_input` to a tab, never answering a permission. Decides whether the card offers the button. */
export function isTabGrantable(action: { tool: string; args: unknown; tab_id: string | null }): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return action.tool === 'send_input' && args.answering_permission !== true && Boolean(action.tab_id);
}

export const chatProjectItem = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  busy: z.boolean(),
  pending_confirmations: z.number().int(),
  last_message_at: z.string().nullable(),
});
export const chatProjectsResponse = z.object({ projects: z.array(chatProjectItem) });
export const hostOptionsResponse = z.object({
  machines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      online: z.boolean(),
      agent_version: z.string().nullable(),
      accounts: z.array(z.object({ id: z.string(), label: z.string(), config_dir: z.string().nullable() })),
    })
  ),
});

/** `POST chat/tab-questions/:id/answer`. The server checks it against the question itself (count,
 * options, one of picked/typed); this is the shape the app sends. No PIN (spec 2026-09-25 §2). */
export const tabQuestionAnswerBody = z.union([
  z.object({ answers: z.array(z.object({ selected: z.array(z.number().int().min(0).max(3)).max(4), text: z.string().max(2000).optional() })).min(1).max(4) }),
  z.object({ allow: z.boolean(), text: z.string().max(2000).optional() }),
]);
/** `GET chat/tab-questions/:id/screen`: the last lines of the tab, live, for a permission card. */
export const tabQuestionScreenResponse = z.object({ text: z.string() });

/** `POST chat/tab-suggestions/:id/send`: the text to type, as edited. The server is the judge of the rest
 * (one line, no control characters, no leading "!" or "/"). No PIN (spec 2026-09-25 tab suggestions §2). */
export const tabSuggestionSendBody = z.object({ text: z.string().trim().min(1).max(2000) });
