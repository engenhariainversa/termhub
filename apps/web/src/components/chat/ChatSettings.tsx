import { Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { Modal } from '../Modal';
import { useChatHeaderSlot } from './chat-header-slot';

/**
 * The conversation's one control in the header (TER-1039): a cog that opens its settings. Portalled
 * into the header around the panel (`ChatHeaderSlot`), or drawn in place when there is none. The dot
 * is what the old top row said at a glance: a subagent is running, or the context is filling up.
 */
export function ChatSettingsButton({ open, attention, onOpen }: { open: boolean; attention: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const slot = useChatHeaderSlot();
  const button = (
    <button
      type="button"
      className="relative rounded px-2 py-1 text-fg-dim hover:bg-bg-3 hover:text-fg"
      aria-label={t('Configurações da conversa')}
      title={t('Configurações da conversa')}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      <Settings size={16} aria-hidden />
      {attention && <span data-testid="chat-settings-attention" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />}
    </button>
  );
  if (slot) return createPortal(button, slot);
  return <div className="flex justify-end pt-2">{button}</div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-dim">{title}</h3>
      {children}
    </section>
  );
}

export interface ChatSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** The context meter and "Compactar" (TER-315), rendered by the panel that owns the numbers. */
  context: ReactNode;
  /** Where the conversation runs (`ChatHost`), when it is fine: a host in trouble stays above the thread. */
  host: ReactNode;
  /** The subagents list (`ChatSubagents`), or `null` when none ran recently. */
  subagents: ReactNode;
  activeGrantCount: number;
  activeGrantsText: string;
  /** "Nova conversa" and "Apagar conversa" are refused while an answer is written or with nothing yet. */
  canReset: boolean;
  onReset: () => void;
  onDelete: () => void;
}

/**
 * "Configurações da conversa" (TER-1039): everything that used to crowd the top of the conversation —
 * context, host, subagents, trusted tabs, memory, starting over — in one dialog. Presentational: the
 * panel owns every value and request.
 */
export function ChatSettingsDialog({ open, onClose, context, host, subagents, activeGrantCount, activeGrantsText, canReset, onReset, onDelete }: ChatSettingsDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal title={t('Configurações da conversa')} open={open} onClose={onClose}>
      <Section title={t('Contexto')}>{context}</Section>
      {/* `ChatHost` is its own "Máquina do chat" region already: a titled section around it would name it twice. */}
      {host && <div className="border-b border-line pb-3">{host}</div>}
      <Section title={t('Subagentes')}>{subagents ?? <p className="text-xs text-fg-dim">{t('Nenhum subagente rodando agora.')}</p>}</Section>
      <Section title={t('Atalhos')}>
        <div className="flex flex-wrap gap-2 text-xs">
          {/* The conversation's trusted tabs, only while any is in force (spec 2026-09-26 §4.1, §6). */}
          {activeGrantCount > 0 && (
            <Link to="/settings/chat-grants" className="btn-ghost text-xs" onClick={onClose}>
              {activeGrantsText}
            </Link>
          )}
          {/* The suggestion memory's own screen (spec 2026-09-26 §5.2): list, search, forget, switch. */}
          <Link to="/chat/memoria" className="btn-ghost text-xs" onClick={onClose}>
            {t('Memória')}
          </Link>
        </div>
      </Section>
      <Section title={t('Conversa')}>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost text-xs disabled:opacity-50" disabled={!canReset} onClick={onReset}>
            {t('Nova conversa')}
          </button>
          <button type="button" className="btn-ghost text-xs text-danger disabled:opacity-50" disabled={!canReset} onClick={onDelete}>
            {t('Apagar conversa')}
          </button>
        </div>
        {/* Which bundle this screen is running, so "it did not change on my phone" can be answered by
            reading it instead of guessing between a stale page and a fix that does not work. The
            version is what the person asked for; the commit is what actually tells two deploys apart. */}
        <p className="mt-3 font-mono text-[10px] text-fg-dim" title="build" /* i18n-ignore: a version stamp */>
          v{__APP_VERSION__} · {import.meta.env.VITE_BUILD_SHA || __BUILD_STAMP__}
        </p>
      </Section>
    </Modal>
  );
}
