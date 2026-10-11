import { useEffect, useState, type FormEvent } from 'react';
import { useData } from '../lib/data';
import { machineLabel } from '../lib/machine-labels';
import { ApiError } from '../lib/api';
import type { Project, ProjectMachineLink } from '../lib/types';
import { ConfirmDialog } from './Modal';
import { DirectoryBrowser } from './DirectoryBrowser';
import { Trans, useTranslation } from '../i18n';

function LinkRow({ project, link, onUnlinked }: { project: Project; link: ProjectMachineLink; onUnlinked: (closed: number) => void }) {
  const { machines, statuses, updateProjectMachine, unlinkMachine } = useData();
  const { t } = useTranslation();
  const machine = machines.find((m) => m.id === link.machine_id);
  const status = statuses[link.machine_id] ?? 'checking';
  const [cwd, setCwd] = useState(link.cwd);
  const [createDir, setCreateDir] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = cwd !== link.cwd;

  // Resyncs the local draft when the link's cwd changes from outside (e.g. another browser tab): the
  // row is keyed on machine_id alone (not machine_id+cwd) precisely so a *self*-triggered save does
  // not remount it and lose the "Salvo." message just set below — this effect is a no-op in that
  // case, since `cwd` already equals the newly saved `link.cwd`.
  useEffect(() => {
    setCwd(link.cwd);
  }, [link.cwd]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await updateProjectMachine(project.id, link.machine_id, cwd, createDir);
      setMsg({ ok: true, text: t('Salvo.') });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : t('Erro ao salvar') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-line p-3">
      <form onSubmit={save} className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <span className={`h-2 w-2 shrink-0 rounded-full ${status === 'online' ? 'bg-ok' : status === 'offline' ? 'bg-danger' : 'bg-warn animate-pulse'}`} title={status} />
          <span className="font-medium">{machine?.name ?? link.machine_id}</span>
          <button type="button" className="ml-auto text-xs text-fg-dim hover:text-danger" onClick={() => setConfirm(true)}>
            {t('Desvincular')}
          </button>
        </div>
        <div className="flex gap-2">
          <input className="input font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required aria-label={t('Diretório em {{machine}}', { machine: machine?.name ?? link.machine_id })} />
          <button type="button" className="btn-ghost shrink-0 border border-line" onClick={() => setBrowsing((b) => !b)} title={t('Listar discos e pastas da máquina')}>
            {browsing ? t('Ocultar') : t('Procurar…')}
          </button>
          <button type="submit" className="btn-primary shrink-0" disabled={busy || !dirty}>
            {t('Salvar')}
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={createDir} onChange={(e) => setCreateDir(e.target.checked)} /> {t('criar a pasta na máquina se não existir')}
        </label>
        {browsing && (
          <DirectoryBrowser machineId={link.machine_id} initialPath={cwd} onSelect={(p) => { setCwd(p); setBrowsing(false); }} onClose={() => setBrowsing(false)} />
        )}
        {msg && <p className={`text-xs ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</p>}
        <p className="text-xs text-fg-dim">{t('Vale para novas sessões tmux; tabs já abertas continuam onde estão.')}</p>
      </form>
      <ConfirmDialog
        open={confirm}
        title={t('Desvincular máquina')}
        message={
          <Trans
            i18nKey="Desvincular <0>{{machine}}</0> de <1>{{project}}</1>? As tabs deste projeto abertas nela serão fechadas. Nada é apagado na máquina."
            values={{ machine: machine?.name ?? '', project: project.name }}
            components={[<strong key="m" />, <strong key="p" />]}
          />
        }
        confirmLabel={t('Desvincular')}
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          if (busy) return;
          setBusy(true);
          try {
            // unlinkMachine removes the link from project.machines, so this row unmounts on the
            // parent's next render: any state set here would be dropped with it. The notice lives
            // in ProjectMachines instead, past the row's lifetime.
            const closed = await unlinkMachine(project.id, link.machine_id);
            onUnlinked(closed);
          } catch (err) {
            setMsg({ ok: false, text: err instanceof ApiError ? err.message : t('Erro ao desvincular') });
          } finally {
            setBusy(false);
            setConfirm(false);
          }
        }}
      />
    </li>
  );
}

/** Setup → Máquinas: where the project's terminals run, one directory per machine. */
export function ProjectMachines({ project }: { project: Project }) {
  const { machines, linkMachine } = useData();
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [machineId, setMachineId] = useState('');
  const [cwd, setCwd] = useState('');
  const [createDir, setCreateDir] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const available = machines.filter((m) => !project.machines.some((l) => l.machine_id === m.id));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await linkMachine(project.id, { machine_id: machineId, cwd, create_dir: createDir });
      setAdding(false);
      setMachineId('');
      setCwd('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao vincular'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-8 space-y-3 rounded-lg border border-line bg-bg-2 p-4">
      <h3 className="text-sm font-semibold">{t('Máquinas')}</h3>
      {project.machines.length === 0 && <p className="text-xs text-fg-muted">{t('Nenhuma máquina vinculada: o projeto tem quadro e notas, mas nenhum terminal.')}</p>}
      <ul className="space-y-2">
        {project.machines.map((l) => (
          <LinkRow
            // Keyed on machine_id alone: keying on cwd too would remount the row on its own
            // successful save (updateProjectMachine updates the link's cwd right after), losing the
            // "Salvo." message just set. LinkRow's own effect resyncs `cwd` on an external change.
            key={l.machine_id}
            project={project}
            link={l}
            onUnlinked={(closed) => setNotice(t('{{count}} tabs fechadas.', { count: closed }))}
          />
        ))}
      </ul>
      {notice && <p className="text-xs text-ok">{notice}</p>}
      {!adding ? (
        <button type="button" className="btn-ghost border border-line" onClick={() => setAdding(true)} disabled={available.length === 0}>
          {t('Vincular máquina')}
        </button>
      ) : (
        <form onSubmit={add} className="space-y-2 rounded-lg border border-dashed border-line p-3">
          <div>
            <label className="label" htmlFor="link-machine">
              {t('Máquina')}
            </label>
            <select id="link-machine" className="input" value={machineId} onChange={(e) => setMachineId(e.target.value)} required>
              <option value="">{t('Escolha…')}</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>{machineLabel(m)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="link-cwd">
              {t('Diretório')}
            </label>
            <div className="flex gap-2">
              <input id="link-cwd" className="input font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder={t('/home/pedro/projetos/meu-app')} />
              <button type="button" className="btn-ghost shrink-0 border border-line" onClick={() => setBrowsing((b) => !b)} disabled={!machineId}>
                {browsing ? t('Ocultar') : t('Procurar…')}
              </button>
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
              <input type="checkbox" checked={createDir} onChange={(e) => setCreateDir(e.target.checked)} /> {t('criar a pasta na máquina se não existir')}
            </label>
            {browsing && machineId && (
              <DirectoryBrowser machineId={machineId} initialPath={cwd} onSelect={(p) => { setCwd(p); setBrowsing(false); }} onClose={() => setBrowsing(false)} />
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={busy || !machineId || !cwd.trim()}>
              {t('Vincular')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
              {t('Cancelar')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
