import { useTranslation } from '@/i18n';
import { Button, Sheet } from '@/ui';

/** The long press on a project row (TER-541): the pin's one action, as a sheet. */
export function FavoriteSheet({ project, onClose, onToggle }: { project: { id: string; name: string; pinned: boolean } | null; onClose(): void; onToggle(): void }) {
  const { t } = useTranslation();
  return (
    <Sheet open={project !== null} onClose={onClose} title={project?.name ?? ''}>
      {project ? (
        <Button
          label={project.pinned ? t('Tirar de Favoritos') : t('Fixar em Favoritos')}
          variant="secondary"
          onPress={() => {
            onToggle();
            onClose();
          }}
        />
      ) : null}
    </Sheet>
  );
}
