import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { backlogSections, cardPath, openCount, taskTypeLabel, WORK_TYPES, type BacklogSection } from '../lib/board';
import { useData } from '../lib/data';
import type { Task, TaskType } from '../lib/types';
import { useTranslation } from '../i18n';
import { TypeBadge } from './TypeBadge';

/**
 * The project's Backlog (spec §7): one section per epic, its backlog items in order, draggable
 * within the section. Every change goes to the server and reloads — the backlog is not a hot path.
 */
export function BacklogView({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { setOpenTasks } = useData();
  const navigate = useNavigate();
  const location = useLocation();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [newEpic, setNewEpic] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTasks((await api.tasks.list(projectId)).tasks);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao carregar o backlog'));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tasks) setOpenTasks(projectId, openCount(tasks));
  }, [tasks, projectId, setOpenTasks]);

  const sections = useMemo(() => backlogSections(tasks ?? []), [tasks]);

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : fallback);
    }
    await load();
  };

  const open = (task: Task) => navigate(cardPath(task.ref), { state: { from: location.pathname } });

  /** Drop on row `index` of a section; the index counts the dragged row when it sits above. */
  const dropOn = (e: DragEvent, section: BacklogSection, index: number) => {
    e.preventDefault();
    const id = dragId;
    setDragId(null);
    const from = section.items.findIndex((t) => t.id === id);
    if (!id || from === -1 || from === index) return; // only within the section
    void run(() => api.tasks.move(id, { status: 'backlog' }, index), t('Erro ao reordenar o backlog'));
  };

  if (tasks === null) return <div className="flex h-full items-center justify-center text-sm text-fg-dim">{error ?? t('Carregando o backlog…')}</div>;

  return (
    <div className="h-full overflow-y-auto p-4">
      {error && (
        <div className="mb-3 rounded border border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            {t('fechar')}
          </button>
        </div>
      )}
      <div className="mb-4">
        {newEpic === null ? (
          <button className="btn-ghost border border-line text-xs" onClick={() => setNewEpic('')}>
            {t('+ Novo épico')}
          </button>
        ) : (
          <form
            className="flex max-w-md gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const title = newEpic.trim();
              setNewEpic(null);
              if (title) void run(() => api.tasks.create(projectId, { title, type: 'epic', status: 'backlog' }), t('Erro ao criar o épico'));
            }}
          >
            <input
              className="input py-1 text-sm"
              aria-label={t('Título do épico')}
              autoFocus
              value={newEpic}
              onChange={(e) => setNewEpic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNewEpic(null);
              }}
            />
            <button type="submit" className="btn-primary text-xs">
              {t('Criar')}
            </button>
          </form>
        )}
      </div>
      {sections.length === 0 && <p className="text-sm text-fg-dim">{t('Nenhum épico ainda. Crie um para começar o backlog.')}</p>}
      <div className="space-y-4">
        {sections.map((s) => (
          <section key={s.epic.id} aria-label={s.epic.title} className="rounded-lg border border-line bg-bg-2">
            <header className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm">
              <TypeBadge type="epic" />
              <button className="font-mono text-xs text-fg-muted hover:text-fg" onClick={() => open(s.epic)} title={t('Abrir o épico')}>
                {s.epic.ref}
              </button>
              <span className="font-medium">{s.epic.title}</span>
              <span className="ml-auto text-xs text-fg-dim">
                {t('{{done}}/{{total}} feitas', { done: s.done, total: s.total })}
              </span>
            </header>
            <ul>
              {s.items.map((item, i) => (
                <li
                  key={item.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', item.id); // Firefox does not start a drag without this
                    setDragId(item.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => dropOn(e, s, i)}
                  className={`group flex cursor-grab items-center gap-2 border-b border-line px-3 py-1.5 text-sm last:border-b-0 ${dragId === item.id ? 'opacity-40' : ''}`}
                >
                  <TypeBadge type={item.type} />
                  <span className="font-mono text-[11px] text-fg-dim">{item.ref}</span>
                  <span className="flex-1 break-words">{item.title}</span>
                  {(item.subtasks?.length ?? 0) > 0 && (
                    <span className="shrink-0 rounded bg-bg-4 px-1 text-[10px] tabular-nums text-fg-muted">
                      ✓ {item.subtasks!.filter((x) => x.status === 'done').length}/{item.subtasks!.length}
                    </span>
                  )}
                  <button
                    className="btn-ghost shrink-0 border border-line px-2 py-0.5 text-[11px]"
                    onClick={() => void run(() => api.tasks.move(item.id, { status: 'todo' }, 0), t('Erro ao enviar para o board'))}
                  >
                    {t('Enviar para o board')}
                  </button>
                  <button className="shrink-0 rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg" onClick={() => open(item)}>
                    {t('Abrir')}
                  </button>
                </li>
              ))}
            </ul>
            {s.items.length === 0 && <p className="px-3 py-3 text-xs text-fg-dim">{t('Nada no backlog deste épico.')}</p>}
            <BacklogQuickAdd onAdd={(title, type) => void run(() => api.tasks.create(projectId, { title, type, epic_id: s.epic.id, status: 'backlog' }), t('Erro ao criar o item'))} />
          </section>
        ))}
      </div>
    </div>
  );
}

function BacklogQuickAdd({ onAdd }: { onAdd: (title: string, type: TaskType) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [type, setType] = useState<TaskType>('task');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    onAdd(v, type);
    setValue('');
  };
  return (
    <form onSubmit={submit} className="flex gap-2 p-2">
      <select aria-label={t('Tipo do item')} className="input w-auto py-1 text-xs" value={type} onChange={(e) => setType(e.target.value as TaskType)}>
        {WORK_TYPES.map((type) => (
          <option key={type} value={type}>
            {taskTypeLabel(type)}
          </option>
        ))}
      </select>
      <input className="input py-1 text-xs" placeholder={t('+ item (Enter)')} value={value} onChange={(e) => setValue(e.target.value)} />
    </form>
  );
}
