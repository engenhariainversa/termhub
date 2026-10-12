import { useEffect, useRef, useState } from 'react';
import { i18n, tk, useTranslation } from '../i18n';
import { api, ApiError } from '../lib/api';
import type { MemoryReplacement, MemoryStatus, MemorySuperseder } from '../lib/types';
import { formatDate } from '../lib/format';

/** The status badge's label (TER-1013); `superseded` with a known replacement reads its title instead. */
const STATUS_LABEL: Record<MemoryStatus, string> = {
  current: tk('Vigente'),
  outdated: tk('Desatualizada'),
  wrong: tk('Errada'),
  superseded: tk('Substituída'),
};

const STATUS_CLASS: Record<MemoryStatus, string> = {
  current: 'text-ok',
  outdated: 'text-warn',
  wrong: 'text-danger',
  superseded: 'text-fg-muted',
};

export function memoryStatusText(status: MemoryStatus, supersededBy: MemorySuperseder | null): string {
  if (status === 'superseded' && supersededBy) return i18n.t('Substituída por «{{title}}»', { title: supersededBy.title });
  return i18n.t(STATUS_LABEL[status]);
}

/** The badge alone: the state of a decision or note, as the list shows it. */
export function MemoryStatusBadge({ status, supersededBy }: { status: MemoryStatus; supersededBy: MemorySuperseder | null }) {
  return <span className={STATUS_CLASS[status]}>{memoryStatusText(status, supersededBy)}</span>;
}

interface Props<T> {
  kind: 'decision' | 'note';
  id: string;
  status: MemoryStatus;
  /** Sends the change; resolves the item as its list now shows it. */
  setStatus: (status: MemoryStatus, supersededBy?: string) => Promise<T>;
  onChange: (updated: T) => void;
  onError: (message: string | null) => void;
}

/**
 * "Desatualizada", "Errada" and "Substituída por…" on one decision or concierge note of the Memória
 * screen (TER-1013), and "Desfazer" once it carries any of them. "Substituída por…" opens a picker of
 * the person's other current decisions and notes. A marked item leaves the default memory search and
 * is never a precedent again; nothing is deleted.
 */
export function MemoryStatusControls<T>({ kind, id, status, setStatus, onChange, onError }: Props<T>) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<MemoryReplacement[] | null>(null);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // The picker's own search, debounced; a slower, older answer never replaces a newer one.
  const genRef = useRef(0);
  useEffect(() => {
    if (!picking) return;
    const myGen = ++genRef.current;
    const timer = setTimeout(() => {
      api.memoryReplacements(q.trim(), `${kind}:${id}`).then(
        (r) => {
          if (mountedRef.current && genRef.current === myGen) setOptions(r.items);
        },
        (e) => {
          if (mountedRef.current && genRef.current === myGen) onError(e instanceof ApiError ? e.message : i18n.t('Não foi possível buscar os itens da memória'));
        },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [picking, q, kind, id, onError]);

  const apply = async (next: MemoryStatus, supersededBy?: string) => {
    setBusy(true);
    onError(null);
    try {
      const updated = await setStatus(next, supersededBy);
      if (!mountedRef.current) return;
      setPicking(false);
      onChange(updated);
    } catch (e) {
      if (!mountedRef.current) return;
      onError(e instanceof ApiError ? e.message : i18n.t('Não foi possível alterar o estado do item'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  if (status !== 'current') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={() => void apply('current')}>
          {t('Desfazer')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={() => void apply('outdated')} title={t('Deixa de valer a partir de agora')}>
          {t('Desatualizada')}
        </button>
        <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={() => void apply('wrong')} title={t('Sai dos precedentes e da busca padrão')}>
          {t('Errada')}
        </button>
        <button
          type="button"
          className="btn-ghost text-xs"
          disabled={busy}
          aria-expanded={picking}
          onClick={() => {
            setPicking((p) => !p);
            setOptions(null);
            setQ('');
          }}
        >
          {t('Substituída por…')}
        </button>
      </div>
      {picking && (
        <div className="mt-2 rounded-md border border-line bg-bg p-2">
          <label className="label" htmlFor={`memory-replacement-${kind}-${id}`}>
            {t('Qual item substitui este?')}
          </label>
          <input
            id={`memory-replacement-${kind}-${id}`}
            className="input mt-1"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('Buscar decisões e anotações')}
            autoFocus
          />
          {options === null ? (
            <p className="mt-2 text-xs text-fg-dim">{t('Carregando…')}</p>
          ) : options.length === 0 ? (
            <p className="mt-2 text-xs text-fg-dim">{t('Nenhum item vigente encontrado.')}</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {options.map((o) => (
                <li key={o.ref}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1 text-left text-xs hover:bg-bg-2 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void apply('superseded', o.ref)}
                  >
                    <span className="block text-fg">{o.title}</span>
                    <span className="block text-fg-dim">
                      {`${o.kind === 'decision' ? t('Decisão') : t('Anotação')} · → ${o.detail} · ${o.project_name ?? t('sem projeto')} · ${formatDate(o.created_at)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => setPicking(false)}>
            {t('Cancelar')}
          </button>
        </div>
      )}
    </div>
  );
}
