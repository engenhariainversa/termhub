import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import type { Machine, WdaSetupState } from '../lib/types';
import { Trans, useTranslation } from '../i18n';

const POLL_MS = 3000;
/** How long to keep polling for the updated agent after "Atualizar agente" (mirrors AgentUpdateCard). */
const UPDATE_POLL_MAX_MS = 90_000;

export function SimulatorSetupCard({ machine }: { machine: Machine }) {
  const { machines, checkStatus } = useData();
  const { t } = useTranslation();
  const updatingMessage = t('Atualizando o agente… ele reinicia e reconecta em instantes.');
  // `machine` é um snapshot capturado quando o modal abriu; usamos a versão viva da lista
  // para que `isMac`/`hasWda` reajam ao checkStatus (ex.: capabilities atualizadas após o setup).
  const live = machines.find((m) => m.id === machine.id) ?? machine;

  const [setup, setSetup] = useState<WdaSetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentBlock, setAgentBlock] = useState<'offline' | 'outdated' | null>(null);
  const [outdatedMessage, setOutdatedMessage] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const hasWdaRef = useRef(false);
  // When the user asked for an agent update: keeps `load` polling while the agent is still the old
  // one (it restarts and reconnects), until it claims `sim` or UPDATE_POLL_MAX_MS runs out.
  const updateRequestedAt = useRef<number | null>(null);

  const isMac = live.os === 'macos' && live.capabilities.includes('xcodebuild');
  const hasWda = live.capabilities.includes('wda');
  hasWdaRef.current = hasWda;

  // Auto-rescheduling: cada `load` agenda o próximo `load` quando ainda está `running`, em vez
  // de depender de um efeito reagir à mudança de `setup.state` (que não muda entre dois polls
  // consecutivos que retornam "running", e por isso nunca reagendava o próximo timer).
  const load = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      const s = await api.machines.wdaSetup(machine.id);
      if (cancelledRef.current) return;
      updateRequestedAt.current = null;
      setAgentBlock(null);
      setSetup(s);
      setError(null);
      if (s.state === 'running') {
        timer.current = setTimeout(() => void load(), POLL_MS);
      } else if (s.state === 'ok' && !hasWdaRef.current) {
        void checkStatus(machine.id);
      }
    } catch (e) {
      if (cancelledRef.current) return;
      if (e instanceof ApiError && e.code === 'AGENT_OFFLINE') {
        setAgentBlock('offline');
        setError(null);
        timer.current = setTimeout(() => void load(), POLL_MS); // the agent may come back
        return;
      }
      if (e instanceof ApiError && e.code === 'AGENT_OUTDATED') {
        setAgentBlock('outdated');
        setError(null);
        const requestedAt = updateRequestedAt.current;
        if (requestedAt === null) {
          setOutdatedMessage(e.message);
        } else if (Date.now() - requestedAt > UPDATE_POLL_MAX_MS) {
          updateRequestedAt.current = null;
          setOutdatedMessage(t('Ainda reconectando… verifique o agente na máquina.'));
        } else {
          // still the old agent (not restarted yet): keep the "updating" sentence and look again
          setOutdatedMessage(updatingMessage);
          timer.current = setTimeout(() => void load(), POLL_MS);
        }
        return;
      }
      setError(e instanceof ApiError ? e.message : t('Erro ao consultar o setup'));
    }
  }, [machine.id, checkStatus, t, updatingMessage]);

  useEffect(() => {
    if (!isMac) return;
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [machine.id, isMac, load]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.machines.startWdaSetup(machine.id);
      setSetup((cur) => ({ state: 'running', tail: [], version: cur?.version ?? null }));
      void load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao iniciar o setup'));
    } finally {
      setBusy(false);
    }
  };

  const updateAgent = async () => {
    setUpdating(true);
    try {
      await api.machines.updateAgent(machine.id);
      if (cancelledRef.current) return;
      updateRequestedAt.current = Date.now();
      setOutdatedMessage(updatingMessage);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), POLL_MS * 3);
    } catch (e) {
      if (cancelledRef.current) return;
      setError(e instanceof ApiError ? e.message : t('Erro ao atualizar o agente'));
    } finally {
      if (!cancelledRef.current) setUpdating(false);
    }
  };

  if (agentBlock === 'offline') {
    return (
      <div className="rounded-md border border-line bg-bg p-2 text-xs text-fg-dim">
        <p className="mb-0.5 font-medium text-fg-muted">{t('Simulador iOS')}</p>
        <p>{t('Conecte o agente para preparar o simulador.')}</p>
      </div>
    );
  }
  if (agentBlock === 'outdated') {
    return (
      <div className="rounded-md border border-line bg-bg p-2 text-xs">
        <div className="flex items-center gap-2">
          <p className="font-medium text-fg-muted">{t('Simulador iOS')}</p>
          <button type="button" className="btn-ghost ml-auto px-2 py-0.5" onClick={() => void updateAgent()} disabled={updating}>
            {updating ? '…' : t('Atualizar agente')}
          </button>
        </div>
        <p className="mt-1 text-fg-dim">{outdatedMessage}</p>
        {error && <p className="mt-1 text-danger">{error}</p>}
      </div>
    );
  }

  if (!isMac) {
    return (
      <div className="rounded-md border border-line bg-bg p-2 text-xs text-fg-dim">
        <p className="mb-0.5 font-medium text-fg-muted">{t('Simulador iOS')}</p>
        <p>{t('Indisponível: precisa ser um Mac com Xcode instalado (detectado no status da máquina).')}</p>
      </div>
    );
  }

  const state = setup?.state ?? (hasWda ? 'ok' : 'idle');
  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <div className="flex items-center gap-2">
        <p className="font-medium text-fg-muted">{t('Simulador iOS')}</p>
        <span className="text-fg-dim">
          {state === 'running' && t('preparando…')}
          {state === 'ok' && (setup?.version ? t('pronto · WDA {{version}}', { version: setup.version }) : t('pronto'))}
          {state === 'failed' && <span className="text-danger">{t('falhou')}</span>}
          {state === 'idle' && t('não preparado')}
        </span>
        <button type="button" className="btn-ghost ml-auto px-2 py-0.5" onClick={() => void start()} disabled={busy || state === 'running'}>
          {state === 'ok' ? t('Atualizar') : state === 'failed' ? t('Tentar de novo') : t('Preparar')}
        </button>
      </div>
      <p className="mt-1 text-fg-dim">
        <Trans
          i18nKey="Clona e compila o WebDriverAgent em <0>~/.termhub/WebDriverAgent</0> (leva alguns minutos na primeira vez)."
          components={[<code key="c" className="font-mono" />]}
        />
      </p>
      {error && <p className="mt-1 text-danger">{error}</p>}
      {setup && setup.tail.length > 0 && (state === 'running' || state === 'failed') && (
        <pre className="mt-1 max-h-32 overflow-auto rounded bg-bg-2 p-1.5 font-mono text-[10px] text-fg-dim">{setup.tail.join('\n')}</pre>
      )}
    </div>
  );
}
