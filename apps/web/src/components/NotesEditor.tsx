import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { formatDateTime } from '../lib/format';
import { useTranslation } from '../i18n';

interface Props {
  projectId: string;
}

/** `merged`: the server's save answered a content different from what was sent (D9 — it kept a
 *  lesson block an agent appended concurrently) and nothing was typed since; the textarea has just
 *  adopted that content, and the status line says so instead of "salvo". */
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'merged';
const DEBOUNCE_MS = 800;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function NotesEditor({ projectId }: Props) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [mode, setMode] = useState<'split' | 'edit' | 'preview'>(() => (localStorage.getItem('termhub:notes-mode') as 'split' | 'edit' | 'preview') || 'split');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef('');
  const lastSaved = useRef('');
  // The note's `updated_at` last loaded or saved (D9): sent back as `base_updated_at` on the next save
  // (and on the keep-alive unload save), so the server can tell a lesson block appended after this
  // from one already known. A ref, not state, so the unload handler (registered once per `projectId`)
  // always reads the latest value rather than the one captured when it was added.
  const base = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.notes
      .get(projectId)
      .then((r) => {
        if (cancelled) return;
        setContent(r.note.content);
        latest.current = r.note.content;
        lastSaved.current = r.note.content;
        // Only a real note has a date worth showing; but the base is always sent (final review fix):
        // for a project with no note yet the server answers the epoch, and without a base the first
        // save would be a plain upsert that erases a lesson the concierge appended into the brand-new
        // note meanwhile. With the epoch, every such block is newer than the base and is kept.
        setUpdatedAt(r.note.id ? r.note.updated_at : null);
        base.current = r.note.updated_at;
      })
      .catch(() => !cancelled && setContent(''));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    localStorage.setItem('termhub:notes-mode', mode);
  }, [mode]);

  const save = useCallback(async () => {
    const value = latest.current;
    if (value === lastSaved.current) {
      setSaveState('saved');
      return;
    }
    setSaveState('saving');
    try {
      const r = await api.notes.save(projectId, value, base.current);
      const typedSince = latest.current !== value;
      const merged = r.note.content !== value;
      if (merged && !typedSince) {
        // Nothing typed since this request started (D9): the server kept a lesson block an agent
        // appended concurrently — adopt it rather than let the next autosave erase it again. This
        // response's `updated_at` now safely describes what the textarea holds.
        base.current = r.note.updated_at;
        setUpdatedAt(r.note.updated_at);
        latest.current = r.note.content;
        lastSaved.current = r.note.content;
        setContent(r.note.content);
        setSaveState('merged');
        return;
      }
      if (!merged) {
        // No merge happened (the row still holds exactly what was sent): this response's
        // `updated_at` is a safe base for the next save, typed-since or not.
        base.current = r.note.updated_at;
        setUpdatedAt(r.note.updated_at);
      }
      // `merged && typedSince`: the person kept typing, so their newer text stays on screen — but
      // `base` (and the displayed date) must NOT advance to this response's `updated_at`. That
      // timestamp is the row's, which already carries the appended block; sending it back as the
      // next save's `base_updated_at` would tell the server's merge (`mergeNoteSave`, only re-appends
      // a block newer than the base) that the block is already known and drop it for good. Keeping
      // `base` at what this request was sent with makes the next save merge against it again.
      lastSaved.current = value;
      setSaveState(latest.current === value ? 'saved' : 'dirty');
    } catch (e) {
      setSaveState('error');
      console.error(e instanceof ApiError ? e.message : e);
    }
  }, [projectId]);

  const onChange = (value: string) => {
    setContent(value);
    latest.current = value;
    setSaveState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), DEBOUNCE_MS);
  };

  // Salva o que estiver pendente ao sair da tela / fechar a aba.
  useEffect(() => {
    const flush = () => {
      if (latest.current !== lastSaved.current) {
        const body = JSON.stringify(base.current ? { content: latest.current, base_updated_at: base.current } : { content: latest.current });
        const csrf = document.cookie.match(/(?:^|; )termhub_csrf=([^;]*)/)?.[1] ?? '';
        void fetch(`/api/projects/${projectId}/note`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
          body,
          keepalive: true,
        });
        lastSaved.current = latest.current;
      }
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      if (timer.current) clearTimeout(timer.current);
      flush();
    };
  }, [projectId]);

  const html = useMemo(() => {
    if (!content) return '';
    return renderMarkdown(content);
  }, [content]);

  if (content === null) return <div className="flex h-full items-center justify-center text-sm text-fg-dim">{t('Carregando notas…')}</div>;

  const status =
    saveState === 'saving'
      ? t('salvando…')
      : saveState === 'dirty'
        ? t('alterações pendentes')
        : saveState === 'error'
          ? t('erro ao salvar')
          : saveState === 'merged'
            ? t('lição adicionada por um agente')
            : saveState === 'saved'
              ? t('salvo')
              : '';

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-bg-2 px-3 text-xs">
        {(['edit', 'split', 'preview'] as const).map((m) => (
          <button key={m} className={`rounded px-2 py-1 ${mode === m ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:text-fg'}`} onClick={() => setMode(m)}>
            {m === 'edit' ? t('Editar') : m === 'split' ? t('Lado a lado') : t('Preview')}
          </button>
        ))}
        <span className={`ml-auto ${saveState === 'error' ? 'text-danger' : 'text-fg-dim'}`}>
          {status}
          {updatedAt && saveState !== 'dirty' && saveState !== 'saving' ? ` · ${formatDateTime(updatedAt)}` : ''}
        </span>
      </div>
      <div className={`grid min-h-0 flex-1 ${mode === 'split' ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {mode !== 'preview' && (
          <textarea
            className="h-full w-full resize-none border-r border-line bg-bg p-4 font-mono text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-dim"
            value={content}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('# Notas do projeto\n\nMarkdown com preview ao lado. Salva sozinho.')}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: s, selectionEnd: en } = el;
                const next = content.slice(0, s) + '  ' + content.slice(en);
                onChange(next);
                requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
              }
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                if (timer.current) clearTimeout(timer.current);
                void save();
              }
            }}
          />
        )}
        {mode !== 'edit' && (
          <div className="prose-termhub h-full overflow-y-auto p-4" dangerouslySetInnerHTML={{ __html: html || `<p class="text-fg-dim">${escapeHtml(t('Nada para mostrar ainda.'))}</p>` }} />
        )}
      </div>
    </div>
  );
}
