import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { i18n, tk, useTranslation } from '../i18n';
import { formatBytes } from '../lib/attachments';
import { formatDate, formatDateTime, relativeTime } from '../lib/format';
import { filePreviewHref } from '../lib/md-paths';
import type { FileRecentGroup, FileRecentItem, FileRecentResponse, FileRecentSkipped } from '../lib/types';

interface Props {
  projectId: string;
}

type Filter = 'all' | 'cited' | FileRecentGroup;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: tk('Todos') },
  { key: 'specs', label: tk('Specs') },
  { key: 'plans', label: tk('Planos') },
  { key: 'lessons', label: tk('Lições') },
  { key: 'legal', label: tk('Jurídico') },
  { key: 'cited', label: tk('Citados pelas abas') },
  { key: 'other', label: tk('Outros') },
];

const matches = (item: FileRecentItem, filter: Filter) => filter === 'all' || (filter === 'cited' ? item.cited : item.group === filter);

/** Why a machine's files are missing from the list, as the notice says it. */
export function skippedText(s: FileRecentSkipped): string {
  const name = s.machine.name;
  if (s.reason === 'outdated') return i18n.t('Atualize o agente de {{name}} para listar os arquivos dela', { name });
  if (s.reason === 'offline') return i18n.t('{{name}} está desconectada', { name });
  if (s.reason === 'unsupported') return i18n.t('{{name}} não usa o agente do termhub', { name });
  return i18n.t('Não foi possível listar os arquivos de {{name}}', { name });
}

/** "há 3 min" / "há 5 h" within a day, "ontem" for the calendar day before, else a short date. */
export function fileDate(iso: string, now: number = Date.now()): string {
  const then = new Date(iso);
  if (now - then.getTime() < 24 * 60 * 60_000) return relativeTime(iso, now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return i18n.t('ontem');
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return formatDate(then, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The folder a row shows: the dirname of the project-relative path, or of the absolute one. */
export function folderOf(item: FileRecentItem): string {
  const p = item.rel_path ?? item.path;
  const i = p.lastIndexOf('/');
  if (i === -1) return item.rel_path !== null ? i18n.t('raiz do projeto') : '';
  return i === 0 ? '/' : p.slice(0, i);
}

/**
 * The project's recent Markdown files (spec 2026-10-04 recent Markdown files D6): the repository docs of
 * each linked machine and the files its tabs cited, newest first as the server sends them. A row opens the
 * file as the preview tab of the project's terminal area.
 */
export function RecentFiles({ projectId }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<FileRecentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .fileRecent(projectId)
      .then((r) => alive && setData(r))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível carregar os arquivos.')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [projectId, reload]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const manyMachines = useMemo(() => new Set(items.map((i) => i.machine.id)).size > 1, [items]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => matches(i, filter) && (!q || i.name.toLowerCase().includes(q) || (i.rel_path ?? i.path).toLowerCase().includes(q)));
  }, [items, filter, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg-2 px-3 py-1.5 text-xs">
        <div role="group" aria-label={t('Filtrar por grupo')} className="flex flex-wrap gap-1">
          {FILTERS.map((f) => {
            const count = items.filter((i) => matches(i, f.key)).length;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full border px-2 py-0.5 ${filter === f.key ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:text-fg'}`}
              >
                {t(f.label)}
                {data && <span className="ml-1 tabular-nums text-fg-dim">{count}</span>}
              </button>
            );
          })}
        </div>
        <input
          type="search"
          className="input w-56 py-1"
          placeholder={t('Buscar arquivo…')}
          aria-label={t('Buscar arquivo')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="btn-ghost ml-auto border border-line" onClick={() => setReload((n) => n + 1)} disabled={loading}>
          {loading && data ? t('Atualizando…') : t('Atualizar', { context: 'refresh' })}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {data && data.skipped.length > 0 && (
          <ul aria-label={t('Máquinas fora da lista')} className="mb-2 space-y-1">
            {data.skipped.map((s) => (
              <li key={s.machine.id} className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
                {skippedText(s)}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="mb-2 text-sm text-danger">
            {error}
          </p>
        )}
        {!data && loading && <p className="text-sm text-fg-dim">{t('Carregando…')}</p>}
        {data && items.length === 0 && <p className="text-sm text-fg-dim">{t('Nenhum arquivo .md encontrado')}</p>}
        {data && items.length > 0 && shown.length === 0 && <p className="text-sm text-fg-dim">{t('Nenhum arquivo neste filtro')}</p>}
        {shown.length > 0 && (
          <ul aria-label={t('Arquivos recentes')} className="divide-y divide-line rounded-lg border border-line bg-bg-2">
            {shown.map((item) => {
              const folder = folderOf(item);
              return (
                <li key={`${item.machine.id}:${item.path}`}>
                  <Link
                    to={filePreviewHref(projectId, item.rel_path ?? item.path, item.machine.id)}
                    title={item.path}
                    className="flex items-start gap-2 px-3 py-2 hover:bg-bg-3"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{item.name}</span>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-fg-dim">
                        {folder && <span className="truncate font-mono">{folder}</span>}
                        {manyMachines && <span>{item.machine.name}</span>}
                        <span className="tabular-nums">{formatBytes(item.size)}</span>
                        <time dateTime={item.mtime} title={formatDateTime(item.mtime)}>
                          {fileDate(item.mtime)}
                        </time>
                      </div>
                    </div>
                    {item.cited && <span className="shrink-0 rounded bg-accent/15 px-1.5 text-[10px] text-accent">{t('citado')}</span>}
                    {item.too_large && (
                      <span className="shrink-0 rounded bg-warn/15 px-1.5 text-[10px] text-warn" title={t('Passa do limite da prévia')}>
                        {t('muito grande')}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
