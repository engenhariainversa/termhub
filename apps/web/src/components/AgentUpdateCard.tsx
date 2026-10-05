import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { useTranslation } from '../i18n';
import type { Machine } from '../lib/types';

export const POLL_MS = 3000;
const POLL_MAX_MS = 90_000;

type Versions = { current: string | null; latest: string | null; online: boolean; updateAvailable: boolean };

/** Machine form: the agent's version, the update button and the auto-update switch. */
export function AgentUpdateCard({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const { updateMachine, checkStatus } = useData();
  const [v, setV] = useState<Versions | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(machine.agent_auto_update);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** false once the card unmounts (form closed): stops a poll's in-flight tick from rescheduling. */
  const alive = useRef(true);

  const load = async (): Promise<Versions> => {
    const s = await api.machines.status(machine.id);
    const next = { current: s.agent_version ?? null, latest: s.latest_agent_version ?? null, online: s.online, updateAvailable: !!s.update_available };
    setV(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    load().catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : t('Erro ao consultar')));
    const all = timers.current;
    return () => {
      cancelled = true;
      alive.current = false;
      all.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id]);

  /** After a service restart the agent reconnects with the new version; poll until it does (or give up). */
  const pollUntil = (target: string) => {
    const started = Date.now();
    const tick = async () => {
      let s: Versions | null = null;
      try {
        s = await load();
      } catch {
        /* offline while restarting: keep polling */
      }
      if (!alive.current) return;
      if (s && s.online && s.current === target) {
        setNote(t('Agente atualizado para v{{version}}.', { version: target }));
        setBusy(false);
        void checkStatus(machine.id);
        return;
      }
      if (Date.now() - started > POLL_MAX_MS) {
        setNote(t('Ainda reconectando… verifique o agente na máquina.'));
        setBusy(false);
        return;
      }
      if (alive.current) timers.current.push(setTimeout(() => void tick(), POLL_MS));
    };
    if (alive.current) timers.current.push(setTimeout(() => void tick(), POLL_MS));
  };

  const update = async () => {
    if (!v?.latest) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.machines.updateAgent(machine.id);
      if (r.restarting) {
        setNote(t('Instalando… o agente reinicia e os terminais abertos reconectam.'));
        pollUntil(v.latest);
      } else {
        setNote(t('Instalado v{{version}}; reinicie o agente nesta máquina (termhub-agent run ou o serviço).', { version: r.installed_version ?? v.latest }));
        setBusy(false);
      }
    } catch (e) {
      // A gateway/Cloudflare cutting the HTTP request (504/524, or a bare 502) does not mean the
      // install failed: npm may still be running on the machine. Keep polling instead of showing
      // an error, unless the server already told us the RPC itself failed or npm is missing.
      const cutMidInstall = e instanceof ApiError && (e.status === 504 || e.status === 524 || (e.status === 502 && e.code !== 'AGENT_UPDATE_FAILED' && e.code !== 'AGENT_UPDATE_NPM_MISSING'));
      if (cutMidInstall) {
        setNote(t('A conexão caiu durante a instalação; ela pode continuar na máquina. Aguardando o agente voltar…'));
        pollUntil(v.latest);
      } else {
        setError(e instanceof ApiError ? e.message : t('Erro ao atualizar'));
        setBusy(false);
      }
    }
  };

  const toggleAuto = async (next: boolean) => {
    setAuto(next);
    try {
      await updateMachine(machine.id, { agent_auto_update: next });
    } catch (e) {
      setAuto(!next);
      setError(e instanceof ApiError ? e.message : t('Erro ao salvar'));
    }
  };

  const summary = !v
    ? '…'
    : !v.current
      ? t('versão desconhecida')
      : v.updateAvailable && v.latest
        ? t('v{{current}} · v{{latest}} disponível', { current: v.current, latest: v.latest })
        : v.latest
          ? t('v{{current}} · atualizado', { current: v.current })
          : `v${v.current}`;

  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <div className="flex items-center gap-2">
        <p className="font-medium text-fg-muted">{t('Agente')}</p>
        <span className="text-fg-dim">{summary}</span>
        {v?.updateAvailable && (
          <span className="ml-auto">
            <button type="button" className="btn-ghost px-2 py-0.5" onClick={() => void update()} disabled={busy || !v.online}>
              {busy ? '…' : t('Atualizar')}
            </button>
          </span>
        )}
      </div>
      <label className="mt-1 flex items-center gap-2 text-fg-dim">
        <input type="checkbox" checked={auto} onChange={(e) => void toggleAuto(e.target.checked)} />
        {t('Atualizar automaticamente quando ociosa')}
      </label>
      <p className="mt-1 text-fg-dim">
        {t('Sem terminal aberto e sem ferramenta trabalhando, o servidor instala novas versões do agente sozinho. As sessões do tmux continuam vivas: os terminais reconectam depois da atualização.')}
      </p>
      {note && <p className="mt-1 text-fg-muted">{note}</p>}
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
