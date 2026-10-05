import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { applyMove, cardPath, cardsIn, dropPosition, epicsOf, FILTER_TYPES, nextColumn, openCount, readBoardFilter, visible, writeBoardFilter, type BoardFilter } from '../lib/board';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { readLastMachine, writeLastMachine } from '../lib/last-machine';
import { cardTitle, ticketKey } from '../lib/ticket-link';
import { COLUMN_CATEGORY_LABEL, PROVIDER_LABEL, TASK_TYPE_LABEL, type ColumnCategory, type Task, type TaskColumn, type TaskPatchInput, type TaskType } from '../lib/types';
import { loadIneligibleReasons, untaggedUnderEpic } from '../lib/automation';
import { AutomationBadge } from './AutomationBadge';
import { MachinePicker } from './MachinePicker';
import { TaskEditor, type PlaceTarget } from './TaskEditor';
import { TypeBadge } from './TypeBadge';

const CATEGORY_DOT: Record<ColumnCategory, string> = { todo: 'bg-fg-dim', doing: 'bg-accent', done: 'bg-ok' };

interface Props {
  projectId: string;
  /** `/project/:ref`: the card whose editor is open — the URL owns it */
  openTaskId?: string;
}

interface DragState {
  taskId: string;
  overColumn: string | null;
  overIndex: number | null;
}

