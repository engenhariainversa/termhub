import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useTranslation } from '../i18n';
import type { HealthItem, HealthWaitingCard } from '../lib/types';

const HEALTH_REFRESH_MS = 60_000;

/**
 * "Saúde do projeto" (TER-1121): the stalled work the project's health watcher sees right now, each sign with
 * what is stalled and why, and the cards of the waiting columns ("Esperando você", TER-1134) with what is
 * missing. Shown only while something is there; an alert closes by itself once the sign is gone.
 */
export function ProjectHealthPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<HealthItem[]>([]);
  const [waiting, setWaiting] = useState<HealthWaitingCard[]>([]);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const res = await api.automation.health(projectId);
      if (mine === latest.current) {
        setItems(res.items);
        setWaiting(res.waiting ?? []);
      }
    } catch {
      // an older server, or a hiccup: nothing to show is the safe answer
      if (mine === latest.current) {
        setItems([]);
        setWaiting([]);
      }
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, HEALTH_REFRESH_MS);
    return () => {
      clearInterval(timer);
      latest.current++;
    };
  }, [load]);

  if (items.length === 0 && waiting.length === 0) return null;
  return (
    <section aria-label={t('Saúde do projeto')} className="space-y-2 rounded-lg border border-amber-500 p-4">
      <h2 className="text-base font-semibold">{t('Saúde do projeto')}</h2>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5 text-sm">
            <span className={`rounded px-1.5 text-xs ${i.level === 'needs_you' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'}`}>
              {i.level === 'needs_you' ? t('precisa de você') : t('com o concierge')}
            </span>
            <span className="font-medium">{i.name}</span>
            <span className="min-w-0 basis-full sm:basis-auto">{i.text}</span>
            {i.url && (
              <a href={i.url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
                {t('abrir')}
              </a>
            )}
            {(i.signal === 'tab_stuck' || i.signal === 'tab_waiting') && (
              <Link to={`/projects/${projectId}?tab=${i.subject}`} className="text-xs text-accent hover:underline">
                {t('abrir aba')}
              </Link>
            )}
            <span className="ml-auto text-xs text-zinc-500">{relativeTime(i.opened_at)}</span>
          </li>
        ))}
      </ul>
      {waiting.length > 0 && (
        <>
          <h3 className="pt-1 text-sm font-semibold">{t('Esperando você')}</h3>
          <ul aria-label={t('Esperando você')} className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {waiting.map((c) => (
              <li key={c.task_id} className="flex flex-wrap items-baseline gap-x-2 py-1.5 text-sm">
                <Link to={`/project/${c.ref}`} className="font-medium text-accent hover:underline">
                  {c.ref}
                </Link>
                <span className="min-w-0 truncate">{c.title}</span>
                <span className="min-w-0 basis-full text-fg-dim sm:basis-auto">{c.note ?? t('na coluna {{column}}', { column: c.column })}</span>
                <span className="ml-auto text-xs text-zinc-500">{relativeTime(c.since)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
