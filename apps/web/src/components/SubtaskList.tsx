import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import type { Task } from '../lib/types';
import { useTranslation } from '../i18n';

interface Props {
  parent: Task;
  /**
   * The full, reindexed list after every change (optimistic). On failure no snapshot is written
   * here; the parent reloads from the server and reports the error.
   *
   * Optimistic call sites (toggle/rename/remove/reorder) pass a list computed from the props
   * `subtasks` snapshot, safe since they resolve synchronously from the user's perspective. `add`
   * awaits the server first, so it passes an updater instead — applied to whatever the list is by
   * the time the response lands, so it can't revert a change (e.g. a toggle) made during the wait.
   */
  onChange: (subtasks: Task[] | ((prev: Task[]) => Task[])) => void;
  onError: (message: string) => void;
}

const reindex = (list: Task[]) => list.map((s, i) => ({ ...s, position: i }));

/** Checklist of a task's subtasks: toggle, rename, add, delete and drag to reorder. Owns its API calls. */
export function SubtaskList({ parent, onChange, onError }: Props) {
  const { t } = useTranslation();
  const subtasks = [...(parent.subtasks ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const done = subtasks.filter((s) => s.status === 'done').length;

  /** Applies `next` now; on rejection reports only — no snapshot is written, since the closure's `subtasks` may be stale by the time the save settles. The parent reloads from the server. */
  const commit = async (next: Task[], save: () => Promise<unknown>, fallback: string) => {
    onChange(next);
    try {
      await save();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : fallback);
    }
  };

  const toggle = (s: Task) => {
    const status = s.status === 'done' ? 'todo' : 'done';
    void commit(
      subtasks.map((x) => (x.id === s.id ? { ...x, status } : x)),
      () => api.tasks.update(s.id, { status }),
      t('Erro ao salvar subtarefa'),
    );
  };

  // Enter/Escape settle the edit synchronously and mark it handled so a blur that fires afterward
  // (e.g. as the input unmounts) can't re-save from a stale closure or save a cancelled edit.
  const renameHandled = useRef(false);

  const startRename = (s: Task) => {
    renameHandled.current = false;
    setRenaming({ id: s.id, title: s.title });
  };

  const cancelRename = () => {
    renameHandled.current = true;
    setRenaming(null);
  };

  const commitRename = () => {
    if (renameHandled.current || !renaming) return;
    renameHandled.current = true;
    const { id, title } = renaming;
    setRenaming(null);
    const v = title.trim();
    if (!v || v === subtasks.find((s) => s.id === id)?.title) return;
    void commit(
      subtasks.map((x) => (x.id === id ? { ...x, title: v } : x)),
      () => api.tasks.update(id, { title: v }),
      t('Erro ao salvar subtarefa'),
    );
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    try {
      const r = await api.tasks.addSubtasks(parent.id, [{ title }]);
      onChange((prev) => [...prev, ...r.subtasks]);
    } catch (err) {
      setDraft(title);
      onError(err instanceof ApiError ? err.message : t('Erro ao criar subtarefa'));
    }
  };

  const remove = (s: Task) =>
    void commit(
      reindex(subtasks.filter((x) => x.id !== s.id)),
      () => api.tasks.remove(s.id),
      t('Erro ao excluir subtarefa'),
    );

  const dropOn = (e: DragEvent, index: number) => {
    e.preventDefault();
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const moving = subtasks.find((s) => s.id === id);
    if (!moving || subtasks.indexOf(moving) === index) return;
    const rest = subtasks.filter((s) => s.id !== id);
    rest.splice(index, 0, moving);
    void commit(reindex(rest), () => api.tasks.reorder(id, index), t('Erro ao reordenar subtarefas'));
  };

  return (
    <div>
      <label className="label flex items-center gap-2">
        {t('Subtarefas')}
        {subtasks.length > 0 && (
          <span className="font-normal normal-case text-fg-dim">
            {t('{{done}} de {{total}} concluídas', { done, total: subtasks.length })}
          </span>
        )}
      </label>
      <ul className="space-y-1">
        {subtasks.map((s, i) => (
          <li
            key={s.id}
            draggable={renaming?.id !== s.id}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              setDragId(s.id);
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => dropOn(e, i)}
            className={`group flex cursor-grab items-center gap-2 rounded-md border border-line bg-bg-3 px-2 py-1 text-sm ${dragId === s.id ? 'opacity-40' : ''}`}
          >
            <input type="checkbox" aria-label={s.title} checked={s.status === 'done'} onChange={() => toggle(s)} />
            {renaming?.id === s.id ? (
              <input
                className="flex-1 bg-transparent outline-none"
                autoFocus
                value={renaming.title}
                onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') cancelRename();
                }}
              />
            ) : (
              <span
                className={`flex-1 cursor-text break-words ${s.status === 'done' ? 'text-fg-muted line-through decoration-fg-dim' : ''}`}
                onClick={() => startRename(s)}
              >
                {s.title}
              </span>
            )}
            {s.status === 'doing' && <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] text-accent">{t('em andamento')}</span>}
            <button
              type="button"
              aria-label={t('Excluir subtarefa {{title}}', { title: s.title })}
              title={t('Excluir subtarefa')}
              className="invisible shrink-0 rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-danger group-hover:visible"
              onClick={() => remove(s)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-1">
        <input className="input py-1.5 text-xs" placeholder={t('Adicionar subtarefa (Enter)')} value={draft} onChange={(e) => setDraft(e.target.value)} />
      </form>
    </div>
  );
}
