import { z } from 'zod';
import { MAX_ATTACHMENTS_PER_MESSAGE } from './attachments.js';
import { replyCardRef, tabQuestionSchema, type ReplyCardKind, type StandingGrantKind, type TAutoDecision } from './events.js';

/** `POST chat/messages`: text, or attachments, or both (spec 2026-09-26 §5.5). An empty text with ids
 * is a message made of files alone; neither is refused before anything is stored. */
export const mobileMessageBody = z
  .object({
    text: z.string().trim().max(8000).default(''),
    project_id: z.string().min(1).max(64).nullish(),
    attachment_ids: z.array(z.string().min(1).max(64)).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    /** The message this one answers (TER-447). */
    reply_to_id: z.string().min(1).max(64).optional(),
    /** Or the card it answers (TER-849): never both. */
    reply_to_card: replyCardRef.extend({ id: z.string().min(1).max(64) }).optional(),
  })
  .refine((b) => b.text.length > 0 || (b.attachment_ids?.length ?? 0) > 0, { message: 'Escreva uma mensagem ou anexe um arquivo', path: ['text'] })
  .refine((b) => b.reply_to_id === undefined || b.reply_to_card === undefined, { message: 'Responda a uma mensagem ou a um card, não aos dois', path: ['reply_to_card'] });
/** How much of a quoted message a reply keeps and shows (TER-447). */
export const REPLY_EXCERPT_MAX = 200;

const cutExcerpt = (s: string): string => {
  const chars = [...s];
  return chars.length > REPLY_EXCERPT_MAX ? `${chars.slice(0, REPLY_EXCERPT_MAX).join('').trimEnd()}…` : s;
};

/**
 * What a quote shows of the message it answers (TER-447): plain text on one line. An answer is
 * markdown, so fence lines, leading `#` and `>`, `*`, backticks and link targets go. Underscores stay:
 * here they are far more often part of an identifier than emphasis. A message of files alone is named
 * by them. The server cuts the stored snapshot with this; the clients cut their previews with it.
 */
