import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { FullScreenMessage } from '../components/Layout';
import { ProjectPage } from './ProjectPage';
import { useTranslation } from '../i18n';

type Resolved = { projectId: string; taskId: string } | 'missing' | 'error' | null;

/**
 * `/project/TER-12` (spec §7): resolves the ref, then shows the card's project on its Board with the
 * editor open. A subtask's ref opens its parent card (subtasks live in the parent's checklist).
 * The last resolved card stays on screen while the next ref loads, so moving between cards does not
 * remount the board.
 */
export function CardPage() {
  const { t } = useTranslation();
  const { ref = '' } = useParams<{ ref: string }>();
  const [card, setCard] = useState<Resolved>(null);

  useEffect(() => {
    let alive = true;
    api.tasks.byRef(ref).then(
      ({ task, project_id }) => {
        if (alive) setCard({ projectId: project_id, taskId: task.parent_id ?? task.id });
      },
      (e: unknown) => {
        if (alive) setCard(e instanceof ApiError && e.status === 404 ? 'missing' : 'error');
      },
    );
    return () => {
      alive = false;
    };
  }, [ref]);

  if (card === null) return <FullScreenMessage>{t('Carregando…')}</FullScreenMessage>;
  if (card === 'missing') return <FullScreenMessage>{t('Card não encontrado')}</FullScreenMessage>;
  if (card === 'error') return <FullScreenMessage>{t('Erro ao abrir o card')}</FullScreenMessage>;
  return <ProjectPage card={card} />;
}
