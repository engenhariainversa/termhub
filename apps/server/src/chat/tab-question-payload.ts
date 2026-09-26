import { z } from 'zod';

/**
 * A question a tab puts to the person (spec 2026-09-25 §4.2, §5.4): Claude Code's `AskUserQuestion`
 * input, parsed and normalised, and the bodies the chat answers it with. The input reaches the server
 * whole (it is text written to be shown to the person) but only from a machine's hook token, so every
 * field is capped here and anything off-shape drops the question — the tab falls back to the text flow.
 */
export const QUESTION_MAX = 1000;
export const HEADER_MAX = 100;
export const LABEL_MAX = 200;
export const DESCRIPTION_MAX = 1000;
export const ANSWER_TEXT_MAX = 2000;

const rawOption = z.object({ label: z.string().trim().min(1).max(LABEL_MAX), description: z.string().max(DESCRIPTION_MAX).optional() });
const rawQuestion = z.object({
  question: z.string().trim().min(1).max(QUESTION_MAX),
  header: z.string().max(HEADER_MAX).optional(),
  // Claude Code asks with 2 to 4 options; its own "Type something." and "Chat about this" rows are not options.
  options: z.array(rawOption).min(2).max(4),
  multiSelect: z.boolean().optional(),
});
const rawInput = z.object({ questions: z.array(rawQuestion).min(1).max(4) });

export interface TabQuestionOption {
  label: string;
  description: string;
  /** Claude Code marks the recommended option in its label: "Blue (Recommended)". */
  recommended: boolean;
}
export interface TabQuestionItem {
  question: string;
  header: string;
  multi_select: boolean;
  options: TabQuestionOption[];
}
export interface ChoicePayload {
  questions: TabQuestionItem[];
}
/** A permission prompt: the tool's name only, never its input (spec §4.1). */
export interface PermissionPayload {
  tool_name: string;
}
/** Claude Code's dimmed next prompt, read off the tab's screen (spec 2026-09-25 tab suggestions §6.1). */
export interface SuggestionPayload {
  text: string;
}
/** What the person sent for it, as edited. */
export interface SuggestionAnswer {
  text: string;
}
export type TabQuestionKind = 'choice' | 'permission';
/** Every kind a `tab_questions` row holds: a question the tab asked, or a suggestion it shows. */
export type TabRowKind = TabQuestionKind | 'suggestion';
/** What the interpretation of a hook event hands the tab-question service. */
export type TabQuestionInput =
  | { kind: 'choice'; payload: ChoicePayload; tool_use_id: string | null }
  | { kind: 'permission'; payload: PermissionPayload; tool_use_id: null };

const RECOMMENDED = /\s*\(Recommended\)\s*$/i;

/** "Blue (Recommended)" → `{ label: "Blue", recommended: true }`. A label that is only the marker stays as it is. */
export function normaliseLabel(label: string): { label: string; recommended: boolean } {
  const trimmed = label.trim();
  const stripped = trimmed.replace(RECOMMENDED, '').trim();
  return stripped && stripped !== trimmed ? { label: stripped, recommended: true } : { label: trimmed, recommended: false };
}

export function parseAskUserQuestion(toolInput: unknown): ChoicePayload | null {
  const r = rawInput.safeParse(toolInput);
  if (!r.success) return null;
  return {
    questions: r.data.questions.map((q) => ({
      question: q.question,
      header: (q.header ?? '').trim(),
      multi_select: q.multiSelect ?? false,
      options: q.options.map((o) => ({ ...normaliseLabel(o.label), description: (o.description ?? '').trim() })),
    })),
  };
}

/** The characters the hook script lets through for a tool name (`[A-Za-z0-9_.-]`), checked again here. */
const TOOL_NAME = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const TOOL_USE_ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export function parsePermissionTool(name: unknown): PermissionPayload | null {
  const r = TOOL_NAME.safeParse(name);
  return r.success ? { tool_name: r.data } : null;
}

