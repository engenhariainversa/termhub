import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import type { Machine } from '../lib/types';
import { agentVersionBadge, machineTitle } from '../lib/machine-labels';
import { STATUS_DOT, STATUS_LABEL, TYPE_LABEL } from '../lib/machine-status';
import { MACHINE_FORM_TABS, MachineForm, type MachineFormTab } from '../components/MachineForm';
import { ConfirmDialog } from '../components/Modal';
import { PageFrame } from '../components/PageHeader';
import { Trans, useTranslation } from '../i18n';

/** `/machines`: every machine in the scope, with the projects it's linked to and edit/delete actions. */
export function MachinesPage() {
  const { t } = useTranslation();
  const { can, viewAs } = useAuth();
  const { machines, projects, hiddenLocal, claimLocal, statuses, missingTmux, deleteMachine, checkStatus } = useData();
  const [form, setForm] = useState<{ open: boolean; machine?: Machine | null; tab?: MachineFormTab }>({ open: false });
  const [params, setParams] = useSearchParams();
  // Direct link to a machine's form, optionally on one tab: `/machines?edit=<id>&tab=agent`.
  const editId = params.get('edit');
  useEffect(() => {
    if (!editId) return;
    const m = machines.find((x) => x.id === editId);
    if (!m) return;
    const tab = params.get('tab');
    setForm({ open: true, machine: m, tab: MACHINE_FORM_TABS.includes(tab as MachineFormTab) ? (tab as MachineFormTab) : undefined });
    setParams({}, { replace: true });
  }, [editId, machines, params, setParams]);
  const [deleting, setDeleting] = useState<Machine | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  return (
    <PageFrame
      title={t('Máquinas')}
      actions={
        can('machines', 'create') && (
          <button className="btn-primary text-xs" onClick={() => setForm({ open: true, machine: null })}>
            {t('+ máquina')}
          </button>
        )
      }
    >

      {machines.length === 0 && hiddenLocal.length === 0 && (
        <p className="text-sm text-fg-dim">{t('Nenhuma máquina cadastrada. Cadastre uma pelo botão acima ou ao criar um projeto.')}</p>
      )}

      <ul className="space-y-2">
        {machines.map((m) => {
          const status = statuses[m.id] ?? 'checking';
          const linked = projects.filter((p) => p.machines.some((l) => l.machine_id === m.id));
          const badge = agentVersionBadge(m);
          return (
            <li key={m.id} className="rounded-lg border border-line bg-bg-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
                  title={t('{{status}} — clique para verificar', { status: t(STATUS_LABEL[status]) })}
                  onClick={() => void checkStatus(m.id)}
                />
                <span className="truncate text-sm font-medium" title={machineTitle(m, status)}>
                  {m.name}
                </span>
                {m.subtitle && (
                  <span className="truncate text-xs text-fg-muted" title={m.subtitle}>
                    {m.subtitle}
                  </span>
                )}
                <span className="text-[11px] text-fg-dim">{t(TYPE_LABEL[m.type])}</span>
                {m.os && <span className="text-[11px] text-fg-dim">{m.os === 'macos' ? '' : m.os}</span>}
                {badge &&
                  (badge.outdated ? (
                    <button type="button" className="rounded px-1 text-[11px] text-warn hover:bg-bg-3" title={badge.title} onClick={() => setForm({ open: true, machine: m, tab: 'agent' })}>
                      {badge.text}
                    </button>
                  ) : (
                    <span className="text-[11px] text-fg-dim" title={badge.title}>
                      {badge.text}
                    </span>
                  ))}
                {viewAs === 'all' && (
                  <span className="truncate text-[11px] text-fg-dim" title={m.owner_name ? t('Dono: {{name}}', { name: m.owner_name }) : t('Sem dono')}>
                    {m.owner_name ?? t('sem dono')}
                  </span>
                )}
                {missingTmux[m.id] && (
                  <span className="text-[11px] text-warn" title={t('tmux não está instalado nesta máquina')}>
                    {t('sem tmux')}
                  </span>
                )}
                {m.type === 'agent' && m.hooks_installed_at === null && (
                  <button
                    type="button"
                    className="rounded px-1 text-[11px] text-warn hover:bg-bg-3"
                    title={t('Os hooks do monitor não estão instalados: as tabs desta máquina não aparecem em “Precisando de você”. Clique para instalar.')}
                    onClick={() => setForm({ open: true, machine: m, tab: 'monitor' })}
                  >
                    {t('sem monitor')}
                  </button>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                  <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" title={t('Editar')} onClick={() => setForm({ open: true, machine: m })}>
                    ✎
                  </button>
                  <button
                    className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-danger"
                    title={t('Excluir')}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(m);
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {linked.length === 0 ? (
                  <span className="text-[11px] text-fg-dim">{t('nenhum projeto')}</span>
                ) : (
                  linked.map((p) => (
                    <Link key={p.id} to={`/projects/${p.id}`} className="rounded-full bg-bg-4 px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg">
                      {p.name}
                    </Link>
                  ))
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {hiddenLocal.length > 0 && (
        <div className="mt-3 text-xs text-fg-dim">
          <p title={t('Máquinas marcadas como “o computador que estou usando” em outro navegador. Se esta for a máquina onde você está, clique para vê-la aqui.')}>
            {t('{{count}} máquinas locais de outros computadores', { count: hiddenLocal.length })}
          </p>
          <ul className="mt-0.5">
            {hiddenLocal.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <span className="truncate">{m.name}</span>
                <button className="hover:text-fg" title={t('Mostrar neste navegador (é o computador que estou usando)')} onClick={() => claimLocal(m.id)}>
                  {t('é este pc')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {form.open && <MachineForm key={form.machine?.id ?? 'new'} open onClose={() => setForm({ open: false })} machine={form.machine} initialTab={form.tab} />}

      <ConfirmDialog
        open={!!deleting}
        title={t('Excluir máquina')}
        message={
          <>
            <Trans
              i18nKey="Excluir <0>{{name}}</0>? Os projetos vinculados continuam existindo; só o vínculo e as tabs abertas nesta máquina são removidos."
              values={{ name: deleting?.name ?? '' }}
              components={[<strong key="n" />]}
            />
            {deleteError && <p className="mt-2 text-danger">{deleteError}</p>}
          </>
        }
        confirmLabel={t('Excluir')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteMachine(deleting.id);
            setDeleting(null);
          } catch (e) {
            setDeleteError((e as Error).message || t('Erro ao excluir'));
          }
        }}
      />
    </PageFrame>
  );
}
