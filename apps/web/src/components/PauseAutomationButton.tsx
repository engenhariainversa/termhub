import { useState } from 'react';
import { pauseClock, pauseControlsVisible, pausedSince, useAutomationPause } from '../lib/automation-pause';
import { useAuth } from '../lib/auth';
import { DropdownMenu } from './DropdownMenu';

/**
 * "Pausar tudo" (agentic board, TER-942): one switch for all of the person's automatic work. While paused
 * nothing is started, typed, answered or merged. Shown to whoever may update projects (the server's rule too).
 */
export function PauseAutomationButton() {
  const { can } = useAuth();
  const { state, pause, resume } = useAutomationPause();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can('projects', 'update') || !pauseControlsVisible(state)) return null;
  const paused = state?.paused_at != null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível mudar o automático.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        aria-pressed={paused}
        className={paused ? 'rounded bg-warn px-2 py-0.5 text-xs font-medium text-black' : 'btn-ghost px-2 py-0.5 text-xs'}
        onClick={() => void run(() => (paused ? resume('all') : pause('all')))}
      >
        {paused ? 'Retomar automático' : 'Pausar automático'}
      </button>
      {!paused && <DropdownMenu label="▾" title="Mais opções" items={[{ kind: 'item', label: 'Pausar e interromper as abas', disabled: busy, onSelect: () => void run(() => pause('all', true)) }]} />}
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

/** "Automático pausado desde 10:42." while the person's work, or this project's, is paused. */
export function PauseBanner({ projectId }: { projectId?: string }) {
  const { state } = useAutomationPause();
  const since = pausedSince(state, projectId);
  if (!since) return null;
  return (
    <p role="status" className="rounded-lg border border-amber-500 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950">
      Automático pausado desde {pauseClock(since)}.
    </p>
  );
}
