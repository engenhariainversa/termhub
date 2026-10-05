import { useTranslation } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { useProjectChat } from '../../lib/project-chat';

/**
 * The project header's 💬 (spec 2026-09-26 project chat dock §4.7): opens or closes this project's
 * docked chat. Same dot as the sidebar's: pulsing while it answers, attention while something waits
 * on the person.
 */
export function ChatToggleButton({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { pref, toggle, status } = useProjectChat();
  if (!can('chat')) return null;
  const open = pref(projectId).open;
  const s = status(projectId);
  const active = s.busy || s.pending > 0;
  return (
    <button
      type="button"
      aria-label={t('Chat do projeto')}
      aria-pressed={open}
      title={s.pending > 0 ? t('Chat do projeto — esperando sua confirmação') : s.busy ? t('Chat do projeto — respondendo') : t('Chat do projeto')}
      className={`relative rounded px-2 py-1 text-sm hover:bg-bg-3 ${open ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:text-fg'}`}
      onClick={() => toggle(projectId)}
    >
      💬
      {active && <span className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${s.pending > 0 ? 'bg-attention' : 'animate-pulse bg-accent'}`} />}
    </button>
  );
}
