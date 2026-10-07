import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { boardCardPath, cardForRef, cardPath, epicsOf, taskStatusLabel } from '../lib/board';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { renderMarkdown } from '../lib/markdown';
import { formatDateTime } from '../lib/format';
import { cardTitle, ticketKey } from '../lib/ticket-link';
import { PROVIDER_LABEL, type AutomationFeedEvent, type BoardData, type Task } from '../lib/types';
import { FullScreenMessage } from '../components/Layout';
import { PageFrame } from '../components/PageHeader';
import { TypeBadge } from '../components/TypeBadge';
import { AutomationBadge } from '../components/AutomationBadge';
import { CardPullRequests } from '../components/CardPullRequests';
import { CardUsageCost } from '../components/UsageCost';
import { AutomationFeed } from '../components/ProgressPanel';
import { useTranslation } from '../i18n';

type Loaded = { projectId: string; ref: string; board: BoardData } | 'missing' | 'error' | null;

/**
 * `/project/TER-12` (spec §7, TER-976): the card's own page, for a shared link or a new browser tab.
 * Read-only: title, rendered description, type, epic, column, subtasks, external ticket, linked tab,
 * pull requests and what the automatic work did. Editing happens on the Board (`?card=TER-12`). A
 * subtask's ref shows its parent card, as the board does.
 */
export function CardPage() {
  const { t } = useTranslation();
  const { ref = '' } = useParams<{ ref: string }>();
  const [loaded, setLoaded] = useState<Loaded>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    api.tasks
      .byRef(ref)
      .then(async ({ task, project_id }) => {
        const board = await api.tasks.list(project_id);
        if (alive) setLoaded({ projectId: project_id, ref: task.ref, board });
      })
      .catch((e: unknown) => {
        if (alive) setLoaded(e instanceof ApiError && e.status === 404 ? 'missing' : 'error');
      });
    return () => {
      alive = false;
    };
  }, [ref]);

  const card = loaded && typeof loaded === 'object' ? cardForRef(loaded.board.tasks, loaded.ref) : null;

  if (loaded === null) return <FullScreenMessage>{t('Carregando…')}</FullScreenMessage>;
  if (loaded === 'error') return <FullScreenMessage>{t('Erro ao abrir o card')}</FullScreenMessage>;
  if (loaded === 'missing' || !card) return <FullScreenMessage>{t('Card não encontrado')}</FullScreenMessage>;
  return <CardDetail key={card.id} card={card} projectId={loaded.projectId} board={loaded.board} />;
}

function CardDetail({ card, projectId, board }: { card: Task; projectId: string; board: BoardData }) {
  const { t } = useTranslation();
  const { projects } = useData();
  const { openTabs } = useMonitor();
  const project = projects.find((p) => p.id === projectId);
  const [events, setEvents] = useState<AutomationFeedEvent[]>([]);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

  useEffect(() => {
    let alive = true;
    // the page stands without it: a failed read only leaves the "Automático" section out
    api.tasks.activity(card.id).then(
      (r) => alive && setEvents(r.events),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [card.id]);

  const epic = useMemo(() => (card.epic_id ? (epicsOf(board.tasks).find((e) => e.id === card.epic_id) ?? null) : null), [board.tasks, card.epic_id]);
  const column = board.columns.find((c) => c.id === card.column_id);
  const description = useMemo(() => (card.description ? renderMarkdown(card.description) : ''), [card.description]);
  const tab = card.tab_id ? (openTabs.find((x) => x.id === card.tab_id) ?? null) : null;
  const subtasks = [...(card.subtasks ?? [])].sort((a, b) => a.position - b.position);
  const ext = card.external_ref;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${cardPath(card.ref)}`);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  return (
    <PageFrame
      title={`${card.ref} ${cardTitle(card.title, ext)}`}
      subtitle={project ? `${project.name} · ${project.key}` : undefined}
      actions={
        <>
          <button type="button" className="btn-ghost border border-line px-2 py-0.5 text-xs" onClick={() => void copyLink()}>
            {copied === 'ok' ? t('Link copiado') : t('Copiar link')}
          </button>
          <Link to={boardCardPath(projectId, card.ref)} className="btn-primary text-xs">
            {t('Abrir no board')}
          </Link>
        </>
      }
    >
      {copied === 'fail' && <p className="mb-3 text-xs text-danger">{t('não deu para copiar')}</p>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <section aria-label={t('Descrição')}>
            {description ? (
              // `renderMarkdown` sanitises; nothing else reaches this HTML
              <div className="prose-termhub max-w-3xl" dangerouslySetInnerHTML={{ __html: description }} />
            ) : (
              <p className="text-sm text-fg-dim">{t('Sem descrição.')}</p>
            )}
          </section>
          {subtasks.length > 0 && (
            <section aria-label={t('Subtarefas')} className="space-y-2">
              <h2 className="text-sm font-semibold">
                {t('Subtarefas')}{' '}
                <span className="text-xs font-normal text-fg-dim">
                  {subtasks.filter((s) => s.status === 'done').length}/{subtasks.length}
                </span>
              </h2>
              <ul className="space-y-1">
                {subtasks.map((s) => (
                  <li key={s.id} className="flex items-baseline gap-2 text-sm">
                    <span aria-hidden className={s.status === 'done' ? 'text-ok' : 'text-fg-dim'}>
                      {s.status === 'done' ? '✓' : '○'}
                    </span>
                    <span className="font-mono text-[11px] text-fg-dim">{s.ref}</span>
                    <span className={s.status === 'done' ? 'text-fg-muted line-through decoration-fg-dim' : ''}>{s.title}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <AutomationFeed feed={events} />
        </div>
        <aside className="space-y-4">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg border border-line bg-bg-2 p-3 text-sm">
            <Field label={t('Tipo')}>
              <TypeBadge type={card.type} />
            </Field>
            {card.type !== 'epic' && <Field label={t('Épico')}>{epic ? `${epic.ref} ${epic.title}` : '—'}</Field>}
            <Field label={t('Coluna')}>{column?.name ?? taskStatusLabel(card.status)}</Field>
            {card.auto && (
              <Field label={t('Trabalho automático')}>
                <AutomationBadge />
              </Field>
            )}
            {ext && (
              <Field label={t('Ticket externo')}>
                <a href={ext.url} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">
                  {ticketKey(ext)}
                </a>{' '}
                <span className="text-xs text-fg-muted">
                  {PROVIDER_LABEL[ext.provider]}: {ext.state}
                </span>
              </Field>
            )}
            <Field label={t('Terminal')}>
              {card.tab_id ? (
                <Link to={`/projects/${projectId}?tab=${card.tab_id}`} className="text-ok hover:underline">
                  {tab?.name ?? t('▮_ Ir para o terminal')}
                </Link>
              ) : (
                <span className="text-fg-dim">{t('nenhuma aba ligada')}</span>
              )}
            </Field>
            <Field label={t('Criado')}>{formatDateTime(card.created_at)}</Field>
            <Field label={t('Atualizado')}>{formatDateTime(card.updated_at)}</Field>
          </dl>
          <CardPullRequests taskId={card.id} />
          <CardUsageCost task={card} />
        </aside>
      </div>
    </PageFrame>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-dim">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