/** The project's Board (spec §7): its own columns, a type/epic filter, cards with type, ref and epic. */
export function TasksBoard({ projectId, openTaskId }: Props) {
  const { projects, machinesOf, setOpenTasks } = useData();
  const { openTabs } = useMonitor();
  const navigate = useNavigate();
  const location = useLocation();
  const project = projects.find((p) => p.id === projectId);
  const projectMachines = project ? machinesOf(project) : [];
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [columns, setColumns] = useState<TaskColumn[]>([]);
  const [filter, setFilter] = useState<BoardFilter>(() => readBoardFilter(projectId));
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pickingMachineFor, setPickingMachineFor] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    try {
      const [r, why] = await Promise.all([api.tasks.list(projectId), loadIneligibleReasons(projectId)]);
      setReasons(why);
      setTasks(r.tasks);
      setColumns([...r.columns].sort((a, b) => a.position - b.position));
      // a remembered epic that no longer exists would otherwise filter every card out with no visible cause
      setFilter((f) => {
        if (!f.epicId || epicsOf(r.tasks).some((e) => e.id === f.epicId)) return f;
        const next = { ...f, epicId: null };
        writeBoardFilter(projectId, next);
        return next;
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar o board');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tasks) setOpenTasks(projectId, openCount(tasks));
  }, [tasks, projectId, setOpenTasks]);

  const epics = useMemo(() => epicsOf(tasks ?? []), [tasks]);
  /** The project's open terminal tabs, as the card editor offers them to link (TER-499). */
  const linkableTabs = openTabs
    .filter((t) => t.project_id === projectId && t.kind === 'terminal')
    .map((t) => ({ id: t.id, name: t.name, machine_name: projectMachines.find((m) => m.id === t.machine_id)?.name ?? '—' }));
  const epicTitle = useMemo(() => new Map(epics.map((e) => [e.id, e.title])), [epics]);
  const editing = openTaskId ? ((tasks ?? []).find((t) => t.id === openTaskId) ?? null) : null;
  /** The section a card was opened from; the card URL keeps it in the history state (a pasted link has none). */
  const from = (location.state as { from?: string } | null)?.from ?? `/projects/${projectId}/tasks`;
  const openCard = (task: Task) => navigate(cardPath(task.ref), { state: { from: location.pathname.startsWith('/project/') ? from : location.pathname } });
  const closeCard = () => navigate(from);

  const changeFilter = (next: BoardFilter) => {
    setFilter(next);
    writeBoardFilter(projectId, next);
  };

  const fail = (e: unknown, fallback: string) => {
    setError(e instanceof ApiError ? e.message : fallback);
    void load();
  };

  // PATCH/move answer with the bare card: keep the subtasks the list endpoint gave us
  const replaceTask = (task: Task) => setTasks((t) => (t ?? []).map((x) => (x.id === task.id ? { ...task, subtasks: task.subtasks ?? x.subtasks } : x)));

  const setSubtasks = (parentId: string, v: Task[] | ((prev: Task[]) => Task[])) =>
    setTasks((t) => (t ?? []).map((x) => (x.id === parentId ? { ...x, subtasks: typeof v === 'function' ? v(x.subtasks ?? []) : v } : x)));

  const create = async (column: TaskColumn, title: string) => {
    try {
      const { task } = await api.tasks.create(projectId, { title, column_id: column.id });
      setTasks((t) => [...(t ?? []).map((x) => (!x.parent_id && x.column_id === column.id ? { ...x, position: x.position + 1 } : x)), { ...task, subtasks: [] }]);
      // the first card of a project also creates its default epic: fetch it for the names and the filter
      if (task.epic_id && !epicTitle.has(task.epic_id)) void load();
    } catch (e) {
      fail(e, 'Erro ao criar o card');
    }
  };

  const update = async (id: string, patch: TaskPatchInput) => {
    setTasks((t) => (t ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      replaceTask((await api.tasks.update(id, patch)).task);
    } catch (e) {
      fail(e, 'Erro ao salvar o card');
    }
  };

  /** Tags or untags a card; an epic reaches its cards too, so the board reloads (the tag and the reasons). */
  const setAuto = async (id: string, auto: boolean) => {
    try {
      await api.tasks.update(id, { auto });
    } catch (e) {
      fail(e, 'Erro ao marcar o card para trabalho automático');
    }
    await load();
  };

  /** Moves locally (reindexing both columns) and persists. `position` is the server position. */
  const move = async (id: string, columnId: string, position: number) => {
    const column = columns.find((c) => c.id === columnId);
    if (!column) return;
    setTasks((t) => applyMove(t ?? [], id, column, position));
    try {
      replaceTask((await api.tasks.move(id, { column_id: columnId }, position)).task);
    } catch (e) {
      fail(e, 'Erro ao mover o card');
    }
  };

  const place = async (id: string, target: PlaceTarget) => {
    if ('column_id' in target) return move(id, target.column_id, 0);
    try {
      await api.tasks.move(id, target, 0);
      await load(); // it left the board: the column it was in closes its gap
    } catch (e) {
      fail(e, 'Erro ao mover o card');
    }
  };

  const openTerminal = async (id: string, machineId?: string) => {
    try {
      const r = await api.tasks.openTerminal(id, machineId);
      if (machineId) writeLastMachine(projectId, machineId);
      replaceTask(r.task);
      navigate(`/projects/${projectId}?tab=${r.tab.id}`);
    } catch (e) {
      fail(e, 'Erro ao abrir terminal');
    }
  };

  /** Links the card to a tab that is already open; the server moves it as `start_agent` would. */
  const linkTab = async (id: string, tabId: string) => {
    try {
      await api.tasks.linkTab(id, tabId);
      await load(); // the card may have changed column, and the cards of both columns were reindexed
    } catch (e) {
      fail(e, 'Erro ao ligar a aba ao card');
    }
  };

  const detachTerminal = async (id: string) => {
    try {
      replaceTask((await api.tasks.detachTerminal(id)).task);
    } catch (e) {
      fail(e, 'Erro ao desligar a aba do card');
    }
  };

  /** Resolves which machine to open the card's terminal on before calling the API. */
  const chooseTerminal = (id: string) => {
    if (projectMachines.length === 0) {
      setError('Vincule uma máquina ao projeto em Setup → Máquinas para abrir terminais.');
      return;
    }
    if (projectMachines.length === 1) {
      void openTerminal(id, projectMachines[0].id);
      return;
    }
    const last = readLastMachine(projectId);
    if (last && projectMachines.some((m) => m.id === last)) {
      void openTerminal(id, last);
      return;
    }
    setPickingMachineFor(id);
  };

  const pushStatus = async (id: string) => {
    try {
      const r = await api.tasks.pushStatus(id);
      replaceTask(r.task);
      return r.state;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao atualizar no provedor');
      return null;
    }
  };

  /** Not optimistic: an epic that still has cards is refused (409) and must stay on screen. */
  const remove = async (id: string) => {
    if (openTaskId === id) closeCard();
    try {
      await api.tasks.remove(id);
      setTasks((t) => (t ?? []).filter((x) => x.id !== id));
    } catch (e) {
      fail(e, 'Erro ao excluir o card');
    }
  };

  // --- native drag and drop, keyed by column ---
  const onDragStart = (e: DragEvent, task: Task) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
    setDrag({ taskId: task.id, overColumn: null, overIndex: null });
  };
  const onDragOverColumn = (e: DragEvent, columnId: string, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDrag((d) => (d && (d.overColumn !== columnId || d.overIndex !== index) ? { ...d, overColumn: columnId, overIndex: index } : d));
  };
  const onDrop = (e: DragEvent, column: TaskColumn, index: number) => {
    e.preventDefault();
    // our own drag state first; `dataTransfer` is only a fallback, and only for an id we actually have
    // (a foreign drop — another app, a stale/lost drag — must not reach the API).
    const id = drag?.taskId ?? e.dataTransfer.getData('text/plain');
    setDrag(null);
    if (!id || !tasks || !tasks.some((t) => t.id === id)) return;
    const all = cardsIn(tasks, column.id);
    void move(id, column.id, dropPosition(all, visible(all, filter), index, id));
  };

  if (tasks === null) return <div className="flex h-full items-center justify-center text-sm text-fg-dim">{error ?? 'Carregando o board…'}</div>;
  const loaded = tasks;

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            fechar
          </button>
        </div>
      )}
      <BoardToolbar filter={filter} epics={epics} onChange={changeFilter} />
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {columns.map((column) => {
          const shown = visible(cardsIn(loaded, column.id), filter);
          const isOver = drag?.overColumn === column.id;
          const next = nextColumn(columns, column.id);
          return (
            <section
              key={column.id}
              aria-label={column.name}
              className={`flex min-h-0 w-[260px] shrink-0 flex-col rounded-lg border bg-bg-2 ${isOver ? 'border-accent/60' : 'border-line'}`}
              onDragOver={(e) => onDragOverColumn(e, column.id, shown.length)}
              onDrop={(e) => onDrop(e, column, drag?.overIndex ?? shown.length)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag((d) => (d ? { ...d, overColumn: null, overIndex: null } : d));
              }}
            >
              <header className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-fg-muted">
                <span className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_DOT[column.category]}`} title={COLUMN_CATEGORY_LABEL[column.category]} />
                <span className="truncate">{column.name}</span>
                <span className="ml-auto rounded-full bg-bg-4 px-1.5 text-[10px] tabular-nums">{shown.length}</span>
              </header>
              <QuickAdd onAdd={(title) => void create(column, title)} />
              <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                {shown.map((task, i) => (
                  <li
                    key={task.id}
                    onDragOver={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      onDragOverColumn(e, column.id, e.clientY < rect.top + rect.height / 2 ? i : i + 1);
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      onDrop(e, column, drag?.overIndex ?? i);
                    }}
                  >
                    {isOver && drag?.overIndex === i && drag.taskId !== task.id && <DropLine />}
                    <TaskCard
                      task={task}
                      epicTitle={task.epic_id ? (epicTitle.get(task.epic_id) ?? null) : null}
                      dragging={drag?.taskId === task.id}
                      onDragStart={(e) => onDragStart(e, task)}
                      onDragEnd={() => setDrag(null)}
                      onOpen={() => openCard(task)}
                      next={next}
                      onMoveNext={next ? () => void move(task.id, next.id, 0) : undefined}
                      terminalHref={task.tab_id ? `/projects/${projectId}?tab=${task.tab_id}` : null}
                      autoReason={reasons.get(task.id) ?? null}
                    />
                  </li>
                ))}
                {isOver && drag && drag.overIndex === shown.length && <DropLine />}
                {shown.length === 0 && !isOver && <li className="px-1 py-6 text-center text-xs text-fg-dim">vazio</li>}
              </ul>
            </section>
          );
        })}
      </div>

      {editing && (
        <TaskEditor
          key={editing.id}
          task={editing}
          columns={columns}
          epics={epics}
          terminalHref={editing.tab_id ? `/projects/${projectId}?tab=${editing.tab_id}` : null}
          linkableTabs={linkableTabs}
          onLinkTab={(tabId) => void linkTab(editing.id, tabId)}
          onDetachTerminal={() => void detachTerminal(editing.id)}
          onClose={closeCard}
          epicUntagged={editing.type === 'epic' ? untaggedUnderEpic(editing, loaded) : 0}
          onSetAuto={(auto) => void setAuto(editing.id, auto)}
          onSave={(patch) => void update(editing.id, patch)}
          onPlace={(target) => void place(editing.id, target)}
          onDelete={() => void remove(editing.id)}
          onOpenTerminal={() => chooseTerminal(editing.id)}
          onPushStatus={() => pushStatus(editing.id)}
          onSubtasks={(subtasks) => setSubtasks(editing.id, subtasks)}
          onError={(message) => {
            setError(message);
            void load();
          }}
        />
      )}
      {project && (
        <MachinePicker
          open={pickingMachineFor !== null}
          project={project}
          machines={projectMachines}
          onPick={(machineId) => {
            const id = pickingMachineFor;
            setPickingMachineFor(null);
            if (id) void openTerminal(id, machineId);
          }}
          onClose={() => setPickingMachineFor(null)}
        />
      )}
    </div>
  );
}

function BoardToolbar({ filter, epics, onChange }: { filter: BoardFilter; epics: Task[]; onChange: (next: BoardFilter) => void }) {
  const toggle = (type: TaskType) =>
    onChange({ ...filter, types: FILTER_TYPES.filter((t) => (t === type ? !filter.types.includes(t) : filter.types.includes(t))) });
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
      <span className="text-fg-dim">Mostrar:</span>
      {FILTER_TYPES.map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={filter.types.includes(t)}
          onClick={() => toggle(t)}
          className={`rounded-full border px-2 py-0.5 ${filter.types.includes(t) ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:bg-bg-3'}`}
        >
          {TASK_TYPE_LABEL[t]}
        </button>
      ))}
      <select
        aria-label="Filtrar por épico"
        className="input ml-auto w-auto py-1 text-xs"
        value={filter.epicId ?? ''}
        onChange={(e) => onChange({ ...filter, epicId: e.target.value || null })}
      >
        <option value="">Todos os épicos</option>
        {epics.map((e) => (
          <option key={e.id} value={e.id}>
            {e.ref} {e.title}
          </option>
        ))}
      </select>
    </div>
  );
}

