import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { useAuth } from '../lib/auth';
import { Modal } from './Modal';
import { SimulatorSetupCard } from './SimulatorSetupCard';
import { AgentEnrollment } from './AgentEnrollment';
import { AgentUpdateCard } from './AgentUpdateCard';
import { NetworkCheckCard } from './NetworkCheckCard';
import { AutomationAllowedCard } from './AutomationAllowedCard';
import { AiUsageQueryCard } from './AiUsageQueryCard';
import { MonitorHooksCard, monitorHealthNote } from './MonitorHooksCard';
import { useData } from '../lib/data';
import type { Machine, User } from '../lib/types';
import { TYPE_LABEL } from '../lib/machine-status';
import { api, ApiError } from '../lib/api';
import { Trans, tk, useTranslation } from '../i18n';

/** The sections of the edit form, one tab each. */
export const MACHINE_FORM_TABS = ['general', 'agent', 'monitor', 'simulator'] as const;
export type MachineFormTab = (typeof MACHINE_FORM_TABS)[number];

const TAB_LABEL: Record<MachineFormTab, string> = {
  general: tk('Geral'),
  agent: tk('Agente'),
  monitor: tk('Monitor'),
  simulator: tk('Simulador iOS'),
};

interface Props {
  open: boolean;
  onClose: () => void;
  machine?: Machine | null;
  /** Tab the edit form opens on (a direct link, e.g. the "update available" badge → Agente). Defaults to Geral. */
  initialTab?: MachineFormTab;
}

/** Which tabs an existing machine gets: Agente only for agent machines, Simulador iOS only on a Mac with Xcode. */
export function machineFormTabs(m: Pick<Machine, 'type' | 'os' | 'capabilities'>): MachineFormTab[] {
  const tabs: MachineFormTab[] = ['general'];
  if (m.type === 'agent') tabs.push('agent');
  tabs.push('monitor');
  if ((m.os === 'macos' && m.capabilities.includes('xcodebuild')) || m.capabilities.includes('wda')) tabs.push('simulator');
  return tabs;
}

/** The warning a tab carries as a badge, so it shows without opening the tab. */
export function machineTabBadge(tab: MachineFormTab, m: Machine): { text: string; title: string; critical?: boolean } | null {
  if (tab === 'agent' && m.below_min_version) {
    return { text: tk('desatualizado'), title: tk('Agente abaixo da versão mínima do termhub — ele se atualiza quando a máquina ficar ociosa; abra a máquina para atualizar agora'), critical: true };
  }
  if (tab === 'agent' && m.update_available) {
    return { text: tk('nova versão'), title: tk('Nova versão do agente disponível — abra a máquina para atualizar') };
  }
  if (tab === 'monitor') {
    if (m.type === 'agent' && m.hooks_installed_at === null) {
      return { text: tk('não instalado'), title: tk('Os hooks do monitor não estão instalados: as tabs desta máquina não aparecem em “Precisando de você”. Clique para instalar.') };
    }
    const health = monitorHealthNote(m, !!m.hooks_installed_at);
    if (health.warn) return { text: tk('sem reportar'), title: health.text };
  }
  return null;
}

export function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost shrink-0 px-1.5 py-0.5 text-[10px]"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? t('copiado') : t('copiar')}
    </button>
  );
}

