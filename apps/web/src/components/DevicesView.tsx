import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Device, DeviceEventView, DeviceRequestView, PushTestKind } from '../lib/types';
import { ConfirmDialog } from './Modal';
import { formatDate, formatTime } from '../lib/format';
import { i18n, tk, useTranslation } from '../i18n';

/** Same ceiling the server enforces (mobile/enrolment.ts's DEVICE_LIMIT, 409 "Revogue um aparelho
 *  antes"): Aprovar is disabled here too, instead of always waiting for that round-trip. */
const MAX_DEVICES = 5;

/** DeviceRequestBanner listens for this to refresh its own summary right after a decision here. */
const DEVICES_CHANGED_EVENT = 'termhub:devices-changed';

const fmtDate = (iso: string) => formatDate(iso);
const fmtTime = (iso: string) => formatTime(iso, { hour: '2-digit', minute: '2-digit' });

/** City and country as Cloudflare saw them; empty when neither is known (the IP is always shown apart). */
function placeOf(r: DeviceRequestView): string {
  return [r.city, r.country].filter(Boolean).join(', ');
}

const PLATFORM_LABELS: Record<string, string> = { ios: 'iOS', android: 'Android' };
const osOf = (r: DeviceRequestView) => `${PLATFORM_LABELS[r.platform] ?? r.platform} ${r.os_version}`.trim();

/** "expira em X min", rounded up so a request with seconds left still reads 1 min. */
function expiresLabel(expiresAt: string, now: number): string {
  const minutes = Math.ceil((new Date(expiresAt).getTime() - now) / 60_000);
  return minutes > 0 ? i18n.t('expira em {{minutes}} min', { minutes }) : i18n.t('expirado');
}

function situationLabel(d: Device, now = new Date()): string {
  if (d.status === 'active') {
    if (d.pin_locked_until && new Date(d.pin_locked_until) > now) return i18n.t('bloqueado por PIN até {{time}}', { time: fmtTime(d.pin_locked_until) });
    return i18n.t('ativo');
  }
  return d.revoked_reason === 'pin_bruteforce' ? i18n.t('revogado (tentativas de PIN)') : i18n.t('revogado');
}

const PUSH_TEST_KINDS: { value: PushTestKind; label: string }[] = [
  { value: 'confirmation', label: tk('Confirmação do chat') },
  { value: 'tab_question', label: tk('Pergunta de aba') },
  { value: 'reply', label: tk('Resposta pronta') },
  { value: 'device_request', label: tk('Pedido de aparelho novo') },
];

const PUSH_TEST_DELAYS = [0, 10, 30];

/** The receipt is read ~15 s after the send (server, TER-913): the trail is re-read a bit after that. */
const PUSH_TEST_TRAIL_AFTER_MS = 20_000;

function notifyDevicesChanged(): void {
  window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
}

/**
 * Settings → Aparelhos (spec §10.1): pending phone requests waiting on the code check, the enrolled
 * devices themselves and the activity trail. The signed-in user's own phones only — same rule as the
 * server routes this talks to.
 */
