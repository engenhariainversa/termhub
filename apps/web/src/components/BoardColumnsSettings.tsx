import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { COLUMN_CATEGORY_LABEL, type ColumnCategory, type Project, type TaskColumn } from '../lib/types';
import { ConfirmDialog } from './Modal';

const CATEGORIES: ColumnCategory[] = ['todo', 'doing', 'done'];
const MAX_COLUMNS = 12;
const LOCKED = 'O board precisa de ao menos uma coluna de cada tipo';

/** Setup → "Colunas do board" (spec §7): names, categories, order, deletion and the agent column. */
export function BoardColumnsSettings({ project }: { project: Project }) {
  const [columns, setColumns] = useState<TaskColumn[] | null>(null);
  const [agentColumnId, setAgentColumnId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TaskColumn | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftCategory, setDraftCategory] = useState<ColumnCategory>('todo');

  const load = useCallback(async () => {
    try {
      const r = await api.tasks.list(project.id);
      setColumns([...r.columns].sort((a, b) => a.position - b.position));
      setAgentColumnId(r.agent_column_id);
      const c: Record<string, number> = {};
      for (const t of r.tasks) if (t.column_id && !t.parent_id) c[t.column_id] = (c[t.column_id] ?? 0) + 1;
      setCounts(c);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar as colunas');
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every change goes to the server, then the block reloads (the server keeps the rules). */
  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : fallback);
    }
    await load();
  };

  if (!columns) {
    return <section className="mb-8 rounded-lg border border-line bg-bg-2 p-4 text-sm text-fg-dim">{error ?? 'Carregando colunas…'}</section>;
  }

  const lastOfCategory = (c: TaskColumn) => columns.filter((x) => x.category === c.category).length === 1;
  const destination = (c: TaskColumn) => columns.find((x) => x.category === c.category && x.id !== c.id);
  const moving = deleting ? (counts[deleting.id] ?? 0) : 0;

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    setDraftName('');
    void run(() => api.columns.create(project.id, { name, category: draftCategory }), 'Erro ao criar a coluna');
  };

  return (
    <section aria-label="Colunas do board" className="mb-8 space-y-3 rounded-lg border border-line bg-bg-2 p-4">
      <h3 className="text-sm font-semibold">Colunas do board</h3>
      <p className="text-xs text-fg-dim">
        O nome é seu; o tipo diz ao termhub o que a coluna significa. O board precisa de ao menos uma coluna de cada tipo e aceita até 12.
      </p>
      {error && <p className="text-xs text-danger">{error}</p>}
      <ul className="space-y-2">
        {columns.map((c, i) => (
          <ColumnRow
            key={c.id}
            column={c}
            index={i}
            last={i === columns.length - 1}
            locked={lastOfCategory(c)}
            onRename={(name) => void run(() => api.columns.update(c.id, { name }), 'Erro ao renomear a coluna')}
            onCategory={(category) => void run(() => api.columns.update(c.id, { category }), 'Erro ao mudar o tipo da coluna')}
            onMove={(position) => void run(() => api.columns.move(c.id, position), 'Erro ao mover a coluna')}
            onDelete={() => setDeleting(c)}
          />
        ))}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <input className="input" aria-label="Nome da nova coluna" placeholder="Nome da coluna" maxLength={40} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        <select className="input w-auto" aria-label="Tipo da nova coluna" value={draftCategory} onChange={(e) => setDraftCategory(e.target.value as ColumnCategory)}>
          {CATEGORIES.map((k) => (
            <option key={k} value={k}>
              {COLUMN_CATEGORY_LABEL[k]}
            </option>
          ))}
        </select>
        <button type="submit" className="btn-primary shrink-0" disabled={columns.length >= MAX_COLUMNS}>
          + coluna
        </button>
      </form>
      <div>
        <label className="label" htmlFor="agent-column">
          Coluna do agente
        </label>
        <select
          id="agent-column"
          className="input"
          value={agentColumnId ?? ''}
          onChange={(e) => {
            const columnId = e.target.value || null;
            void run(() => api.columns.setAgent(project.id, columnId), 'Erro ao salvar a coluna do agente');
          }}
        >
          <option value="">Automática (primeira Fazendo)</option>
          {columns
            .filter((c) => c.category === 'doing')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <p className="mt-1 text-xs text-fg-dim">Para onde o card vai quando um agente começa a trabalhar nele.</p>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        title="Excluir coluna"
        message={
          deleting ? (
            <>
              Excluir <strong>{deleting.name}</strong>?{' '}
              {moving > 0 ? `${moving === 1 ? '1 card vai' : `${moving} cards vão`} para "${destination(deleting)?.name ?? ''}".` : 'Ela está vazia.'}
            </>
          ) : null
        }
        confirmLabel="Excluir"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const c = deleting;
          setDeleting(null);
          if (c) await run(() => api.columns.remove(c.id), 'Erro ao excluir a coluna');
        }}
      />
    </section>
  );
}

interface RowProps {
  column: TaskColumn;
  index: number;
  last: boolean;
  /** the only column of its category: its category cannot change and it cannot go */
  locked: boolean;
  onRename: (name: string) => void;
  onCategory: (category: ColumnCategory) => void;
  onMove: (position: number) => void;
  onDelete: () => void;
}

function ColumnRow({ column, index, last, locked, onRename, onCategory, onMove, onDelete }: RowProps) {
  const [name, setName] = useState(column.name);
  // Follows a rename from outside, adjusted while rendering: as an effect it ran a moment after the row
  // appeared and reset whatever had been typed in between (TER-911).
  const [shownName, setShownName] = useState(column.name);
  if (shownName !== column.name) {
    setShownName(column.name);
    setName(column.name);
  }

  const commit = () => {
    const v = name.trim();
    if (v && v !== column.name) onRename(v);
    else setName(column.name);
  };

  return (
    <li className="flex items-center gap-2">
      <input
        className="input"
        aria-label={`Nome da coluna ${column.name}`}
        maxLength={40}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setName(column.name);
        }}
      />
      <select
        className="input w-auto"
        aria-label={`Tipo da coluna ${column.name}`}
        value={column.category}
        disabled={locked}
        title={locked ? LOCKED : undefined}
        onChange={(e) => onCategory(e.target.value as ColumnCategory)}
      >
        {CATEGORIES.map((k) => (
          <option key={k} value={k}>
            {COLUMN_CATEGORY_LABEL[k]}
          </option>
        ))}
      </select>
      <button type="button" className="btn-ghost px-2" aria-label={`Subir ${column.name}`} disabled={index === 0} onClick={() => onMove(index - 1)}>
        ↑
      </button>
      <button type="button" className="btn-ghost px-2" aria-label={`Descer ${column.name}`} disabled={last} onClick={() => onMove(index + 1)}>
        ↓
      </button>
      <button type="button" className="btn-ghost px-2 text-danger" aria-label={`Excluir ${column.name}`} disabled={locked} title={locked ? LOCKED : undefined} onClick={onDelete}>
        ✕
      </button>
    </li>
  );
}
