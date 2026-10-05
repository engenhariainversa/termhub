import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import type { HardwareSnapshot } from '../lib/types';
import { formatNumber } from '../lib/format';
import { i18n, useTranslation } from '../i18n';

/**
 * Home "Hardware" tab: live CPU / memory / disks / temps / GPU / top processes of a machine.
 * Shown only to roles granted hardware:read (see HomePage).
 */

const POLL_MS = 5000;
const MACHINE_KEY = 'termhub:hardware-machine';

/** A number with exactly `digits` decimals, in the language on screen ("25,3" / "25.3"). */
const fixed = (n: number, digits: number) => formatNumber(n, { minimumFractionDigits: digits, maximumFractionDigits: digits });

function gb(kb: number | null | undefined): string {
  if (kb == null) return '—';
  const g = kb / 1048576;
  if (g >= 1000) return `${fixed(g / 1024, 2)} TB`;
  if (g >= 10) return `${fixed(g, 0)} GB`;
  if (g >= 1) return `${fixed(g, 1)} GB`;
  return `${formatNumber(Math.round(kb / 1024))} MB`;
}

function uptime(s: number | null): string {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? i18n.t('{{d}} d {{h}} h', { d, h }) : h > 0 ? i18n.t('{{h}} h {{m}} min', { h, m }) : i18n.t('{{m}} min', { m });
}

function tone(pct: number | null): 'ok' | 'warn' | 'danger' | 'none' {
  if (pct == null) return 'none';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warn';
  return 'ok';
}
const BAR: Record<ReturnType<typeof tone>, string> = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', none: 'bg-bg-4' };
const TEXT: Record<ReturnType<typeof tone>, string> = { ok: 'text-fg', warn: 'text-warn', danger: 'text-danger', none: 'text-fg-dim' };

/** Thin meter with the value written out: color marks state, the number carries the reading. */
function Meter({ pct, label, detail }: { pct: number | null; label: string; detail?: string }) {
  const t = tone(pct);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums">
          <span className={TEXT[t]}>{pct == null ? '—' : `${Math.round(pct)}%`}</span>
          {detail && <span className="text-fg-dim"> · {detail}</span>}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-4">
        <div className={`h-full rounded-full transition-[width] ${BAR[t]}`} style={{ width: `${pct == null ? 0 : Math.min(100, Math.max(1, pct))}%` }} />
      </div>
    </div>
  );
}