export function DevicesView() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [requests, setRequests] = useState<DeviceRequestView[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [events, setEvents] = useState<DeviceEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<DeviceRequestView | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [testDeviceId, setTestDeviceId] = useState('');
  const [testKind, setTestKind] = useState<PushTestKind>('confirmation');
  const [testDelay, setTestDelay] = useState(0);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);
  // Ticks once a minute so each pending card's "expira em X min" stays true without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, d, e] = await Promise.all([api.devices.requests(), api.devices.list(), api.devices.events()]);
      setRequests(r.requests);
      setDevices(d.devices);
      setEvents(e.events);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao carregar aparelhos'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A late trail refresh must not outlive the page.
  useEffect(() => {
    if (!testNote) return;
    const timer = setTimeout(() => {
      void api.devices.events().then((e) => setEvents(e.events), () => undefined);
    }, PUSH_TEST_TRAIL_AFTER_MS + testDelay * 1000);
    return () => clearTimeout(timer);
  }, [testNote, testDelay]);

  const pushDevices = useMemo(() => (devices ?? []).filter((d) => d.status === 'active' && !!d.push_token), [devices]);
  const testTarget = pushDevices.find((d) => d.id === testDeviceId) ?? pushDevices[0];

  const sendTestPush = async () => {
    if (!testTarget) return;
    setTesting(true);
    setTestNote(null);
    setError(null);
    try {
      const r = await api.devices.testPush(testTarget.id, { kind: testKind, delay_seconds: testDelay });
      if (r.ticket?.status === 'error') setError(t('A notificação de teste falhou: {{code}}', { code: r.ticket.error }));
      else setTestNote(testDelay > 0 ? t('Enviando em {{seconds}} s. Feche o app para ver como ela chega.', { seconds: testDelay }) : t('Enviada. Confira o celular.'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao enviar a notificação de teste'));
    } finally {
      setTesting(false);
    }
  };

  const activeCount = useMemo(() => (devices ?? []).filter((d) => d.status === 'active').length, [devices]);
  const atLimit = activeCount >= MAX_DEVICES;

  const deny = async (r: DeviceRequestView) => {
    setError(null);
    try {
      await api.devices.deny(r.id);
      setRequests((list) => (list ?? []).filter((x) => x.id !== r.id));
      notifyDevicesChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao recusar o pedido'));
    }
  };

  const confirmApprove = async () => {
    const r = approving;
    setApproving(null);
    if (!r) return;
    setError(null);
    try {
      await api.devices.approve(r.id);
      setRequests((list) => (list ?? []).filter((x) => x.id !== r.id));
      notifyDevicesChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao aprovar o pedido'));
    }
  };

  const confirmRevoke = async () => {
    const d = revoking;
    setRevoking(null);
    if (!d) return;
    setError(null);
    try {
      const r = await api.devices.revoke(d.id);
      setDevices((list) => (list ?? []).map((x) => (x.id === d.id ? r.device : x)));
      notifyDevicesChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao revogar o aparelho'));
    }
  };

  const startRename = (d: Device) => {
    setEditingId(d.id);
    setEditValue(d.name);
  };

  const submitRename = async (d: Device) => {
    const name = editValue.trim();
    setEditingId(null);
    if (!name || name === d.name) return;
    setError(null);
    try {
      const r = await api.devices.rename(d.id, name);
      setDevices((list) => (list ?? []).map((x) => (x.id === d.id ? r.device : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao renomear o aparelho'));
    }
  };

  const onNameKeyDown = (e: KeyboardEvent<HTMLInputElement>, d: Device) => {
    if (e.key === 'Enter') void submitRename(d);
    else if (e.key === 'Escape') setEditingId(null);
  };

  const loading = requests === null || devices === null || events === null;
  const empty = !loading && requests.length === 0 && devices.length === 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-danger">{error}</p>}

      {loading ? (
        <p className="text-sm text-fg-dim">{t('Carregando…')}</p>
      ) : empty ? (
        <p className="text-sm text-fg-dim">{t('Instale o app termhub no celular e entre com seu e-mail. O pedido de acesso aparece aqui.')}</p>
      ) : (
        <>
          {requests.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">{t('Pedidos de acesso')}</h2>
              <ul className="space-y-3">
                {requests.map((r) => (
                  <li key={r.id} className="rounded-lg border border-line bg-bg-2 p-4">
                    <p className="text-sm font-medium">{r.device_name}</p>
                    <p className="text-xs text-fg-dim">
                      {r.model} · {osOf(r)}
                    </p>
                    <p className="text-xs text-fg-dim">
                      {placeOf(r) ? t('{{place}} · IP {{ip}}', { place: placeOf(r), ip: r.ip }) : t('IP {{ip}}', { ip: r.ip })}
                    </p>
                    <p className="mb-1 text-xs text-fg-dim">
                      {t('Pedido em {{date}} às {{time}} · {{expires}}', { date: fmtDate(r.created_at), time: fmtTime(r.created_at), expires: expiresLabel(r.expires_at, now) })}
                    </p>
                    <code className="font-mono text-2xl tracking-widest">{r.verification_code}</code>
                    <p className="mt-1 text-sm text-fg-muted">{t('Se você não pediu isso, recuse.')}</p>
                    {atLimit && <p className="mt-1 text-xs text-danger">{t('Revogue um aparelho antes')}</p>}
                    <div className="mt-2 flex gap-2">
                      {can('devices', 'update') && (
                        <button className="btn-ghost" onClick={() => void deny(r)}>
                          {t('Recusar')}
                        </button>
                      )}
                      {can('devices', 'update') && (
                        <button className="btn-primary" disabled={atLimit} onClick={() => setApproving(r)}>
                          {t('Aprovar')}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t('Aparelhos')}</h2>
            {devices.length === 0 ? (
              <p className="text-sm text-fg-dim">{t('Nenhum aparelho ainda.')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-fg-dim">
                    <tr>
                      <th className="py-1 pr-3 font-normal">{t('Nome')}</th>
                      <th className="py-1 pr-3 font-normal">{t('Modelo')}</th>
                      <th className="py-1 pr-3 font-normal">{t('Adicionado')}</th>
                      <th className="py-1 pr-3 font-normal">{t('Visto por último')}</th>
                      <th className="py-1 pr-3 font-normal">{t('Situação')}</th>
                      <th className="py-1 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => (
                      <tr key={d.id} className={`border-t border-line ${d.status === 'active' ? '' : 'text-fg-dim'}`}>
                        <td className="py-1.5 pr-3">
                          {editingId === d.id ? (
                            <input
                              className="input py-0.5"
                              value={editValue}
                              autoFocus
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => onNameKeyDown(e, d)}
                              onBlur={() => setEditingId(null)}
                            />
                          ) : can('devices', 'update') ? (
                            <button className="hover:underline" onClick={() => startRename(d)}>
                              {d.name}
                            </button>
                          ) : (
                            d.name
                          )}
                        </td>
                        <td className="py-1.5 pr-3">
                          {d.model} · {d.os_version}
                        </td>
                        <td className="py-1.5 pr-3">{fmtDate(d.created_at)}</td>
                        <td className="py-1.5 pr-3">{d.last_seen_at ? fmtDate(d.last_seen_at) : t('nunca')}</td>
                        <td className="py-1.5 pr-3">{situationLabel(d)}</td>
                        <td className="py-1.5 text-right">
                          {d.status === 'active' && can('devices', 'delete') && (
                            <button className="btn-ghost px-2 py-0.5 text-xs text-danger" aria-label={t('Revogar {{name}}', { name: d.name })} onClick={() => setRevoking(d)}>
                              {t('Revogar')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {pushDevices.length > 0 && can('devices', 'update') && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">{t('Notificação de teste')}</h2>
              <p className="text-xs text-fg-dim">{t('Envia um aviso de exemplo para o seu aparelho, sem entrar no histórico de notificações. O resultado aparece em Atividade.')}</p>
              <div className="flex flex-wrap items-center gap-2">
                {pushDevices.length > 1 && (
                  <select className="input w-auto py-1" aria-label={t('Aparelho')} value={testTarget?.id ?? ''} onChange={(e) => setTestDeviceId(e.target.value)}>
                    {pushDevices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                )}
                <select className="input w-auto py-1" aria-label={t('Tipo de aviso')} value={testKind} onChange={(e) => setTestKind(e.target.value as PushTestKind)}>
                  {PUSH_TEST_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {t(k.label)}
                    </option>
                  ))}
                </select>
                <select className="input w-auto py-1" aria-label={t('Quando enviar')} value={testDelay} onChange={(e) => setTestDelay(Number(e.target.value))}>
                  {PUSH_TEST_DELAYS.map((s) => (
                    <option key={s} value={s}>
                      {s === 0 ? t('Agora') : t('Em {{seconds}} s', { seconds: s })}
                    </option>
                  ))}
                </select>
                <button className="btn-primary" disabled={testing} onClick={() => void sendTestPush()}>
                  {t('Enviar notificação de teste')}
                </button>
              </div>
              {testNote && <p className="text-xs text-fg-muted">{testNote}</p>}
            </section>
          )}
        </>
      )}

      {!loading && events.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{t('Atividade')}</h2>
          <ul className="space-y-1 text-sm text-fg-muted">
            {events.map((e) => (
              <li key={e.id} className="flex justify-between gap-3 border-t border-line py-1.5 first:border-0">
                <span>{e.text}</span>
                <span className="shrink-0 text-xs text-fg-dim">{fmtDate(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={!!approving}
        title={t('Aprovar aparelho')}
        message={t('O código na tela do celular é {{code}}?', { code: approving?.verification_code ?? '' })}
        confirmLabel={t('Aprovar')}
        onConfirm={confirmApprove}
        onCancel={() => setApproving(null)}
      />
      <ConfirmDialog
        open={!!revoking}
        title={t('Revogar aparelho')}
        message={t('Ele perde o acesso na hora. Isso não pode ser desfeito.')}
        confirmLabel={t('Revogar')}
        danger
        onConfirm={confirmRevoke}
        onCancel={() => setRevoking(null)}
      />
    </div>
  );
}
