import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import { postAutomationLine } from '../automation/chat-line.js';
import { chatBus } from '../chat/bus.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, AiProvider, Machine } from '../db/repositories/types.js';
import { localeOf, t, type Locale } from '../i18n/index.js';

/**
 * Warning ahead of an AI account's CLI login expiring (TER-1079). Claude Code tells nobody but the screen:
 * neither `claude auth status` nor a documented file carries the date, and the credential is not read for
 * it. What it does is print a startup notice from three days before, "Your login expires in 3 days · run
 * /login to renew". So a Claude session starting in a tab has its screen read once, a few seconds in; the
 * notice becomes the account's `login_expires_at` (to the notice's own precision: a day), and the machine's
 * owner is warned once per login. Codex prints nothing of the kind: this is Claude only.
 *
 * Nothing of the screen is kept or logged: only ids and the number of days.
 */

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export const LOGIN_EXPIRY_DEFAULT_DAYS = 3;
/** Claude Code announces the expiry three days ahead: a longer window could never be honoured. */
export const LOGIN_EXPIRY_MAX_DAYS = 3;
const DAY_MS = 24 * 60 * 60_000;
const UNIT_MS = { day: DAY_MS, hour: 60 * 60_000, minute: 60_000 } as const;
/** Claude Code draws its startup notices a moment after the session starts. */
export const EXPIRY_READ_DELAY_MS = 6_000;
/** A session that just started has little on screen; the notice sits near the top of it. */
const EXPIRY_SCREEN_LINES = 80;
/** A chat line in at most this many projects that list the account. */
const MAX_PROJECT_LINES = 3;

/** "…login expires in 3 days · run /login to renew": the `/login` hint keeps talk about the notice from matching. */
const NOTICE_RE = /\blogin expires in (\d{1,3}) (day|hour|minute)s?\b.{0,24}\/login\b/i;
const NOTICE_WORD_RE = /\blogin expires (today|tomorrow)\b.{0,24}\/login\b/i;

/** How long until the login expires, when the screen shows Claude Code's notice; null otherwise. Pure. */
export function parseLoginExpiryNotice(screen: string): number | null {
  const text = screen.replace(/\s+/g, ' ');
  const m = NOTICE_RE.exec(text);
  if (m) return Number(m[1]) * UNIT_MS[m[2].toLowerCase() as keyof typeof UNIT_MS];
  const w = NOTICE_WORD_RE.exec(text);
  if (w) return w[1].toLowerCase() === 'today' ? DAY_MS / 2 : DAY_MS;
  return null;
}

/** The person's window in days: their setting, else the default, within what the CLI can announce. */
export function warnDaysOf(setting: number | null | undefined): number {
  if (setting === null || setting === undefined || !Number.isFinite(setting)) return LOGIN_EXPIRY_DEFAULT_DAYS;
  return Math.max(0, Math.min(LOGIN_EXPIRY_MAX_DAYS, Math.trunc(setting)));
}

/** Whole days left, rounded up (a login expiring in 50 hours "expires in 3 days"); null when unknown or past. */
export function daysLeft(expiresAt: string | null, now: Date): number | null {
  if (!expiresAt) return null;
  const left = Date.parse(expiresAt) - now.getTime();
  return Number.isFinite(left) && left > 0 ? Math.ceil(left / DAY_MS) : null;
}

/** The login is still good and ends within `days` days (0 = the person turned the warning off). Pure. */
export function expiresSoon(expiresAt: string | null, now: Date, days: number = LOGIN_EXPIRY_DEFAULT_DAYS): boolean {
  if (!expiresAt || days <= 0) return false;
  const left = Date.parse(expiresAt) - now.getTime();
  return Number.isFinite(left) && left > 0 && left <= days * DAY_MS;
}