export function toolUseIdOf(v: unknown): string | null {
  const r = TOOL_USE_ID.safeParse(v);
  return r.success ? r.data : null;
}

/**
 * C0 controls, DEL and C1 controls (spec 2026-09-26 §5.1). Typed into a tab, each is a key, not text
 * (0x9b is an 8-bit CSI); shown, each can move the cursor or recolour what follows. Refused in what the
 * chat types (`answerText`) and stripped from what it shows, wherever the rule is the same. Not global:
 * `test` on it keeps no state — use `globalOf` for a `replace`.
 */
export const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/;
/**
 * Bidi and invisible format controls: ALM (U+061C), ZWSP…RLM (U+200B–U+200F), LRE…RLO (U+202A–U+202E),
 * WJ…PDI (U+2060–U+2069) and the BOM (U+FEFF). They reorder or hide text without showing themselves.
 */
export const FORMAT_CHARS_RE = /[؜​-‏‪-‮⁠-⁩﻿]/;
/** The same character class, matching every occurrence (for `replace`). */
export const globalOf = (re: RegExp): RegExp => new RegExp(re.source, 'g');

/** The first `max` UTF-16 units of `text`, never ending on the first half of a surrogate pair (spec §5.3). */
export function sliceUnits(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Text typed into the tab as an answer: one line, no control characters (C0, DEL or C1). A newline
 * would be read as Enter halfway through the answer, and any other control byte is a key, not text (the
 * same reasoning as `CONTROL_CHARS` in control/agents.ts, stricter: not even a newline).
 */
export const answerText = z
  .string()
  .trim()
  .min(1)
  .max(ANSWER_TEXT_MAX)
  .refine((t) => !CONTROL_CHARS_RE.test(t), 'sem caracteres de controle nem quebras de linha');

/**
 * `answerText` that may land at Claude Code's prompt, where a leading "!" runs the rest in bash and a
 * leading "/" runs a slash command (`/exit`, `/clear`…): a permission's deny text (Claude is back at its
 * prompt after a rejection), a suggestion's text, and — defence in depth, since it is typed into the
 * dialog's own field — a choice's free text (spec 2026-09-26 §4.4). Checked after the trim.
 */
export const typedText = answerText
  .refine((t) => !t.startsWith('!'), 'o texto não pode começar com "!"')
  .refine((t) => !t.startsWith('/'), 'o texto não pode começar com "/"');

export const choiceAnswerBody = z.object({
  answers: z
    .array(z.object({ selected: z.array(z.number().int().min(0).max(3)).max(4).default([]), text: typedText.optional() }))
    .min(1)
    .max(4),
});
export type ChoiceAnswer = z.infer<typeof choiceAnswerBody>;

export const permissionAnswerBody = z
  .object({ allow: z.boolean(), text: typedText.optional() })
  .refine((a) => !(a.allow && a.text !== undefined), { message: 'texto só acompanha uma negação', path: ['text'] });
export type PermissionAnswer = z.infer<typeof permissionAnswerBody>;

export type ChoiceAnswerProblem = 'ANSWER_COUNT' | 'ANSWER_OPTION' | 'ANSWER_SHAPE';

/** The part of a choice answer zod cannot see without the question: one entry per question, options
 * that exist, and exactly one of "picked" or "typed" (one option at most on a single-select). */
export function checkChoiceAnswer(payload: ChoicePayload, answer: ChoiceAnswer): ChoiceAnswerProblem | null {
  if (answer.answers.length !== payload.questions.length) return 'ANSWER_COUNT';
  for (const [i, a] of answer.answers.entries()) {
    const q = payload.questions[i]!;
    if (a.selected.some((s) => s >= q.options.length) || new Set(a.selected).size !== a.selected.length) return 'ANSWER_OPTION';
    const picked = a.selected.length > 0;
    const typed = a.text !== undefined;
    if (picked === typed) return 'ANSWER_SHAPE';
    if (!q.multi_select && a.selected.length > 1) return 'ANSWER_SHAPE';
  }
  return null;
}
