import { useTranslation } from '../i18n';
/** "automático": the card is tagged for automatic work. A warning dot and the reason when no agent can take it yet. */
export function AutomationBadge({ reason }: { reason?: string | null }) {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded bg-accent/15 px-1 text-[10px] text-accent"
      title={reason ?? t('Trabalho automático')}
      aria-label={reason ? t('automático, ainda não elegível: {{reason}}', { reason }) : t('automático')}
    >
      {reason && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warn" />}
      {t('automático')}
    </span>
  );
}