export const AI_CLI_NAME: Record<AiProvider, string> = { claude: 'Claude', chatgpt: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity' };

/** The line the project's chat (or the account chat) gets, in the owner's language. */
export function loginExpiryLine(info: { provider: AiProvider; label: string; machineName: string; days: number }, locale: Locale): string {
  return t(locale, 'O login do {{provider}} ({{label}}) em {{machine}} expira em {{count}} dias. Refaça o login em Contas de IA, ou peça aqui, antes que os agentes parem.', {
    provider: AI_CLI_NAME[info.provider],
    label: info.label,
    machine: info.machineName,
    count: info.days,
  });
}

export type LoginExpiringPush = (userId: string, info: { accountId: string; machineName: string; provider: AiProvider; days: number }) => Promise<void>;

export interface LoginExpiryDeps {
  repos: Repositories;
  log: Log;
  push?: LoginExpiringPush;
  now?: () => Date;
  capture?: (machine: Machine, session: string, lines: number) => Promise<string>;
  isOnline?: (machineId: string) => boolean;
}

/**
 * Warns the machine's owner that the account's login ends within their window: one push, and one line in
 * the chat of the projects that list the account (the account chat when none does). Once per login: the
 * claim is a column, so neither a later check nor the other colour repeats it. Returns whether it warned.
 * Never throws.
 */
export async function warnLoginExpiry(deps: LoginExpiryDeps, account: AiAccount, machine: Machine): Promise<boolean> {
  const { repos, log } = deps;
  try {
    const now = deps.now?.() ?? new Date();
    if (!machine.owner_id) return false;
    const days = warnDaysOf(await repos.users.aiLoginWarnDays(machine.owner_id));
    if (!expiresSoon(account.login_expires_at, now, days)) return false;
    if (!(await repos.aiAccounts.claimLoginExpiryWarning(account.id, now))) return false;
    const left = daysLeft(account.login_expires_at, now) ?? 1;
    log.info({ accountId: account.id, machineId: machine.id, days: left }, 'ai login expires soon');
    const info = { provider: account.provider, label: account.label, machineName: machine.name, days: left };
    await deps.push?.(machine.owner_id, { accountId: account.id, machineName: machine.name, provider: account.provider, days: left }).catch((err: unknown) =>
      log.warn({ accountId: account.id, code: (err as { code?: string }).code ?? 'ERROR' }, 'ai login expiry push failed'),
    );
    await postLines(repos, log, account, machine.owner_id, (locale) => loginExpiryLine(info, locale));
    return true;
  } catch (err) {
    log.warn({ accountId: account.id, code: (err as { code?: string }).code ?? 'ERROR' }, 'ai login expiry warning failed');
    return false;
  }
}

async function postLines(repos: Repositories, log: Log, account: AiAccount, ownerId: string, text: (locale: Locale) => string): Promise<void> {
  const listing: string[] = [];
  for (const project of await repos.projects.list({ owner: ownerId })) {
    if (listing.length >= MAX_PROJECT_LINES) break;
    if ((await repos.projectSetup.get(project.id)).data.ai.accounts.includes(account.id)) listing.push(project.id);
  }
  for (const projectId of listing) await postAutomationLine(repos, projectId, text, log);
  if (listing.length > 0) return;
  // No project lists it: the account chat, where the daily summary also lands.
  const owner = await repos.users.findById(ownerId);
  if (!owner) return;
  const conversation = await repos.chat.getOrCreateForUser(ownerId);
  const message = await repos.chat.addMessage({ conversation_id: conversation.id, role: 'assistant', text: text(localeOf(owner.locale)) });
  chatBus.publish({ type: 'message', user_id: ownerId, conversation_id: conversation.id, message });
}

/**
 * Reads the screen of a tab whose Claude session just started. With the notice on it, the tab's account
 * (its own, or the machine's default Claude login for a tab without one) gets the date, and the owner the
 * warning when it is due. A screen without the notice changes nothing: it may simply not be drawn yet.
 * Never throws.
 */
export async function readLoginExpiry(deps: LoginExpiryDeps, tabId: string): Promise<void> {
  const { repos, log } = deps;
  try {
    const tab = await repos.tabs.findById(tabId);
    if (!tab || tab.kind !== 'terminal' || !tab.tmux_session) return;
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine || (machine.type === 'agent' && !(deps.isOnline ?? ((id) => agents.isOnline(id)))(machine.id))) return;
    const left = parseLoginExpiryNotice(await (deps.capture ?? captureScreen)(machine, tab.tmux_session, EXPIRY_SCREEN_LINES));
    if (left === null) return;
    const account = tab.ai_account_id
      ? await repos.aiAccounts.findById(tab.ai_account_id)
      : (await repos.aiAccounts.list(machine.owner_id)).find((a) => a.machine_id === machine.id && a.provider === 'claude' && a.config_dir === null);
    if (!account || account.provider !== 'claude' || account.machine_id !== machine.id) return;
    const now = deps.now?.() ?? new Date();
    const expiresAt = new Date(now.getTime() + left);
    await repos.aiAccounts.noteLoginExpiry(account.id, expiresAt, now);
    log.info({ tabId: tab.id, accountId: account.id, machineId: machine.id, days: Math.ceil(left / DAY_MS) }, 'ai login expiry read from the screen');
    await warnLoginExpiry(deps, { ...account, login_expires_at: expiresAt.toISOString() }, machine);
  } catch (err) {
    log.warn({ tabId, code: (err as { code?: string }).code ?? 'ERROR' }, 'ai login expiry read failed');
  }
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
let expiringPush: LoginExpiringPush | undefined;

/** The app wires the phone push once it has one; without it the warning is the chat line and the screens. */
export function setLoginExpiringPush(push: LoginExpiringPush | undefined): void {
  expiringPush = push;
}

/** Whether a Claude `SessionStart` is a CLI that just started (its notices are drawn), not a /clear or a /compact. */
export function isFreshClaudeStart(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const { hook_event_name: name, source } = event as Record<string, unknown>;
  return name === 'SessionStart' && (source === undefined || source === 'startup');
}

/** A Claude session started in the tab: its screen is read once the startup notices are drawn. */
export function scheduleLoginExpiryRead(deps: LoginExpiryDeps, tabId: string, delayMs = EXPIRY_READ_DELAY_MS): void {
  const waiting = pending.get(tabId);
  if (waiting) clearTimeout(waiting);
  const timer = setTimeout(() => {
    pending.delete(tabId);
    void readLoginExpiry({ push: expiringPush, ...deps }, tabId);
  }, delayMs);
  timer.unref();
  pending.set(tabId, timer);
}

/** Server close and tests: no read is left waiting. */
export function cancelLoginExpiryReads(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
