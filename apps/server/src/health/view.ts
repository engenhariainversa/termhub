import type { ControlContext } from '../control/context.js';
import type { HealthAlert } from '../db/repositories/health-alerts.js';
import { DEFAULT_LOCALE, t, type Locale } from '../i18n/index.js';
import type { HealthSignal } from '../setup/schema.js';
import type { HealthLevel } from './signals.js';
import { alertLine, SIGNAL_NAME } from './text.js';

/** One open alert as the panel ("Saúde do projeto") and `get_project_health` show it. */
export interface HealthItem {
  id: string;
  signal: HealthSignal;
  level: HealthLevel;
  /** the signal's name */
  name: string;
  /** what is stalled, and why when known */
  text: string;
  /** a PR, run or deploy to open, when there is one */
  url: string | null;
  /** the tab, card, run or machine it is about */
  subject: string;
  since_at: string;
  opened_at: string;
  /** the chat was woken about it */
  woken: boolean;
}

export function healthItem(a: HealthAlert, locale: Locale, now: Date): HealthItem {
  return {
    id: a.id, signal: a.signal, level: a.level, name: t(locale, SIGNAL_NAME[a.signal]), text: alertLine(a, locale, now),
    url: typeof a.detail.url === 'string' ? a.detail.url : null, subject: a.subject, since_at: a.since_at, opened_at: a.opened_at ?? a.first_seen_at, woken: !!a.woken_at,
  };
}

/** The project's open alerts, in the reader's language (404 outside the scope). */
export async function projectHealth(ctx: ControlContext, projectId: string, locale: Locale = DEFAULT_LOCALE): Promise<{ enabled: boolean; items: HealthItem[] }> {
  await ctx.scoped.project(projectId);
  const [setup, alerts] = await Promise.all([ctx.repos.projectSetup.get(projectId), ctx.repos.healthAlerts.listOpen(projectId)]);
  const now = new Date();
  return { enabled: setup.data.health.enabled, items: alerts.map((a) => healthItem(a, locale, now)) };
}