function DropLine() {
  return <div className="my-1 h-0.5 rounded bg-accent" />;
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    onAdd(v);
    setValue('');
  };
  return (
    <form onSubmit={submit} className="px-2 pb-2">
      <input
        className="input py-1.5 text-xs"
        placeholder="+ novo card (Enter)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setValue('');
        }}
      />
    </form>
  );
}

interface CardProps {
  task: Task;
  epicTitle: string | null;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
  next?: TaskColumn;
  onMoveNext?: () => void;
  terminalHref: string | null;
  /** why a tagged card cannot be taken yet (tooltip of the badge's warning dot) */
  autoReason: string | null;
}

/** Visible on hover, on keyboard focus (anywhere in the card) and always on touch (no hover). */
const CARD_ACTION = 'invisible shrink-0 rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg group-hover:visible group-focus-within:visible focus:visible [@media(hover:none)]:visible';

/** Renaming happens in the card editor's "Título" field; the board card only opens it (spec §7). */
function TaskCard({ task, epicTitle, dragging, onDragStart, onDragEnd, onOpen, next, onMoveNext, terminalHref, autoReason }: CardProps) {
  // A native drag can still leave a trailing click on the source element once it is dropped; this
  // flag outlives the drag by one tick so that stray click does not also open the card.
  const draggedRef = useRef(false);

  const done = task.subtasks?.filter((s) => s.status === 'done').length ?? 0;
  const total = task.subtasks?.length ?? 0;

  return (
    <div
      draggable
      onDragStart={(e) => {
        draggedRef.current = true;
        onDragStart(e);
      }}
      onDragEnd={() => {
        onDragEnd();
        setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }}
      role="button"
      tabIndex={0}
      aria-label={`${task.ref} ${cardTitle(task.title, task.external_ref)}`}
      onClick={() => {
        if (draggedRef.current) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        // only the card itself, not a nested control (the → button, the terminal link…) bubbling up
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group cursor-grab rounded-md border border-line bg-bg-3 px-2.5 py-2 text-sm hover:border-fg-dim focus:outline-none focus-visible:ring-1 focus-visible:ring-accent active:cursor-grabbing ${
        dragging ? 'opacity-40' : ''
      } ${task.status === 'done' ? 'text-fg-muted line-through decoration-fg-dim' : ''}`}
    >
      <div className="flex items-start gap-1.5">
        <TypeBadge type={task.type} />
        <span className="flex-1 break-words">
          <span className="mr-1.5 font-mono text-[10px] text-fg-dim">{task.ref}</span>
          {cardTitle(task.title, task.external_ref)}
        </span>
        {task.auto && <AutomationBadge reason={autoReason} />}
        {total > 0 && (
          <span className="shrink-0 rounded bg-bg-4 px-1 text-[10px] tabular-nums text-fg-muted" title={`${done} de ${total} subtarefas concluídas`}>
            ✓ {done}/{total}
          </span>
        )}
        {terminalHref && (
          <Link to={terminalHref} onClick={(e) => e.stopPropagation()} className="shrink-0 rounded px-1 font-mono text-[11px] text-ok hover:bg-bg-4" title="Terminal deste card (ir para a tab)">
            ▮_
          </Link>
        )}
        <button
          className={CARD_ACTION}
          title="Abrir card"
          aria-label={`Abrir card ${task.ref}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          ⋯
        </button>
        {onMoveNext && next && (
          <button
            className={CARD_ACTION}
            title={`Mover para ${next.name}`}
            aria-label={`Mover para ${next.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onMoveNext();
            }}
          >
            →
          </button>
        )}
      </div>
      {task.external_ref && (
        <a
          href={task.external_ref.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 block truncate font-mono text-[10px] text-accent hover:underline"
          title={`${PROVIDER_LABEL[task.external_ref.provider]}: ${task.external_ref.state}`}
        >
          {ticketKey(task.external_ref)}
        </a>
      )}
      {epicTitle && (
        <p className="mt-0.5 truncate text-[10px] text-fg-dim" title={`Épico: ${epicTitle}`}>
          {epicTitle}
        </p>
      )}
      {task.external_ref && task.external_ref.status !== task.status && (
        <p className="mt-1 text-[10px] text-warn" title="Estado no provedor difere da coluna; abra o card → Atualizar para sincronizar">
          {PROVIDER_LABEL[task.external_ref.provider]}: {task.external_ref.state}
        </p>
      )}
      {task.description && (
        <p
          className="mt-1 line-clamp-2 cursor-pointer text-xs text-fg-dim hover:text-fg-muted"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {task.description}
        </p>
      )}
    </div>
  );
}
