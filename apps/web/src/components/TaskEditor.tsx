import { useState } from 'react';
import { Link } from 'react-router-dom';
import { canHaveSubtasks, cardPath, typeOptions } from '../lib/board';
import { ticketKey } from '../lib/ticket-link';
import { PROVIDER_LABEL, TASK_STATUS_LABEL, TASK_TYPE_LABEL, type Task, type TaskColumn, type TaskPatchInput, type TaskType } from '../lib/types';
import { CardPullRequests } from './CardPullRequests';
import { Modal } from './Modal';
import { SubtaskList } from './SubtaskList';
import { formatDate, formatDateTime } from '../lib/format';

/** Where the column select sends a card. */
export type PlaceTarget = { column_id: string } | { status: 'backlog' };

/** An open terminal tab as the editor names it. */
export interface LinkableTab {
  id: string;
  name: string;
  machine_name: string;
}

export interface TaskEditorProps {
  /** a top-level card, with its subtasks */
  task: Task;
  columns: TaskColumn[];
  /** the project's epics, default first */
  epics: Task[];
  terminalHref: string | null;
  /** the project's open terminal tabs the card can be linked to (an agent started by hand) */
  linkableTabs: LinkableTab[];
  onClose: () => void;
  onSave: (patch: TaskPatchInput) => void;
  onPlace: (target: PlaceTarget) => void;
  onDelete: () => void;
  onOpenTerminal: () => void;
  onLinkTab: (tabId: string) => void;
  onDetachTerminal: () => void;
  onPushStatus: () => Promise<string | null>;
  onSubtasks: (subtasks: Task[] | ((prev: Task[]) => Task[])) => void;
  onError: (message: string) => void;
}