export function replyExcerpt(text: string, attachmentNames: readonly string[] = []): string {
  const plain = text
    .replace(/^[ \t]*```.*$/gm, ' ')
    .replace(/^[ \t]*(?:#{1,6}|>)[ \t]*/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain) return cutExcerpt(plain);
  const names = attachmentNames.join(', ').replace(/\s+/g, ' ').trim();
  return names ? cutExcerpt(`📎 ${names}`) : '';
}

/** What a quote of a card is labelled with, where a message's quote shows its author (TER-849). */
export const REPLY_CARD_LABEL: Record<ReplyCardKind, string> = { action: 'Confirmação', tab_question: 'Pergunta da aba' };

/** The words a tab question card asks, quoted by a reply to it (TER-849): every question of a choice
 * card, or what a permission card asks for. Cut like any quote with `replyExcerpt`. */
export function tabQuestionReplyText(
  q: { kind: 'choice'; payload: { questions: readonly { question: string }[] } } | { kind: 'permission'; payload: { tool_name: string; question?: string } },
): string {
  if (q.kind === 'choice') return q.payload.questions.map((item) => item.question.trim()).filter(Boolean).join(' · ');
  return q.payload.question?.trim() || `Permissão para usar ${q.payload.tool_name}`;
}

export const sendAccepted = z.object({ conversation_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string() });
const proof = { challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) };

export const mobileDecisionBody = z
  .discriminatedUnion('decision', [
    z.object({ decision: z.literal('deny') }),
    /** A `write` card approves with the session alone; an irreversible one needs the PIN proof (the server decides). */
    z.object({ decision: z.literal('approve'), challenge: proof.challenge.optional(), pin_proof: proof.pin_proof.optional() }),
    /** Approve *and* trust the tab for send_input in this conversation (24 h max). Always PIN-proven. */
    z.object({ decision: z.literal('approve_tab'), ...proof }),
    /** Approve *and* trust the project's board in this conversation (24 h max). Always PIN-proven. */
    z.object({ decision: z.literal('approve_project'), ...proof }),
    /** Approve *and* trust the tab for send_key and send_input in this conversation (24 h max, spec
     * 2026-09-27 TER-325). Always PIN-proven. */
    z.object({ decision: z.literal('approve_tab_terminal'), ...proof }),
    /** Approve *and* trust the project's board and its tabs' keys and typing in this conversation (24 h
     * max, spec 2026-09-27 TER-325). Always PIN-proven. */
    z.object({ decision: z.literal('approve_project_all'), ...proof }),
    /** Approve *and* trust this kind of routine action in the card's project with no expiry ("Liberar
     * sem prazo", spec 2026-09-28 TER-386), until revoked. Always PIN-proven. */
    z.object({ decision: z.literal('approve_project_always'), ...proof }),
  ])
  .refine((b) => b.decision !== 'approve' || (b.challenge === undefined) === (b.pin_proof === undefined), { message: 'challenge e pin_proof vão juntos' });

/** A grouped confirmation from the phone (spec 2026-09-26 §7). Each approval follows the single
 * decision's rule (TER-92): a `write` card approves with the session alone, an irreversible one
 * carries its own proof, bound to that action and the word `approve` (the server decides). There is
 * no `approve_tab`, `approve_project`, `approve_tab_terminal`, `approve_project_all` nor
 * `approve_project_always` here: "Permitir sempre" and "Liberar" are always a single, PIN-proven decision. */
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

/** Mirrors the server's `terminalGrantable` (apps/server/src/chat/gate.ts), which is the judge:
 * `send_input` or `send_key` to a tab, never answering a permission. Decides whether the card offers
 * "Liberar teclas e shell nesta aba" (spec 2026-09-27 TER-325). */
export function isTerminalGrantable(action: { tool: string; args: unknown; tab_id: string | null }): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return (action.tool === 'send_input' || action.tool === 'send_key') && args.answering_permission !== true && Boolean(action.tab_id);
}

/** Mirrors the server's `BOARD_GRANT_TOOLS` (apps/server/src/chat/gate.ts); the server is the judge
 * and refuses a card whose project does not resolve. */
export const BOARD_GRANT_TOOLS = ['create_task', 'add_subtasks', 'update_task', 'move_task'] as const;
export const isBoardGrantable = (action: { tool: string }): boolean => (BOARD_GRANT_TOOLS as readonly string[]).includes(action.tool);

/** How "Liberar sem prazo: <ação> neste projeto" names each kind (spec 2026-09-28 TER-386 §6). */
export const STANDING_KIND_LABEL: Record<StandingGrantKind, string> = {
  open_tab: 'abrir abas',
  close_tab: 'fechar abas paradas',
  start_agent: 'iniciar agentes',
  board: 'mexer no quadro',
  terminal: 'teclas e texto nas abas',
};

/** Mirrors the server's `standingKindOf` (apps/server/src/chat/gate.ts), which is the judge and also
 * refuses a card whose project (or tab) does not resolve: which standing grant kind the card may offer
 * "Liberar sem prazo" for, or null. Read from the card's own `project_id`/`tab_id`. */
export function standingKindOf(action: { tool: string; args: unknown; tab_id: string | null; project_id: string | null }): StandingGrantKind | null {
  if (action.tool === 'open_tab' || action.tool === 'start_agent') return action.project_id ? action.tool : null;
  if (action.tool === 'close_tab') return action.tab_id ? 'close_tab' : null;
  if (isBoardGrantable(action)) return 'board';
  if (isTerminalGrantable(action)) return 'terminal';
  return null;
}

export const chatProjectItem = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  busy: z.boolean(),
  pending_confirmations: z.number().int(),
  last_message_at: z.string().nullable(),
  /** 0-based place in the person's Favoritos (the web sidebar's group), or null when the project is
   * not pinned. Defaults to null so an app newer than its server shows no pins instead of failing. */
  favorite_position: z.number().int().nullable().default(null),
});
export const chatProjectsResponse = z.object({ projects: z.array(chatProjectItem) });
/** `PUT chat/projects/:id/favorite`: the wanted end state, so a repeat is harmless. */
export const projectFavoriteBody = z.object({ favorite: z.boolean() });
export type TProjectFavoriteBody = z.infer<typeof projectFavoriteBody>;
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
/** `POST chat/tab-questions/:id/auto-answer/cancel` (no body): "Cancelar" on a countdown (spec 2026-09-26
 * concierge memory §6). Answers the card, `auto_answer.status: 'cancelled'`, the proposed answer kept as
 * the pre-selection; 404 for a card not the user's, 409 `NOT_SCHEDULED` when no countdown runs. "Responder
 * agora" is the ordinary answer route, which cancels the countdown itself. */
export const tabQuestionAutoAnswerCancelResponse = z.object({ tab_question: tabQuestionSchema });
/** `GET chat/tab-questions/:id/screen`: the last lines of the tab, live, for a permission card. */
export const tabQuestionScreenResponse = z.object({ text: z.string() });

/** `POST chat/tab-suggestions/:id/send`: the text to type, as edited. The server is the judge of the rest
 * (one line, no control characters, no leading "!" or "/"). No PIN (spec 2026-09-25 tab suggestions §2). */
export const tabSuggestionSendBody = z.object({ text: z.string().trim().min(1).max(2000) });

/** "Memória do chat" (spec 2026-09-26 §4.6): the shape of one remembered decision, as the list and
 * (eventually) other screens show it — never the embedding, the owning user, the conversation or the
 * tab question it came from. */
export const decisionOptionView = z.object({ label: z.string(), description: z.string() });
export const decisionAnswerView = z.object({ labels: z.array(z.string()), text: z.string().optional() });
export const decisionViewSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  header: z.string(),
  question: z.string(),
  options: z.array(decisionOptionView),
  multi_select: z.boolean(),
  answer: decisionAnswerView,
  suggested_count: z.number().int(),
  accepted_count: z.number().int(),
  created_at: z.string(),
});
/** `GET chat/decisions`: newest first, 50 per page, with a keyset `next_cursor` (opaque, `null` on the
 * last page). */
export const decisionsResponse = z.object({ decisions: z.array(decisionViewSchema), next_cursor: z.string().nullable() });

/** `GET`/`PATCH chat/memory`: the suggestion switch, "Responder sozinho quando houver precedente"
 * (spec D8), whether embeddings are configured on this server at all (`available: false` hides both
 * switches rather than offering ones that can never do anything), how many decisions are remembered,
 * and how many concierge notes (spec D12) are. */
export const chatMemoryResponse = z.object({ enabled: z.boolean(), autodecide: z.boolean(), codex_replies: z.boolean().default(false), available: z.boolean(), count: z.number().int(), notes: z.number().int() });
/** At least one of the switches, never none — an empty body is refused rather than a silent no-op.
 * `codex_replies` is "Responder perguntas do Codex pelo chat" (off by default). */
export const chatMemoryPatchBody = z
  .object({ enabled: z.boolean().optional(), autodecide: z.boolean().optional(), codex_replies: z.boolean().optional() })
  .refine((b) => b.enabled !== undefined || b.autodecide !== undefined || b.codex_replies !== undefined, { message: 'Informe enabled, autodecide ou codex_replies' });

/** "Anotações do concierge" (spec D12/§8): one `record_decision` note, as the list shows it —
 * `question` is the note's title; `decision`/`reason` are parsed back out of the stored text's
 * `Decisão:`/`Motivo:` lines server-side (never the embedding, the owning user or the raw text). */
export const conciergeNoteView = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  question: z.string(),
  decision: z.string(),
  reason: z.string(),
  created_at: z.string(),
});
/** `GET chat/notes`: newest first, 50 per page, with a keyset `next_cursor` (opaque, `null` on the
 * last page) — the same pagination shape as `decisionsResponse`. */
export const notesResponse = z.object({ notes: z.array(conciergeNoteView), next_cursor: z.string().nullable() });

/** "Lições" (spec 2026-09-27 failure lessons §6/§8): one `lesson` item (chunk 0), as the "Lições" list
 * (and the verify/unverify routes, which answer the same shape) show it — never the embedding, the
 * owning user, `source_id` or the raw `meta`. `project` is `null` for an orphaned project; `path`,
 * `tab_id`, `card` and `pr` are `null` when the lesson (or its origin) has none. */
export const lessonItemSchema = z.object({
  id: z.string(),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  title: z.string(),
  excerpt: z.string(),
  origin: z.enum(['file', 'note']),
  path: z.string().nullable(),
  tab_id: z.string().nullable(),
  card: z.string().nullable(),
  pr: z.string().nullable(),
  evidence: z.enum(['observed', 'fixed', 'confirmed']),
  verified: z.boolean(),
  verified_at: z.string().nullable(),
  created_at: z.string(),
});
/** `GET chat/lessons`: newest `source_at` first, with a keyset `next_cursor` — the same pagination
 * shape as `decisionsResponse`/`notesResponse`. */
export const lessonListSchema = z.object({ lessons: z.array(lessonItemSchema), next_cursor: z.string().nullable() });
/** `DELETE chat/lessons/:id` ("Esquecer"): `note` is present only for a file lesson, saying the file
 * itself stays in the repository until a PR removes it. */
export const lessonForgetSchema = z.object({ ok: z.literal(true), note: z.string().optional() });

/** "Decisão automática" (TER-641) on an action card: the precedent a send cited, but only when the call
 * also ran without a click (`grant_id`, a default allowance or a grant). A pending card, or one the person
 * approved by hand, is never an automatic decision. Null otherwise — and on an older server (absent). */
export function actionAutoDecision(action: { status: string; grant_id?: string | null; auto_decision?: TAutoDecision | null }): TAutoDecision | null {
  if (!action.auto_decision || !action.grant_id || action.status === 'pending') return null;
  return action.auto_decision;
}

/** One cited ref as the badge's detail reads it: the recorded question and answer when it is a decision
 * of the person's, else the bare ref (a card, a note… or a decision forgotten since). */
export function autoDecisionSourceLine(source: TAutoDecision['sources'][number]): string {
  if (source.question === null) return source.ref;
  return source.answer ? `«${source.question}» → ${source.answer}` : `«${source.question}»`;
}