export function MachineForm({ open, onClose, machine, initialTab = 'general' }: Props) {
  const { t } = useTranslation();
  const { machines, updateMachine, refresh, claimLocal } = useData();
  const { user: me } = useAuth();
  const isAdmin = !!me?.role_info?.is_admin;
  // Owner transfer: admins editing an existing machine can hand it to another user.
  const [owners, setOwners] = useState<User[] | null>(null);
  const [ownerId, setOwnerId] = useState<string>(machine?.owner_id ?? '');
  const [name, setName] = useState(machine?.name ?? '');
  const [subtitle, setSubtitle] = useState(machine?.subtitle ?? '');
  const type = machine?.type ?? 'agent';
  const [host, setHost] = useState(machine?.host ?? '');
  const [sshUser, setSshUser] = useState(machine?.ssh_user ?? '');
  const [sshPort, setSshPort] = useState(String(machine?.ssh_port ?? 22));
  const [isLocal, setIsLocal] = useState(machine?.is_local ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  // Set once a fresh agent token is minted (new agent machine, or a token rotation): swaps the
  // form body for the enrollment steps. The token is shown only this once.
  const [enrollment, setEnrollment] = useState<{ machine: Machine; token: string } | null>(null);

  // `machine` is the snapshot taken when the modal opened; tabs and badges follow the live row
  // (capabilities, update_available and hooks change with the status loop).
  const live = (machine && machines?.find((m) => m.id === machine.id)) || machine;
  const tabs = live ? machineFormTabs(live) : [];
  const [tab, setTab] = useState<MachineFormTab>(tabs.includes(initialTab) ? initialTab : 'general');
  const current = tabs.includes(tab) ? tab : 'general';
  const tabRefs = useRef<Partial<Record<MachineFormTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (!isAdmin || !machine) return;
    api.users
      .list()
      .then((r) => setOwners(r.users))
      .catch(() => setOwners(null));
  }, [isAdmin, machine]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!machine) {
        // Bypass the data context here: we need the one-time `agent_token` from the raw
        // response, not just the created Machine it returns.
        const res = await api.machines.create({ name, subtitle: subtitle.trim() || null, type: 'agent', is_local: isLocal });
        if (res.machine.is_local) claimLocal(res.machine.id);
        await refresh();
        if (res.agent_token) setEnrollment({ machine: res.machine, token: res.agent_token });
        else onClose();
        return;
      }
      const input: Partial<Machine> = {
        name,
        subtitle: subtitle.trim() || null,
        type,
        host: type === 'ssh' ? host : null,
        ssh_user: type === 'ssh' ? sshUser || null : null,
        ssh_port: type === 'ssh' ? Number(sshPort) || 22 : 22,
        is_local: type === 'agent' && isLocal,
      };
      if (isAdmin && owners && (ownerId || null) !== machine.owner_id) input.owner_id = ownerId || null;
      await updateMachine(machine.id, input);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao salvar'));
    } finally {
      setBusy(false);
    }
  };

  // Every required field lives in Geral: saving from another tab with one of them empty would hit a
  // hidden control the browser cannot point at, so show Geral first and let the validation bubble land.
  const revealInvalid = (e: MouseEvent<HTMLButtonElement>) => {
    const form = e.currentTarget.form;
    if (current !== 'general' && form && !form.checkValidity()) flushSync(() => setTab('general'));
  };

  const rotateToken = async () => {
    if (!machine) return;
    if (!window.confirm(t('Parear de novo? O acesso atual do agente é revogado e ele será desconectado.'))) return;
    setRotating(true);
    setError(null);
    try {
      const { agent_token } = await api.machines.rotateAgentToken(machine.id);
      setEnrollment({ machine, token: agent_token });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao gerar token'));
    } finally {
      setRotating(false);
    }
  };

  // WAI-ARIA tabs: arrows move between tabs (and select them), Home/End jump to the ends.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.indexOf(current);
    const next =
      e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  // Stable across re-renders (MachineForm re-renders on every DataContext change, e.g. the
  // 30 s status loop): a new function identity on each render would retrigger AgentEnrollment's
  // polling effect and restart its interval.
  const onConnectedEnrolled = useCallback(() => void refresh(), [refresh]);

  if (enrollment) {
    return (
      <Modal title={enrollment.machine.name} open={open} onClose={onClose}>
        <div className="space-y-3">
          <AgentEnrollment machine={enrollment.machine} token={enrollment.token} onConnected={onConnectedEnrolled} />
          <div className="flex justify-end pt-2">
            <button type="button" className="btn-primary" onClick={onClose}>
              {t('Fechar')}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const general = (
    <>
      <div>
        <label className="label" htmlFor="machine-name">
          {t('Nome')}
        </label>
        <input
          id="machine-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus={current === 'general'}
          placeholder={t('ex.: meu notebook')}
        />
      </div>
      <div>
        <label className="label" htmlFor="machine-subtitle">
          {t('Subtítulo')}
        </label>
        <input
          id="machine-subtitle"
          className="input"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          maxLength={80}
          placeholder={t('ex.: MacBook do escritório')}
        />
        <p className="mt-1 text-[11px] text-fg-dim">{t('Opcional. Aparece só para você, nunca na cidade pública.')}</p>
      </div>
      {machine && type !== 'agent' && (
        <p className="rounded-md border border-line bg-bg p-2 text-xs text-fg-dim">
          {type === 'local' ? (
            <Trans
              i18nKey="Tipo: <0>{{type}}</0>. Máquinas novas só podem ser adicionadas com o agente — esta é a própria máquina onde o termhub roda, não o seu computador."
              values={{ type: t(TYPE_LABEL[type]) }}
              components={[<span key="t" className="text-fg-muted" />]}
            />
          ) : (
            <Trans
              i18nKey="Tipo: <0>{{type}}</0>. Máquinas novas só podem ser adicionadas com o agente."
              values={{ type: t(TYPE_LABEL[type]) }}
              components={[<span key="t" className="text-fg-muted" />]}
            />
          )}
        </p>
      )}
      {type === 'agent' && (
        <>
          {!machine && (
            <p className="rounded-md border border-line bg-bg p-2 text-xs text-fg-dim">
              {t('Serve para o seu próprio computador ou para um servidor: um cliente leve (o agente) roda na máquina e conecta ao termhub. Nada de SSH, nada de portas abertas.')}
            </p>
          )}
          <label className="flex items-start gap-2 text-sm text-fg-muted">
            <input type="checkbox" className="mt-0.5 accent-accent" checked={isLocal} onChange={(e) => setIsLocal(e.target.checked)} />
            <span>
              {t('É o computador que estou usando agora')}
              <span className="block text-[11px] text-fg-dim">{t('Aparece só neste navegador; em outros computadores ela fica oculta.')}</span>
            </span>
          </label>
        </>
      )}
      {type === 'ssh' && (
        <>
          <div>
            <label className="label">{t('Host')}</label>
            <input className="input" value={host} onChange={(e) => setHost(e.target.value)} required placeholder={t('192.168.1.10 ou nome.local')} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="label">{t('Usuário SSH')}</label>
              <input className="input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} /* i18n-ignore */ placeholder="pedro" />
            </div>
            <div>
              <label className="label">{t('Porta')}</label>
              <input className="input" value={sshPort} onChange={(e) => setSshPort(e.target.value)} inputMode="numeric" />
            </div>
          </div>
        </>
      )}
      {machine && isAdmin && owners && (
        <div>
          <label className="label">{t('Dono')}</label>
          <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">{t('— sem dono (só visível em "todas as máquinas") —')}</option>
            {owners.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} — {u.email}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-fg-dim">{t('Projetos, tabs, tarefas, notas e contas de IA desta máquina passam a ser vistos pelo novo dono.')}</p>
        </div>
      )}
      {machine && machine.type === 'agent' && <AutomationAllowedCard machine={machine} />}
      {machine && <AiUsageQueryCard machine={machine} />}
    </>
  );

  const panel = (key: MachineFormTab) => {
    if (!machine) return null;
    switch (key) {
      case 'general':
        return general;
      case 'agent':
        return (
          <>
            <AgentUpdateCard machine={machine} />
            <NetworkCheckCard machine={machine} />
            <div className="rounded-md border border-line bg-bg p-2 text-xs">
              <div className="flex items-center gap-2">
                <p className="font-medium text-fg-muted">{t('Credencial do agente')}</p>
                <button type="button" className="btn-ghost ml-auto border border-line px-2 py-0.5" disabled={rotating} onClick={() => void rotateToken()}>
                  {rotating ? t('Gerando…') : t('Parear de novo')}
                </button>
              </div>
              {live?.agent_credential === 'key' && <p className="mt-1 text-fg-muted">{t('Chave do dispositivo: o agente prova que a tem a cada conexão.')}</p>}
              {live?.agent_credential === 'bearer' && (
                <p className="mt-1 text-warn">{t('Token permanente (antigo). Atualize o agente e use Parear de novo para trocá-lo por uma chave do dispositivo.')}</p>
              )}
              <p className="mt-1 text-fg-dim">{t('Gera um token de pareamento novo (uso único, vale 15 minutos), revoga o acesso atual e desconecta o agente; os passos para reconectar aparecem em seguida.')}</p>
            </div>
          </>
        );
      case 'monitor':
        return <MonitorHooksCard machine={machine} />;
      case 'simulator':
        return <SimulatorSetupCard machine={machine} />;
    }
  };

  return (
    <Modal title={machine ? t('Editar máquina') : t('Nova máquina')} open={open} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {!live ? (
          general
        ) : (
          <>
            <div role="tablist" aria-label={t('Seções da máquina')} className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1">
              {tabs.map((key) => {
                const badge = machineTabBadge(key, live);
                const selected = key === current;
                return (
                  <button
                    key={key}
                    ref={(el) => {
                      tabRefs.current[key] = el;
                    }}
                    id={`machine-tab-${key}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`machine-panel-${key}`}
                    tabIndex={selected ? 0 : -1}
                    className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-xs ${
                      selected ? 'border-accent text-fg' : 'border-transparent text-fg-dim hover:text-fg'
                    }`}
                    onClick={() => setTab(key)}
                    onKeyDown={onTabKey}
                  >
                    {t(TAB_LABEL[key])}
                    {badge && (
                      <span className={`rounded-full px-1.5 text-[10px] ${badge.critical ? 'bg-danger/10 text-danger' : 'bg-warn/10 text-warn'}`} title={t(badge.title)}>
                        {t(badge.text)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Every panel stays mounted (only hidden): what was typed in Geral, and a card's running
                update or install, survive switching tabs. */}
            {tabs.map((key) => (
              <div
                key={key}
                id={`machine-panel-${key}`}
                role="tabpanel"
                aria-labelledby={`machine-tab-${key}`}
                hidden={key !== current}
                className="space-y-3"
              >
                {panel(key)}
              </div>
            ))}
          </>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancelar')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy} onClick={revealInvalid}>
            {machine ? t('Salvar') : t('Criar')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