function Tile({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-bg-2 p-4 ${className}`}>
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-fg-dim">{title}</h2>
      {children}
    </section>
  );
}

export function HardwareView() {
  const { t } = useTranslation();
  const { machines, statuses } = useData();
  const [machineId, setMachineId] = useState<string>(() => {
    try {
      return localStorage.getItem(MACHINE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [snap, setSnap] = useState<HardwareSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef(false);

  // default: the termhub host (registered as host.docker.internal) or the first machine
  useEffect(() => {
    if (machineId && machines.some((m) => m.id === machineId)) return;
    const def = machines.find((m) => m.host === 'host.docker.internal') ?? machines[0];
    if (def) setMachineId(def.id);
  }, [machines, machineId]);

  const load = useCallback(async () => {
    if (!machineId || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const r = await api.machines.hardware(machineId);
      setSnap(r.hardware);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao coletar o hardware'));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => {
    if (!machineId) return;
    try {
      localStorage.setItem(MACHINE_KEY, machineId);
    } catch {
      /* ignore */
    }
    setSnap(null);
    setError(null);
    void load();
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [machineId, load]);

  const machine = machines.find((m) => m.id === machineId);
  const memPct = snap?.mem_total_kb && snap.mem_used_kb != null ? (snap.mem_used_kb / snap.mem_total_kb) * 100 : null;
  const swapPct = snap?.swap_total_kb ? ((snap.swap_used_kb ?? 0) / snap.swap_total_kb) * 100 : null;
  const loadPct = snap?.load && snap.ncpu ? (snap.load[0] / snap.ncpu) * 100 : null;

  return (
    <div>
      <div className="mb-5 flex items-end gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('Hardware')}</h2>
          <p className="text-sm text-fg-muted">
            {snap ? (
              t('{{host}} · {{cpu}} · {{cores}} núcleos · ligado há {{uptime}}', {
                host: snap.hostname ?? machine?.name ?? '',
                cpu: snap.cpu_model ?? 'CPU ?', // i18n-ignore
                cores: snap.ncpu ?? '?',
                uptime: uptime(snap.uptime_s),
              })
            ) : (
              t('Uso de CPU, memória, discos e processos, atualizado a cada 5 s.')
            )}
          </p>
        </div>
        <span className="ml-auto flex items-center gap-2">
          {loading && <span className="text-xs text-fg-dim">{t('atualizando…')}</span>}
          <select className="input w-auto py-1 text-xs" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {statuses[m.id] === 'offline' ? t(' (offline)') : ''}
              </option>
            ))}
          </select>
        </span>
      </div>

      {error && <p className="mb-3 rounded border border-danger/40 bg-danger/10 p-2 text-sm text-danger">{error}</p>}
      {!snap && !error && <p className="text-sm text-fg-dim">{t('Coletando…')}</p>}

      {snap && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Tile title="CPU" /* i18n-ignore */>
            <div className="space-y-3">
              <Meter pct={snap.cpu_pct} label={t('uso')} />
              <Meter
                pct={loadPct}
                label={t('carga 1 min')}
                detail={snap.load ? t('{{l1}} · 5 min {{l5}} · 15 min {{l15}}', { l1: fixed(snap.load[0], 2), l5: fixed(snap.load[1], 2), l15: fixed(snap.load[2], 2) }) : undefined}
              />
            </div>
          </Tile>
          <Tile title={t('Memória')}>
            <div className="space-y-3">
              <Meter pct={memPct} label="RAM" /* i18n-ignore */ detail={t('{{used}} de {{total}}', { used: gb(snap.mem_used_kb), total: gb(snap.mem_total_kb) })} />
              <Meter
                pct={swapPct}
                label={t('swap')}
                detail={snap.swap_total_kb ? t('{{used}} de {{total}}', { used: gb(snap.swap_used_kb), total: gb(snap.swap_total_kb) }) : t('sem swap')}
              />
            </div>
          </Tile>
          <Tile title={t('Temperaturas')}>
            {snap.temps.length === 0 && snap.gpus.length === 0 ? (
              <p className="text-xs text-fg-dim">{snap.os === 'macos' ? t('O macOS não expõe sensores sem ferramentas extras.') : t('Nenhum sensor encontrado.')}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {snap.temps.map((s, i) => (
                  <li key={`${s.label}-${i}`} className="rounded bg-bg-3 px-2 py-1 text-xs">
                    <span className="text-fg-muted">{s.label}</span>{' '}
                    {/* i18n-ignore: °C is a unit */}
                    <span className={`tabular-nums ${s.c >= 85 ? 'text-danger' : s.c >= 70 ? 'text-warn' : 'text-fg'}`}>{Math.round(s.c)}°C</span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>
          {snap.gpus.length > 0 && (
            <Tile title="GPU" /* i18n-ignore */>
              <ul className="space-y-3">
                {snap.gpus.map((g, i) => (
                  <li key={i} className="space-y-2">
                    <p className="text-xs text-fg">{g.name}</p>
                    <Meter pct={g.utilization} label={t('uso')} detail={g.temp_c != null ? `${g.temp_c}°C` : undefined} />
                    {g.mem_total_mb ? <Meter pct={((g.mem_used_mb ?? 0) / g.mem_total_mb) * 100} label="VRAM" /* i18n-ignore */ detail={t('{{used}} de {{total}} MB', { used: g.mem_used_mb, total: g.mem_total_mb })} /> : null}
                  </li>
                ))}
              </ul>
            </Tile>
          )}
          <Tile title={t('Discos')} className="md:col-span-2 xl:col-span-2">
            {snap.disks.length === 0 ? (
              <p className="text-xs text-fg-dim">{t('Nenhum disco encontrado.')}</p>
            ) : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {snap.disks.map((d) => (
                  <li key={d.mount} title={d.source}>
                    <Meter pct={(d.used_kb / d.size_kb) * 100} label={d.mount} detail={t('{{free}} livres de {{total}}', { free: gb(d.avail_kb), total: gb(d.size_kb) })} />
                  </li>
                ))}
              </ul>
            )}
          </Tile>
          <Tile title={t('Processos (por CPU)')}>
            {snap.processes.length === 0 ? (
              <p className="text-xs text-fg-dim">—</p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {snap.processes.map((p, i) => (
                    <tr key={i} className="border-t border-line first:border-0">
                      <td className="max-w-0 truncate py-1 pr-2 font-mono" title={p.command}>
                        {p.command}
                      </td>
                      <td className="w-14 py-1 text-right tabular-nums">{fixed(p.cpu, 1)}%</td>
                      <td className="w-16 py-1 text-right tabular-nums text-fg-dim">{t('{{pct}}% mem', { pct: fixed(p.mem, 1) })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Tile>
        </div>
      )}
    </div>
  );
}
