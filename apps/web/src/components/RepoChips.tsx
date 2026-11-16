import { useTranslation } from '../i18n';

/** TER-1069: one small chip per repository key the card touches. Nothing for `[]` (a single-repo project's cards). */
export function RepoChips({ keys, className = '' }: { keys: string[] | undefined; className?: string }) {
  const { t } = useTranslation();
  if (!keys || keys.length === 0) return null;
  return (
    <ul className={`flex flex-wrap gap-1 ${className}`} aria-label={t('Repositórios')}>
      {keys.map((key) => (
        <li key={key} className="max-w-[10rem] truncate rounded bg-bg-4 px-1 font-mono text-[10px] text-fg-muted" title={t('Repositório: {{key}}', { key })}>
          {key}
        </li>
      ))}
    </ul>
  );
}
