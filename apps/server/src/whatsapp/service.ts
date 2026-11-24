/**
 * TER-1201 (spec docs/superpowers/specs/2026-11-23-whatsapp-evolution-design.md): the person's WhatsApp
 * through their own Evolution API server. Notices only ever go to the number saved in their setup;
 * `send_whatsapp` may also name a group or a contact (always on the person's card). Logs carry user ids
 * and error codes only — never a number, a key or a message's text.
 */
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { WhatsappSettings } from '../db/repositories/whatsapp-settings.js';
import { isEnabled } from '../features/flags.js';
import { connectionState, EvolutionError, sendText, type ConnectionState, type EvolutionTarget } from '../integrations/evolution.js';
import { conciergeNoticeText } from '../mobile/push-text.js';
import { localeOf, type Locale } from '../i18n/index.js';
import type { OutgoingNotice } from '../chat/notices/dispatcher.js';

export type WhatsappRepos = Pick<Repositories, 'whatsapp' | 'featureFlags' | 'users' | 'projects'>;

/** Digits only, with the country code: 10 to 15 of them (E.164 without the "+"). */
export function normalizeNumber(raw: string): string | null {
  const digits = raw.replace(/[\s().+-]/g, '');
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

/** "+55 •••• 4321": enough for the person to recognise it, never the whole number. */
export function maskNumber(number: string): string {
  return `+${number.slice(0, 2)} •••• ${number.slice(-4)}`;
}

/** The text WhatsApp messages are cut to (the tool and the screen ask for less). */
export const WHATSAPP_TEXT_MAX = 1000;

/** The error code of a failure, for `last_error` and the logs. */
export function failureCode(err: unknown): string {
  return err instanceof EvolutionError ? err.code : 'UNEXPECTED';
}

/** What the screen and `whatsapp_status` show: never the key, and only the masked number for the tool. */
export interface WhatsappView {
  configured: boolean;
  server_url: string | null;
  instance: string | null;
  number: string | null;
  enabled: boolean;
  notify_needs_you: boolean;
  notify_done: boolean;
  has_api_key: boolean;
  last_sent_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

export function viewOf(s: WhatsappSettings | null): WhatsappView {
  if (!s) return { configured: false, server_url: null, instance: null, number: null, enabled: false, notify_needs_you: true, notify_done: true, has_api_key: false, last_sent_at: null, last_error: null, last_error_at: null };
  return {
    configured: true,
    server_url: s.server_url,
    instance: s.instance,
    number: s.number,
    enabled: s.enabled,
    notify_needs_you: s.notify_needs_you,
    notify_done: s.notify_done,
    has_api_key: true,
    last_sent_at: s.last_sent_at,
    last_error: s.last_error,
    last_error_at: s.last_error_at,
  };
}

/** The saved setup as a request target, or null when there is none. */
export async function savedTarget(repos: WhatsappRepos, userId: string): Promise<{ settings: WhatsappSettings; target: EvolutionTarget } | null> {
  const settings = await repos.whatsapp.get(userId);
  if (!settings) return null;
  const api_key = await repos.whatsapp.apiKey(userId);
  if (!api_key) return null;
  return { settings, target: { server_url: settings.server_url, instance: settings.instance, api_key } };
}

export type ProbeResult = { ok: true; state: ConnectionState } | { ok: false; code: string; reason?: string };

/** Asks the server for the instance's state; `ok` only when WhatsApp is paired (`open`). */
export async function probe(target: EvolutionTarget, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const state = await connectionState(target, fetchImpl);
    return state === 'open' ? { ok: true, state } : { ok: false, code: 'NOT_CONNECTED' };
  } catch (err) {
    return { ok: false, code: failureCode(err), ...(err instanceof EvolutionError && err.reason ? { reason: err.reason } : {}) };
  }
}

/**
 * Sends `text` to the person's own number — or to `to` (a group JID or a contact's digits) — and
 * records the outcome. Throws an `EvolutionError` (or `WHATSAPP_NOT_CONFIGURED`) for the caller to report.
 */
export async function sendToOwner(repos: WhatsappRepos, userId: string, text: string, fetchImpl: typeof fetch = fetch, to?: string): Promise<void> {
  const saved = await savedTarget(repos, userId);
  if (!saved) throw new Error('WHATSAPP_NOT_CONFIGURED');
  try {
    await sendText(saved.target, to ?? saved.settings.number, text.slice(0, WHATSAPP_TEXT_MAX), fetchImpl);
  } catch (err) {
    await repos.whatsapp.noteDelivery(userId, failureCode(err));
    throw err;
  }
  await repos.whatsapp.noteDelivery(userId, null);
}

/** Where a notice's link lands: the project (its chat is there) or the account-wide chat. */
export function noticeLink(projectId: string | null): string {
  return projectId ? `${config.publicUrl}/projects/${encodeURIComponent(projectId)}` : `${config.publicUrl}/chat`;
}

/** The message of a notice: the push's own title and body (bold title), then the link. */
export function noticeMessage(n: Pick<OutgoingNotice, 'level' | 'headline' | 'count' | 'projectId'>, projectName: string | null, locale: Locale): string {
  const { title, body } = conciergeNoticeText({ projectName, tabName: null, machineName: null }, n.level, n.headline, n.count, locale);
  return `*${title}*\n${body}\n${noticeLink(n.projectId)}`;
}

export interface NoticeDeps {
  repos: WhatsappRepos;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  fetchImpl?: typeof fetch;
}

/**
 * A notice the dispatcher just sent as a push (the person's levels, quiet hours, grouping and cap already
 * applied): it also goes to WhatsApp when the flag is on for them, their setup is on and its level is
 * ticked for WhatsApp. Never throws: a failure is logged by code and kept as `last_error`.
 */
export async function whatsappNotice(deps: NoticeDeps, n: OutgoingNotice): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    if (!(await isEnabled('whatsapp', { repos: deps.repos, userId: n.userId }))) return 'skipped';
    const settings = await deps.repos.whatsapp.get(n.userId);
    if (!settings?.enabled) return 'skipped';
    if (n.level === 'needs_you' ? !settings.notify_needs_you : !settings.notify_done) return 'skipped';
    const [user, project] = await Promise.all([deps.repos.users.findById(n.userId), n.projectId ? deps.repos.projects.findById(n.projectId) : Promise.resolve(undefined)]);
    await sendToOwner(deps.repos, n.userId, noticeMessage(n, project?.name ?? null, localeOf(user?.locale)), deps.fetchImpl);
    deps.log.info({ userId: n.userId, level: n.level, count: n.count }, 'whatsapp notice: sent');
    return 'sent';
  } catch (err) {
    deps.log.warn({ userId: n.userId, level: n.level, code: err instanceof Error && err.message === 'WHATSAPP_NOT_CONFIGURED' ? err.message : failureCode(err) }, 'whatsapp notice: failed');
    return 'failed';
  }
}
