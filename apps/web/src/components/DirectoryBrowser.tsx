import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { FsListing, FsRoot } from '../lib/types';
import { i18n, useTranslation } from '../i18n';

interface Props {
  machineId: string;
  /** caminho inicial (se vazio, abre o $HOME da máquina) */
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function formatKb(kb: number | undefined): string | null {
  if (kb == null) return null;
  const gb = kb / 1048576;
  if (gb >= 1000) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(kb / 1024)} MB`;
}

function rootTitle(r: FsRoot): string {
  const avail = formatKb(r.avail_kb);
  const size = formatKb(r.size_kb);
  const parts = [r.path];
  if (r.source) parts.push(r.source);
  if (avail && size) parts.push(i18n.t('{{avail}} livres de {{size}}', { avail, size }));
  return parts.join(' · ');
}

/** Navegador de pastas de uma máquina: discos/mounts no topo, breadcrumb e lista de subpastas. */
export function DirectoryBrowser({ machineId, initialPath, onSelect, onClose }: Props) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  /** campo inline de "nova pasta" (null = fechado) */
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        setListing(await api.machines.browse(machineId, path));
        setFilter('');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t('Erro ao listar diretórios'));
        // mantém a listagem anterior para o usuário poder voltar
      } finally {
        setLoading(false);
      }
    },
    [machineId, t],
  );

  useEffect(() => {
    void load(initialPath?.trim() || undefined);
    // só na abertura: navegação posterior é por clique
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);

  const createFolder = async () => {
    const name = (newName ?? '').trim();
    if (!listing || !name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { path } = await api.machines.mkdir(machineId, listing.path, name);
      setNewName(null);
      await load(path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao criar a pasta'));
    } finally {
      setCreating(false);
    }
  };

  const crumbs = listing ? listing.path.split('/').filter(Boolean) : [];
  const entries = (listing?.entries ?? []).filter((e) => (showHidden || !e.name.startsWith('.')) && (!filter || e.name.toLowerCase().includes(filter.toLowerCase())));

  return (
    <div className="rounded-md border border-line bg-bg">
      {/* discos / atalhos */}
      <div className="flex flex-wrap gap-1.5 border-b border-line p-2">
        {listing?.roots.map((r) => {
          const active = listing.path === r.path;
          const avail = formatKb(r.avail_kb);
          return (
            <button
              key={r.path}
              type="button"
              title={rootTitle(r)}
              onClick={() => void load(r.path)}
              className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors ${active ? 'border-accent bg-accent/15 text-fg' : 'border-line bg-bg-2 text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
            >
              <span aria-hidden>{r.kind === 'home' ? '⌂' : '◫'}</span>
              <span>{r.label}</span>
              {avail && <span className="text-fg-dim">{avail}</span>}
            </button>
          );
        })}
        {!listing && loading && <span className="px-1 text-xs text-fg-dim">{t('Conectando à máquina…')}</span>}
      </div>

      {/* breadcrumb */}
      {listing && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5 font-mono text-xs">
          <button type="button" className="rounded px-1 text-fg-muted hover:bg-bg-3 hover:text-fg" onClick={() => void load('/')} title="/">
            /
          </button>
          {crumbs.map((c, i) => {
            const path = '/' + crumbs.slice(0, i + 1).join('/');
            const last = i === crumbs.length - 1;
            return (
              <span key={path} className="flex items-center gap-1">
                {i > 0 && <span className="text-fg-dim">/</span>}
                <button type="button" className={`rounded px-1 hover:bg-bg-3 ${last ? 'text-fg' : 'text-fg-muted hover:text-fg'}`} onClick={() => void load(path)} disabled={last}>
                  {c}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* filtro + opções */}
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <input className="input !py-1 text-xs" placeholder={t('filtrar pastas…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="flex shrink-0 items-center gap-1 text-xs text-fg-muted">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> {t('ocultas')}
        </label>
        <button type="button" className="btn-ghost shrink-0 !py-1 text-xs" disabled={!listing} onClick={() => setNewName((n) => (n === null ? '' : null))} title={t('Criar uma subpasta na pasta atual')}>
          {t('+ Nova pasta')}
        </button>
      </div>
      {newName !== null && (
        <div className="flex items-center gap-2 border-b border-line bg-bg-2 px-2 py-1.5">
          <span className="shrink-0 font-mono text-xs text-fg-dim">{listing?.path === '/' ? '/' : `${listing?.path}/`}</span>
          <input
            className="input !py-1 font-mono text-xs"
            placeholder={t('nome-da-pasta')}
            value={newName}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void createFolder();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setNewName(null);
              }
            }}
          />
          <button type="button" className="btn-primary shrink-0 !py-1 text-xs" disabled={creating || !newName.trim()} onClick={() => void createFolder()}>
            {creating ? t('Criando…') : t('Criar')}
          </button>
          <button type="button" className="btn-ghost shrink-0 !py-1 text-xs" onClick={() => setNewName(null)}>
            {t('Cancelar')}
          </button>
        </div>
      )}

      {/* lista */}
      <div className="max-h-64 overflow-y-auto">
        {error && <p className="px-3 py-2 text-xs text-danger">{error}</p>}
        {listing?.parent != null && (
          <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-fg-muted hover:bg-bg-3 hover:text-fg" onClick={() => void load(listing.parent!)}>
            <span aria-hidden>↰</span> ..
          </button>
        )}
        {entries.map((e) => (
          <button
            key={e.path}
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-bg-3"
            onClick={() => void load(e.path)}
            onDoubleClick={() => onSelect(e.path)}
            title={t('{{path}} (duplo clique seleciona)', { path: e.path })}
          >
            <span className="text-fg-dim" aria-hidden>
              ▸
            </span>
            <span className="truncate">{e.name}</span>
          </button>
        ))}
        {listing && !loading && entries.length === 0 && !error && <p className="px-3 py-2 text-xs text-fg-dim">{listing.entries.length ? t('Nenhuma pasta com esse filtro') : t('Sem subpastas')}</p>}
        {loading && listing && <p className="px-3 py-2 text-xs text-fg-dim">{t('Carregando…')}</p>}
      </div>

      {/* rodapé */}
      <div className="flex items-center justify-between gap-2 border-t border-line px-2 py-2">
        <span className="min-w-0 truncate font-mono text-xs text-fg-muted" title={listing?.path}>
          {listing?.path ?? ''}
        </span>
        <div className="flex shrink-0 gap-1">
          <button type="button" className="btn-ghost !py-1 text-xs" onClick={onClose}>
            {t('Fechar')}
          </button>
          <button type="button" className="btn-primary !py-1 text-xs" disabled={!listing} onClick={() => listing && onSelect(listing.path)}>
            {t('Usar esta pasta')}
          </button>
        </div>
      </div>
    </div>
  );
}