/** A card's editor (spec §7 "Card editor"): title, type, epic, column, description, subtasks, link. */
export function TaskEditor({
  task,
  columns,
  epics,
  terminalHref,
  linkableTabs,
  onClose,
  onSave,
  onPlace,
  onDelete,
  onOpenTerminal,
  onLinkTab,
  onDetachTerminal,
  onPushStatus,
  onSubtasks,
  onError,
}: TaskEditorProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [type, setType] = useState<TaskType>(task.type);
  const [epicId, setEpicId] = useState(task.epic_id ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pushing, setPushing] = useState<'idle' | 'busy' | string>('idle');
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [tabToLink, setTabToLink] = useState('');
  const ref = task.external_ref;
  const types = typeOptions(task);

  const save = () => {
    const patch: TaskPatchInput = {};
    if (title.trim() && title.trim() !== task.title) patch.title = title.trim();
    if ((description.trim() || null) !== (task.description ?? null)) patch.description = description.trim() || null;
    if (type !== task.type) patch.type = type;
    if (task.type !== 'epic' && epicId && epicId !== task.epic_id) patch.epic_id = epicId;
    if (Object.keys(patch).length) onSave(patch);
    onClose();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${cardPath(task.ref)}`);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  return (
    <Modal title={task.ref} open onClose={onClose} width="max-w-lg">
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="card-title">
            Título
          </label>
          <input id="card-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="label" htmlFor="card-type">
              Tipo
            </label>
            <select id="card-type" className="input" value={type} disabled={types.length === 1} onChange={(e) => setType(e.target.value as TaskType)}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {TASK_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          {task.type !== 'epic' && (
            <div>
              <label className="label" htmlFor="card-epic">
                Épico
              </label>
              <select id="card-epic" className="input" value={epicId} onChange={(e) => setEpicId(e.target.value)}>
                {epics.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.ref} {e.title}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="card-column">
              Coluna
            </label>
            <select
              id="card-column"
              className="input"
              value={task.column_id ?? ''}
              onChange={(e) => onPlace(e.target.value ? { column_id: e.target.value } : { status: 'backlog' })}
            >
              <option value="">Backlog</option>
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="card-description">
            Descrição
          </label>
          <textarea
            id="card-description"
            className="input min-h-[120px] font-mono text-xs"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Detalhes, links, contexto…"
          />
        </div>
        {canHaveSubtasks(task) && <SubtaskList parent={task} onChange={onSubtasks} onError={onError} />}
        <CardPullRequests taskId={task.id} />
        {ref && (
          <div className="rounded-md border border-line bg-bg p-3 text-xs">
            <div className="flex items-center gap-2">
              <a href={ref.url} target="_blank" rel="noreferrer" className="rounded bg-accent/15 px-1 font-mono text-accent hover:bg-accent/25">
                {ticketKey(ref)}
              </a>
              <span className="text-fg-muted">
                {PROVIDER_LABEL[ref.provider]}: <strong className="text-fg">{ref.state}</strong>
              </span>
              {ref.status !== task.status && <span className="text-warn">≠ {TASK_STATUS_LABEL[task.status]} aqui</span>}
              <button
                type="button"
                className="btn-ghost ml-auto border border-line px-2 py-0.5 text-[11px]"
                disabled={pushing === 'busy'}
                onClick={async () => {
                  setPushing('busy');
                  const st = await onPushStatus();
                  setPushing(st ? `atualizado: ${st}` : 'idle');
                }}
                title="Muda o estado no provedor para refletir a coluna atual. Nada é enviado sem este clique."
              >
                {pushing === 'busy' ? 'atualizando…' : `Atualizar no ${PROVIDER_LABEL[ref.provider]}`}
              </button>
            </div>
            {pushing !== 'idle' && pushing !== 'busy' && <p className="mt-1 text-ok">{pushing}</p>}
            {ref.pushed_at && <p className="mt-1 text-fg-dim">último envio: {formatDateTime(ref.pushed_at)}</p>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {terminalHref ? (
            <>
              <Link to={terminalHref} className="btn-ghost border border-line text-ok">
                ▮_ Ir para o terminal
              </Link>
              <button type="button" className="btn-ghost" aria-label="Desligar a aba deste card" title="A aba continua aberta; só deixa de estar ligada ao card" onClick={onDetachTerminal}>
                desligar
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn-ghost border border-line" onClick={onOpenTerminal}>
                ▮_ Abrir terminal para esta task
              </button>
              {linkableTabs.length > 0 && (
                <>
                  <select className="input w-auto py-1 text-xs" aria-label="Ligar a uma aba aberta" value={tabToLink} onChange={(e) => setTabToLink(e.target.value)}>
                    <option value="">Ligar a uma aba aberta…</option>
                    {linkableTabs.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} · {t.machine_name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn-ghost border border-line" disabled={!tabToLink} onClick={() => onLinkTab(tabToLink)}>
                    Ligar
                  </button>
                </>
              )}
            </>
          )}
          <span className="text-fg-dim">a tab fica ligada ao card e aparece nele</span>
        </div>
        <div className="flex items-center justify-between gap-2 pt-2 text-xs text-fg-dim">
          <span className="flex items-center gap-2">
            criado em {formatDate(task.created_at)}
            <button type="button" className="btn-ghost border border-line px-2 py-0.5 text-[11px]" onClick={() => void copyLink()}>
              {copied === 'ok' ? 'Link copiado' : 'Copiar link'}
            </button>
            {copied === 'fail' && <span className="text-danger">não deu para copiar</span>}
          </span>
          <div className="flex gap-2">
            {confirmDelete ? (
              <>
                <span className="self-center">{(task.subtasks?.length ?? 0) > 0 ? `Excluir com ${task.subtasks!.length} subtarefa(s)?` : 'Excluir?'}</span>
                <button className="btn-danger" onClick={onDelete}>
                  Sim, excluir
                </button>
                <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
                  Não
                </button>
              </>
            ) : (
              <button className="btn-ghost text-danger" onClick={() => setConfirmDelete(true)}>
                Excluir
              </button>
            )}
            <button className="btn-primary" onClick={save}>
              Salvar
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
