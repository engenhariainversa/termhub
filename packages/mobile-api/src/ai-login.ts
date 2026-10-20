import { z } from 'zod';

/**
 * Redoing an AI CLI login from the app (TER-1047): the same bodies as the web's `/api/ai-accounts/...`.
 *
 * - `GET  /api/m/v1/ai-accounts/login-status[?refresh=1]` → `aiLoginStatusResponse`
 * - `POST /api/m/v1/ai-accounts/:id/login` → `aiLoginStartResponse`
 * - `POST /api/m/v1/ai-accounts/:id/login/:loginId/submit` (`aiLoginSubmitBody`) → `aiLoginSubmitResponse`
 * - `DELETE /api/m/v1/ai-accounts/:id/login/:loginId` → `{ cancelled: true }`
 * - `POST /api/m/v1/ai-accounts/:id/login/resume` (`aiLoginResumeBody`) → `aiLoginResumeResponse`
 *
 * Read loosely (`z.string()` for provider and state) so a value a newer server adds never breaks the app.
 */

export const AI_LOGIN_STATES = ['ok', 'login_required', 'unknown'] as const;
export type AiLoginState = (typeof AI_LOGIN_STATES)[number];

export const aiLoginStatusQuery = z.object({ refresh: z.coerce.boolean().optional() });

export const aiLoginStatusRow = z.object({
  account_id: z.string(),
  label: z.string(),
  provider: z.string(),
  machine_id: z.string(),
  machine_name: z.string().nullable(),
  /** `login_required`: show the red warning; `unknown`: never checked (or the machine cannot tell) */
  state: z.string(),
  checked_at: z.string().nullable(),
  /** the "Refazer login" button works here: an online agent with `ai_login`, a Claude or Codex account */
  supported: z.boolean(),
});
export type AiLoginStatusRow = z.infer<typeof aiLoginStatusRow>;

export const aiLoginStatusResponse = z.object({ accounts: z.array(aiLoginStatusRow) });
export type AiLoginStatusResponse = z.infer<typeof aiLoginStatusResponse>;


/** The code the login page showed (Claude); null or absent for Codex, which needs none, and for a Claude login finished in the machine's own browser. */
export const aiLoginSubmitBody = z.object({ code: z.string().trim().min(1).max(2000).nullable().optional() });
export type AiLoginSubmitBody = z.infer<typeof aiLoginSubmitBody>;

export const aiLoginStuckTab = z.object({ id: z.string(), name: z.string(), project_id: z.string() });
export type AiLoginStuckTab = z.infer<typeof aiLoginStuckTab>;

export const aiLoginStartResponse = z.object({
  login_id: z.string(),
  /** the page to open in a browser; null when `logged_in` */
  url: z.string().nullable(),
  /** Codex's one-time device code to type on that page; null for Claude */
  user_code: z.string().nullable(),
  /** true (Claude): paste the code the page shows back; false (Codex): just confirm once authorized */
  needs_code: z.boolean(),
  expires_at: z.string(),
  /**
   * The CLI already finished the login on the machine (its own browser took it, TER-1054): nothing to open,
   * the login is done and `stuck_tabs` lists the tabs to offer to resume. Absent from an older server.
   */
  logged_in: z.boolean().default(false),
  stuck_tabs: z.array(aiLoginStuckTab).default([]),
});
export type AiLoginStartResponse = z.infer<typeof aiLoginStartResponse>;

export const aiLoginSubmitResponse = z.object({
  ok: z.boolean(),
  /** why it did not finish; never the code */
  message: z.string().nullable(),
  /** after a successful login: tabs of the account still showing the login error ("Retomar N abas?") */
  stuck_tabs: z.array(aiLoginStuckTab),
});
export type AiLoginSubmitResponse = z.infer<typeof aiLoginSubmitResponse>;

export const AI_LOGIN_RESUME_MAX = 50;
export const aiLoginResumeBody = z.object({ tab_ids: z.array(z.string().min(1).max(64)).max(AI_LOGIN_RESUME_MAX) });
export type AiLoginResumeBody = z.infer<typeof aiLoginResumeBody>;

export const aiLoginResumeResponse = z.object({ resumed: z.array(z.string()) });
export type AiLoginResumeResponse = z.infer<typeof aiLoginResumeResponse>;

export const aiLoginCancelResponse = z.object({ cancelled: z.literal(true) });
