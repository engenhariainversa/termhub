import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { formatCost } from '../lib/automation-usage';
import { formatDateTime, formatNumber } from '../lib/format';
import { formatDuration } from '../lib/progress';
import { i18n, tk, useTranslation } from '../i18n';
import type { ApiRun, ApiRunStatus } from '../lib/types';

const STATUS: Record<ApiRunStatus, { label: string; tone: string }> = {
  queued: { label: tk('na fila'), tone: 'text-zinc-500' },
  running: { label: tk('rodando'), tone: 'text-amber-600' },
  succeeded: { label: tk('concluída'), tone: 'text-emerald-600' },
  failed: { label: tk('falhou'), tone: 'text-red-600' },
  cancelled: { label: tk('cancelada'), tone: 'text-zinc-500' },
};

/** How long the run took, from start to end; null while it has not ended (or never started). */
export function runSeconds(run: Pick<ApiRun, 'started_at' | 'ended_at'>): number | null {
  if (!run.started_at || !run.ended_at) return null;
  return Math.max(0, (Date.parse(run.ended_at) - Date.parse(run.started_at)) / 1000);
}

/** "42 s" under a minute (most runs), then the Progresso durations ("3 min", "1,5 h"). */
export function formatRunDuration(seconds: number): string {
  if (seconds < 60) return `${formatNumber(Math.round(seconds))} s`;
  return formatDuration(seconds);
}

/**
 * "Runs da API" in Progresso (TER-1176): the person's own runs of the personal runs API in this
 * project, newest first. Rendered only while `runs_api` is on (the route is 404 otherwise).
 */
export function ApiRunsList({ projectId, refreshMs }: { projectId: string; refreshMs: number }) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<ApiRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const res = await api.runs.list({ project: projectId });
      if (mine !== latest.current) return;
      setRuns(res.runs);
      setError(null);
    } catch {
      if (mine === latest.current) setError(i18n.t('Não foi possível carregar as runs da API.'));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, refreshMs);
    return () => {
      clearInterval(timer);
      latest.current++;
    };
  }, [load, refreshMs]);

  return (
    <section aria-label={t('Runs da API')} className="space-y-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-base font-semibold">{t('Runs da API')}</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {runs === null ? (
        !error && <p className="text-sm text-zinc-500">{t('Carregando…')}</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-zinc-500">{t('Nenhuma run da API neste projeto')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500">
              <tr>
                <th className="py-1 pr-3 font-normal">{t('Quando')}</th>
                <th className="py-1 pr-3 font-normal">{t('Status')}</th>
                <th className="py-1 pr-3 font-normal">{t('Provedor')}</th>
                <th className="py-1 pr-3 font-normal">{t('Modelo')}</th>
                <th className="py-1 pr-3 text-right font-normal">{t('Duração')}</th>
                <th className="py-1 text-right font-normal">{t('Custo')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const status = STATUS[r.status];
                const secs = runSeconds(r);
                const cost = r.usage?.cost_usd;
                return (
                  <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-900">
                    <td className="whitespace-nowrap py-1.5 pr-3">{formatDateTime(r.created_at)}</td>
                    <td className={`py-1.5 pr-3 ${status?.tone ?? ''}`} title={r.error ? (r.error.message ?? r.error.code) : undefined}>
                      {status ? t(status.label) : r.status}
                      {r.error && <span className="ml-1 font-mono text-xs">{r.error.code}</span>}
                    </td>
                    <td className="py-1.5 pr-3">{r.provider ?? '—'}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{r.model ?? '—'}</td>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{secs === null ? '—' : formatRunDuration(secs)}</td>
                    <td className="whitespace-nowrap py-1.5 text-right tabular-nums">{cost === undefined ? '—' : formatCost(cost)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
