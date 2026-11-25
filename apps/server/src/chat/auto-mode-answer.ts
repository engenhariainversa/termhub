/**
 * The runtime half of TER-1210 (`auto-mode-permission.ts` is the pure one): a permission card of a manual
 * tab whose Claude Code shows its auto mode dialog is answered "Yes" by the server, for a person on
 * "liberado por padrão" (`chat_open_permissions`, per person, opt-in), unless the command hits the hard lock
 * or one of their blocks. Anything else leaves the card to the person, exactly as before.
 *
 * The answer goes through the chat's ordinary answer path (`answerTabQuestion`) as the card's owner, with
 * `via: 'auto_mode'`: every check of a click (the tab in scope, the card still the open one, the dialog on
 * the live screen, the claim), the dialog's tool identified on that same read, and `autoModeVerdict` run
 * again on that very read, so what is approved is what was judged. Logs ids and reason codes only, never
 * the command (CLAUDE.md: terminal content is never logged).
 */
import type { FastifyBaseLogger } from 'fastify';
import { controlContextFor } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { autoModeVerdict } from './auto-mode-permission.js';
import { effectiveBlocks, openPermissionsOn } from './blocks.js';
import { failureLabel } from './service.js';
import { answerTabQuestion } from './tab-question-answer.js';
import type { PermissionPayload } from './tab-question-payload.js';

/** Let the dialog finish drawing before it is read (the hook fires as it opens). */
export const AUTO_MODE_SETTLE_MS = 2_000;
/** Automatic answers per person and rolling hour: a brake against a runaway loop, not a quota. Past it the card is the person's. */
export const AUTO_MODE_ANSWERS_PER_HOUR = 60;
const HOUR_MS = 60 * 60_000;

const answered = new Map<string, number[]>();

function underCap(userId: string, now: number): boolean {
  const recent = (answered.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
  answered.set(userId, recent);
  return recent.length < AUTO_MODE_ANSWERS_PER_HOUR;
}

/** Tests. */
export function resetAutoModeAnswers(): void {
  answered.clear();
}

/** `allowed`: sent. `left`: the card is the person's (off, blocked, refused, not this dialog, or a send that failed). */
export type AutoModeOutcome = 'allowed' | 'left';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface AutoModeDeps {
  repos: Repositories;
  log: Log;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  sendAnswer?: typeof answerTabQuestion;
}

/**
 * A fresh permission card of a tab with no automatic run (the caller checked). Claude's only: a Codex card
 * (`agent: 'codex'`) has no auto mode dialog, and its screen never matches.
 */
export async function answerAutoModePermission(deps: AutoModeDeps, q: TabQuestion): Promise<AutoModeOutcome> {
  const { repos, log } = deps;
  if (q.kind !== 'permission' || q.status !== 'open') return 'left';
  const payload = q.payload as Partial<PermissionPayload> | null;
  if (payload?.tool_name !== 'Bash' || payload.agent === 'codex') return 'left';
  if (!(await openPermissionsOn(repos, q.user_id))) return 'left';
  const user = await repos.users.findById(q.user_id);
  if (!user) return 'left';
  const blocks = await effectiveBlocks(repos, q.user_id);

  await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(AUTO_MODE_SETTLE_MS);
  const now = (deps.now ?? Date.now)();
  if (!underCap(q.user_id, now)) {
    log.info({ tabQuestionId: q.id, tabId: q.tab_id }, 'auto mode permission: hourly cap reached');
    return 'left';
  }

  let reason: string | null = null;
  try {
    await (deps.sendAnswer ?? answerTabQuestion)(controlContextFor(repos, user), q.id, { allow: true }, {
      log: log as never,
      embedder: null,
      via: 'auto_mode',
      screenCheck: (screen) => {
        reason = autoModeVerdict(screen, blocks, q.project_id);
        return reason === null;
      },
    });
  } catch (err) {
    log.info({ tabQuestionId: q.id, tabId: q.tab_id, reason: reason ?? failureLabel(err) }, 'auto mode permission left to the person');
    return 'left';
  }
  answered.get(q.user_id)?.push(now);
  log.info({ tabQuestionId: q.id, tabId: q.tab_id }, 'auto mode permission allowed');
  return 'allowed';
}
