import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { ApiError } from '../lib/api';
import type { Project } from '../lib/types';
import { NicknameDialog } from './NicknameDialog';
import { useTranslation } from '../i18n';

/**
 * Publishes the project on its owner's public city: one building, whose robots are the project's
 * agents (tabs) on the machines the owner owns — an agent on somebody else's machine never shows,
 * and no machine is named at all (city-by-project §2.4). Publishing is a one-way disclosure — it
 * makes readable, to anyone with the link, the project's name, each of those agents with what it is
 * doing, and the owner's display name and nickname — so turning it ON asks for a separate
 * confirmation, spelling that out; turning it back OFF does not, since there is nothing new to warn
 * about. The server is the only source of truth for whether this is allowed (project owner,
 * nickname claimed): this component reacts to its 403/409 codes and never re-implements those rules.
 */
export function PublishControl({ project }: { project: Project }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { updateProject } = useData();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsNickname, setNeedsNickname] = useState(false);

  const publish = async (next: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await updateProject(project.id, { is_public: next });
      setConfirming(false);
    } catch (err) {
      const code = (err as { code?: string } | null | undefined)?.code;
      if (code === 'NICKNAME_REQUIRED') setNeedsNickname(true);
      else setError(err instanceof ApiError ? err.message : next ? t('Erro ao publicar') : t('Erro ao despublicar'));
    } finally {
      setBusy(false);
    }
  };

  // The client-side nickname check lives only here, never inside `publish` itself: `publish` is also
  // what the nickname dialog's own `onSaved` retries right after claiming one, and by then `user` may
  // still be the stale, pre-update value from the render that opened the dialog — checking it there
  // again would risk bouncing straight back to the dialog it just closed.
  const confirmPublish = () => {
    if (!user?.nickname) {
      setNeedsNickname(true);
      return;
    }
    void publish(true);
  };

  const onToggle = () => {
    setError(null);
    if (project.is_public) void publish(false);
    else setConfirming((c) => !c);
  };

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        role="switch"
        // Reflects only the persisted value, never the confirm panel being open: a screen reader must
        // hear "off" for exactly as long as the switch has not actually flipped, same as the visible
        // knob below (which was already gated on `project.is_public` alone).
        aria-checked={project.is_public}
        aria-label={t('Publicar')}
        title={project.is_public ? t('Deixar de publicar') : t('Publicar na cidade pública')}
        disabled={busy}
        onClick={onToggle}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${project.is_public ? 'bg-accent' : 'bg-fg-dim/40'}`}
      >
        <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform ${project.is_public ? 'translate-x-[18px] bg-white' : 'translate-x-0.5 bg-fg-muted'}`} />
      </button>
      {confirming && (
        <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-lg border border-line bg-bg-2 p-3 text-xs shadow-lg">
          <p className="text-fg-muted">
            {t('Publicar deixa visível, para quem tiver o link, o nome do projeto e cada agente (aba) dele que roda nas suas máquinas, com o que cada um está fazendo, além do seu nome e apelido.')}
          </p>
          <p className="mt-2 text-fg-muted">{t('Agentes em máquinas de outras pessoas não aparecem.')}</p>
          {error && <p className="mt-2 text-danger">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              {t('Cancelar')}
            </button>
            <button type="button" className="btn-primary" disabled={busy} onClick={confirmPublish}>
              {t('Publicar')}
            </button>
          </div>
        </div>
      )}
      {/* The unpublish path bypasses the panel above entirely, so its failure (an expired session, a
          500, a dropped connection — the server does not guard off→on) needs somewhere to be seen too;
          without this the switch just did not move and said nothing. */}
      {!confirming && error && (
        <div className="absolute right-0 top-full z-10 mt-2 w-56 rounded-lg border border-danger/40 bg-bg-2 p-2 text-xs text-danger shadow-lg">
          {error}
        </div>
      )}
      <NicknameDialog
        open={needsNickname}
        onClose={() => setNeedsNickname(false)}
        onSaved={() => {
          setNeedsNickname(false);
          void publish(true);
        }}
      />
    </div>
  );
}
