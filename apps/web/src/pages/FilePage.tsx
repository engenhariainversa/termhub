import { useSearchParams } from 'react-router-dom';
import { FileView } from '../components/FileView';
import { PageHeader } from '../components/PageHeader';
import { filePreviewHref } from '../lib/md-paths';
import { appNavigate } from '../lib/app-navigate';
import { useTranslation } from '../i18n';

/**
 * `/files?file=<path>`: a Markdown path linked in the account chat, which has no project and so no tab
 * bar (spec 2026-10-04 file preview D14). The file is looked for on the person's own agent machines.
 */
export function FilePage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const path = params.get('file');
  const machineId = params.get('machine');
  if (!path) return <p className="p-4 text-sm text-fg-muted">{t('Nenhum arquivo indicado.')}</p>;
  const name = path.split('/').pop() || path;
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={name} subtitle={t('Prévia de arquivo')} />
      <div className="min-h-0 flex-1">
        <FileView key={`${machineId ?? ''}:${path}`} projectId={null} path={path} machineId={machineId} active onOpenFile={(p) => appNavigate(filePreviewHref(null, p, machineId ?? undefined))} />
      </div>
    </div>
  );
}
