import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { relativeTime } from '../lib/format';
import type { Machine, MachineNetInterface, MachineNetworkInfo, WakeResult } from '../lib/types';
import { tk, useTranslation } from '../i18n';

const KIND_LABEL: Record<NonNullable<MachineNetInterface['kind']>, string> = { ethernet: tk('cabo'), wifi: tk('Wi-Fi'), other: tk('outra') };

const WARNING_TEXT: Record<WakeResult['warnings'][number], string> = {
  wifi: tk('A interface salva é Wi-Fi: o Wake-on-LAN raramente funciona por Wi-Fi. Se a máquina não acordar, ligue-a no cabo.'),
  macos: tk('No macOS, o Wake-on-LAN só funciona com "Despertar para acesso à rede" (Wake for network access) ligado em Ajustes do Sistema > Bateria/Energia.'),
};

/**
 * Machine form, Rede tab (TER-1080): the IPs and MACs the agent last reported, kept while the machine
 * sleeps, and "Acordar" — another online machine of the same network sends the Wake-on-LAN packet.
 */
export function MachineNetworkCard({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<MachineNetworkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [via, setVia] = useState('');
  const [waking, setWaking] = useState(false);
  const [woke, setWoke] = useState<WakeResult | null>(null);
  const [wakeError, setWakeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.machines.network(machine.id).then(
      (r) => !cancelled && setInfo(r),
      (e) => !cancelled && setError(e instanceof ApiError ? e.message : t('Erro ao carregar')),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id]);

  const wake = async () => {
    setWaking(true);
    setWoke(null);
    setWakeError(null);
    try {
      setWoke(await api.machines.wake(machine.id, via || undefined));
    } catch (e) {
      setWakeError(e instanceof ApiError ? e.message : t('Erro ao acordar a máquina'));
    } finally {
      setWaking(false);
    }
  };

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!info) return <p className="text-xs text-fg-dim">{t('Carregando…')}</p>;
  const net = info.network;
  const ready = info.relays.filter((r) => r.online && r.capable && r.same_network);

  return (
    <>
      <div className="rounded-md border border-line bg-bg p-2 text-xs">
        <div className="flex items-center gap-2">
          <p className="font-medium text-fg-muted">{t('Rede da máquina')}</p>
          {info.updated_at && <span className="ml-auto text-fg-dim">{t('informada {{when}}', { when: relativeTime(info.updated_at) })}</span>}
        </div>
        {!net ? (
          <p className="mt-1 text-fg-dim">{t('Esta máquina ainda não informou a rede. Atualize o agente para a versão 0.30.0 ou mais nova e deixe-a online uma vez: o termhub guarda os IPs e MACs para quando ela estiver dormindo.')}</p>
        ) : (
          <>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-fg-dim">{t('Hostname do sistema')}</dt>
              <dd className="font-mono">{net.hostname}</dd>
              <dt className="text-fg-dim">{t('Interface padrão')}</dt>
              <dd className="font-mono">{net.default_interface ?? '—'}</dd>
              <dt className="text-fg-dim">{t('Gateway')}</dt>
              <dd className="font-mono">{net.gateway ?? '—'}</dd>
            </dl>
            <ul className="mt-2 space-y-1">
              {net.interfaces.map((i) => (
                <li key={i.name} className="rounded border border-line px-2 py-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{i.name}</span>
                    {i.kind && <span className="text-fg-dim">{t(KIND_LABEL[i.kind])}</span>}
                    {i.name === net.default_interface && <span className="text-fg-dim">{t('padrão')}</span>}
                    <span className="ml-auto font-mono text-fg-muted" title={t('Endereço MAC')}>
                      {i.mac ?? '—'}
                    </span>
                  </div>
                  <p className="break-all font-mono text-fg-muted">{i.addresses.map((a) => a.cidr ?? a.address).join('  ')}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="rounded-md border border-line bg-bg p-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-fg-muted">{t('Acordar pela rede (Wake-on-LAN)')}</p>
          {net && !info.online && (
            <span className="ml-auto flex items-center gap-1">
              <select className="input w-auto max-w-[12rem] py-0.5 text-xs" value={via} onChange={(e) => setVia(e.target.value)} aria-label={t('Enviar por')}>
                <option value="">{t('qualquer máquina da rede')}</option>
                {ready.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost border border-line px-2 py-0.5" disabled={waking || ready.length === 0} onClick={() => void wake()}>
                {waking ? t('Enviando…') : t('Acordar')}
              </button>
            </span>
          )}
        </div>
        <p className="mt-1 text-fg-dim">{t('Outra máquina online na mesma rede local envia o pacote mágico para o MAC salvo (UDP, portas 9 e 7). A máquina reconecta sozinha quando acorda.')}</p>
        {info.online && <p className="mt-1 text-fg-muted">{t('A máquina está online agora.')}</p>}
        {net && !info.online && ready.length === 0 && <p className="mt-1 text-warn">{t('Nenhuma máquina online na mesma rede local pode acordar esta (é preciso o agente 0.30.0 ou mais novo).')}</p>}
        {machine.os === 'macos' && <p className="mt-1 text-fg-dim">{t(WARNING_TEXT.macos)}</p>}
        {woke && (
          <div className="mt-1">
            <p className="text-ok">{t('Pacote enviado por {{name}}. Se a máquina acordar, ela aparece online em até um minuto.', { name: woke.via.name })}</p>
            {woke.warnings.filter((w) => w !== 'macos').map((w) => (
              <p key={w} className="text-warn">
                {t(WARNING_TEXT[w])}
              </p>
            ))}
          </div>
        )}
        {wakeError && <p className="mt-1 text-danger">{wakeError}</p>}
      </div>
    </>
  );
}
