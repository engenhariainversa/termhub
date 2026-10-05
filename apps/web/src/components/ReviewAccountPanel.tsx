import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Device, DeviceEventView, User } from '../lib/types';
import { ConfirmDialog } from './Modal';
import { formatDateTime } from '../lib/format';
import { tk, useTranslation } from '../i18n';

type ReviewDays = 1 | 3 | 7;

const DAY_OPTIONS: Array<{ value: ReviewDays; label: string }> = [
  { value: 1, label: tk('1 dia') },
  { value: 3, label: tk('3 dias') },
  { value: 7, label: tk('7 dias') },
];

const fmtDateTime = (iso: string) => formatDateTime(iso);

/**
 * Settings → Usuários → Revisão (Task 17): the store-review switch for one account. While
 * `review_enabled_until` is in the future, Apple's/Google's reviewer signs in with this account and
 * its mobile device requests auto-approve (see mobile/enrolment.ts). Lives inside a `Modal` opened
 * from a row action in the Usuários table — admin only, same as the rest of that section.
 */
export function ReviewAccountPanel({ user, onChange }: { user: User; onChange: (u: User) => void }) {
  const { t } = useTranslation();
  const [admins, setAdmins] = useState<User[]>([]);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [events, setEvents] = useState<DeviceEventView[]>([]);
  // null while unknown (still loading): the note is server-driven (`can_enrol`, from the target's
  // actual role grants), never guessed from a role name or a permissions list this panel never reads.
  const [canEnrol, setCanEnrol] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [days, setDays] = useState<ReviewDays>(1);
  const [busy, setBusy] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const isAdminTarget = !!user.role_info?.is_admin;
  const active = !!user.review_enabled_until && new Date(user.review_enabled_until) > new Date();

  const load = useCallback(async () => {
    try {
      const [d, u] = await Promise.all([api.users.devices(user.id), api.users.list()]);
      setDevices(d.devices);
      setEvents(d.events);
      setCanEnrol(d.can_enrol);
      setAdmins(u.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao carregar'));
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const adminName = (id: string | null | undefined): string => {
    if (!id) return '';
    return admins.find((a) => a.id === id)?.name ?? id;
  };

  const setReview = async (input: { days: ReviewDays | null; revoke_devices?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.users.setReview(user.id, input);
      onChange(r.user);
      setTurningOn(false);
      setConfirmingOff(false);
      // "Desligar e revogar os aparelhos" revoked them server-side: reload, so those rows lose
      // their Revogar button and the trail shows the change.
      if (input.revoke_devices) await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao alterar o modo revisão'));
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (d: Device) => {
    if (revokingId) return;
    setError(null);
    setRevokingId(d.id);
    try {
      const r = await api.users.revokeDevice(user.id, d.id);
      setDevices((list) => (list ?? []).map((x) => (x.id === d.id ? r.device : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao revogar o aparelho'));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-danger">{error}</p>}

      {isAdminTarget ? (
        <p className="text-sm text-fg-muted">{t('A conta de revisão não pode ser admin.')}</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              // Only the persisted value flips this, never the duration panel being open — same rule
              // as PublishControl's own switch.
              aria-checked={active}
              aria-label={t('Modo revisão')}
              title={t('Modo revisão')}
              disabled={busy || active}
              onClick={() => setTurningOn((v) => !v)}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${active ? 'bg-accent' : 'bg-fg-dim/40'}`}
            >
              <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform ${active ? 'translate-x-[18px] bg-white' : 'translate-x-0.5 bg-fg-muted'}`} />
            </button>
            <span className="text-sm">{t('Modo revisão')}</span>
          </div>

          {canEnrol === false && (
            <p className="text-xs text-warn">{t('Essa conta precisa estar no role que tem Chat e Aparelhos (BETA); caso contrário os pedidos do app são ignorados.')}</p>
          )}

          {!active && turningOn && (
            <div className="rounded-lg border border-line bg-bg-2 p-3 text-sm">
              <p className="mb-2 text-fg-muted">{t('Por quanto tempo?')}</p>
              <div className="flex gap-3">
                {DAY_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-center gap-1">
                    <input type="radio" name="review-days" value={o.value} checked={days === o.value} onChange={() => setDays(o.value)} />
                    {t(o.label)}
                  </label>
                ))}
              </div>
              <div className="mt-2 flex justify-end">
                <button type="button" className="btn-primary" disabled={busy} onClick={() => void setReview({ days, revoke_devices: false })}>
                  {t('Ligar', { context: 'switch' })}
                </button>
              </div>
            </div>
          )}

          {active && (
            <div className="text-sm text-fg-muted">
              <p>
                {t('ligado até {{date}} por {{admin}}', { date: fmtDateTime(user.review_enabled_until!), admin: adminName(user.review_enabled_by) })}
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => void setReview({ days: null, revoke_devices: false })}>
                  {t('Desligar agora')}
                </button>
                <button type="button" className="btn-ghost text-danger" disabled={busy} onClick={() => setConfirmingOff(true)}>
                  {t('Desligar e revogar os aparelhos')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t('Aparelhos')}</h3>
        {devices === null ? (
          <p className="text-sm text-fg-dim">{t('Carregando…')}</p>
        ) : devices.length === 0 ? (
          <p className="text-sm text-fg-dim">{t('Nenhum aparelho.')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 border-t border-line py-1.5 first:border-0">
                <span className={d.status === 'active' ? '' : 'text-fg-dim'}>
                  {d.name} · {d.model}
                </span>
                {d.status === 'active' && (
                  <button
                    type="button"
                    className="btn-ghost px-2 py-0.5 text-xs text-danger disabled:opacity-50"
                    disabled={revokingId === d.id}
                    onClick={() => void revokeDevice(d)}
                  >
                    {revokingId === d.id ? '…' : t('Revogar')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {events.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t('Atividade')}</h3>
          <ul className="space-y-1 text-sm text-fg-muted">
            {events.map((e) => (
              <li key={e.id} className="flex justify-between gap-3 border-t border-line py-1.5 first:border-0">
                <span>{e.text}</span>
                <span className="shrink-0 text-xs text-fg-dim">{fmtDateTime(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={confirmingOff}
        title={t('Desligar o modo revisão')}
        message={t('Os aparelhos dessa conta perdem o acesso na hora. Isso não pode ser desfeito.')}
        confirmLabel={t('Desligar e revogar')}
        danger
        onConfirm={() => void setReview({ days: null, revoke_devices: true })}
        onCancel={() => setConfirmingOff(false)}
      />
    </div>
  );
}
