import { z } from 'zod';

/**
 * The project's AI accounts and default models (TER-589): `GET/PUT /api/m/v1/projects/:id/setup/ai`,
 * the same bodies as the web's `/api/projects/:id/setup/ai`. `accounts` are ids in priority order.
 * Kept loose on read (`z.string()` models) so a server that learns a new model format never breaks the app;
 * the server validates what it saves.
 */
export const projectAiSchema = z.object({
  accounts: z.array(z.string()),
  models: z.object({ claude: z.string().nullable(), chatgpt: z.string().nullable() }),
});
export type ProjectAi = z.infer<typeof projectAiSchema>;

export const projectAiOption = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.enum(['claude', 'chatgpt']),
  machine_id: z.string(),
  machine_name: z.string(),
  default: z.boolean(),
});
export type ProjectAiOption = z.infer<typeof projectAiOption>;

export const projectAiResponse = z.object({ ai: projectAiSchema, available: z.array(projectAiOption) });
export type ProjectAiResponse = z.infer<typeof projectAiResponse>;

export const projectAiBody = z.object({ ai: projectAiSchema });

// The Claude aliases the screens offer (`CLAUDE_MODEL_ALIASES`) and the model rule live in `models.ts`.

/**
 * A usage-limit card in a project's chat (TER-589): a tab stuck on its account's limit on a machine that
 * does not swap by itself. `GET chat` carries them in `tab_limits`; the events are `tab_limit` and
 * `tab_limit_closed`. Kept apart from `tabQuestionSchema` so an app that predates it keeps parsing.
 */
export const tabLimitSchema = z.object({
  id: z.string(),
  tab_id: z.string(),
  tab_name: z.string().nullable(),
  payload: z.object({
    account: z.object({ id: z.string(), label: z.string() }).nullable(),
    machine: z.object({ id: z.string(), name: z.string() }),
    resets_at: z.string().nullable(),
    candidates: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
  status: z.enum(['open', 'swapped', 'dismissed', 'expired', 'failed']),
  result: z.string().nullable(),
  created_at: z.string(),
  closed_at: z.string().nullable(),
});
export type TabLimit = z.infer<typeof tabLimitSchema>;

/** `POST chat/tab-limits/:id/answer`: the account to swap to, or null ("Esperar"). */
export const tabLimitAnswerBody = z.object({ account_id: z.string().min(1).max(64).nullable() });
export const tabLimitAnswerResponse = z.object({ tab_limit: tabLimitSchema });
