import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../lib/data';
import { ApiError } from '../lib/api';
import type { Project, ProjectStatus } from '../lib/types';
import { projectStatusLabel } from '../lib/board';
import { Trans, useTranslation } from '../i18n';
import { ConfirmDialog } from './Modal';
import { SetupForm } from './SetupForm';
import { ProjectMachines } from './ProjectMachines';
import { BoardColumnsSettings } from './BoardColumnsSettings';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'archived'];

export function ProjectSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const { updateProject, deleteProject } = useData();
  const navigate = useNavigate();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const dirty = name !== project.name || (description || null) !== (project.description ?? null) || status !== project.status;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await updateProject(project.id, { name, description: description || null, status });
      setMsg({ ok: true, text: t('Salvo.') });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : t('Erro ao salvar') });
    } finally {
      setBusy(false);
    }
  };

  return (
    // sem padding inferior: a barra sticky do SetupForm cola no fundo real da área de rolagem e leva o espaçamento
    <div className="h-full overflow-y-auto p-6 pb-0">
      <form onSubmit={submit} className="mb-8 space-y-4 rounded-lg border border-line bg-bg-2 p-4">
        <h3 className="text-sm font-semibold">{t('Geral')}</h3>
        <div>
          <label className="label">{t('Nome')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="label">{t('Chave')}</label>
          <p className="font-mono text-sm">{project.key}</p>
          <p className="mt-1 text-xs text-fg-dim">{t('Usada nas URLs e nos números dos cards; não muda.')}</p>
        </div>
        <div>
          <label className="label">{t('Descrição')}</label>
          <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className="label">{t('Status')}</label>
          <div className="flex gap-2">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={`btn flex-1 border ${status === s ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:bg-bg-3'}`}
              >
                {projectStatusLabel(s)}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-fg-dim">{t('Só projetos ativos aparecem no dashboard; arquivados ficam ocultos na sidebar.')}</p>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={busy || !dirty}>
            {t('Salvar')}
          </button>
          {msg && <span className={`text-sm ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</span>}
        </div>
      </form>

      <ProjectMachines project={project} />

      <BoardColumnsSettings project={project} />

      <SetupForm project={project} />

      <div className="mt-10 rounded-lg border border-danger/30 p-4">
        <h3 className="text-sm font-semibold text-danger">{t('Excluir projeto')}</h3>
        <p className="mt-1 text-xs text-fg-muted">
          {t('Remove o projeto, suas tasks, notas e tickets, e encerra as sessões tmux das tabs nas máquinas vinculadas. Não apaga arquivos.')}
        </p>
        <button className="btn-danger mt-3" onClick={() => setConfirm(true)}>
          {t('Excluir projeto')}
        </button>
      </div>

      <ConfirmDialog
        open={confirm}
        title={t('Excluir projeto')}
        message={
          <Trans
            i18nKey="Excluir <0>{{name}}</0>? As sessões tmux das tabs serão encerradas."
            values={{ name: project.name }}
            components={[<strong key="n" />]}
          />
        }
        confirmLabel={t('Excluir')}
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            await deleteProject(project.id);
            navigate('/');
          } catch (err) {
            setConfirm(false);
            setMsg({ ok: false, text: err instanceof ApiError ? err.message : t('Erro ao excluir') });
          }
        }}
      />
    </div>
  );
}
