import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { UploadEntry, UploadMachineStatus } from '../lib/types';
import { ConfirmDialog } from './Modal';
import { formatDate as localDate, formatNumber, formatTime } from '../lib/format';
import { i18n, tk, Trans, useTranslation } from '../i18n';

/**
 * Settings → Arquivos: what is sitting in ~/.cache/termhub/paste/ on every machine (files pasted or
 * dropped on the terminals), attributed to who sent them, with per-user and per-type totals and a
 * delete button. The list is read live from the machines on every load.
 */

type Kind = 'image' | 'pdf' | 'text' | 'archive' | 'audio' | 'video' | 'other';
const KIND_LABEL: Record<Kind, string> = {
  image: tk('Imagens'),
  pdf: tk('PDFs'),
  text: tk('Texto e código'),
  archive: tk('Arquivos compactados'),
  audio: tk('Áudio'),
  video: tk('Vídeo'),
  other: tk('Outros'),
};
const KIND_ORDER: Kind[] = ['image', 'pdf', 'text', 'archive', 'audio', 'video', 'other'];

const EXT_KIND: Record<string, Kind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', heic: 'image', bmp: 'image',
  pdf: 'pdf',
  txt: 'text', md: 'text', json: 'text', csv: 'text', log: 'text', yml: 'text', yaml: 'text', xml: 'text', html: 'text', css: 'text',
  js: 'text', ts: 'text', tsx: 'text', jsx: 'text', py: 'text', rb: 'text', go: 'text', rs: 'text', java: 'text', kt: 'text', swift: 'text', sh: 'text', sql: 'text',
  zip: 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', rar: 'archive', '7z': 'archive',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', webm: 'video', mp4: 'video', mov: 'video',
};

function kindOf(f: UploadEntry): Kind {
  const mime = f.upload?.mime ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  const ext = f.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return EXT_KIND[ext] ?? 'other';
}

/** "paste-20260918-104512-ab12cd-report.pdf" → "report.pdf" (what the user sees in the terminal is the full path). */
function displayName(name: string): string {
  return name.replace(/^paste-\d{8}-\d{6}-[0-9a-f]{6}-/, '');
}

function formatBytes(n: number): string {
  const fixed = (v: number, digits: number) => formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (n >= 1073741824) return `${fixed(n / 1073741824, 2)} GB`;
  if (n >= 1048576) return `${fixed(n / 1048576, 1)} MB`;
  if (n >= 1024) return `${formatNumber(Math.round(n / 1024))} KB`;
  return `${formatNumber(n)} B`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${localDate(d)} ${formatTime(d, { hour: '2-digit', minute: '2-digit' })}`;
}

const UNKNOWN_USER = '__unknown__';

/**
 * Who sent a file: the upload record when there is one; otherwise the machine's owner, since only
 * they can paste into it (files older than the uploads table, or whose sender was deleted).
 */
interface Sender {
  key: string;
  label: string;
  email: string | null;
  /** true when taken from the machine owner rather than a record */
  inferred: boolean;
}

function senderOf(f: UploadEntry, machines: Map<string, UploadMachineStatus>): Sender {
  if (f.upload?.user_id) return { key: f.upload.user_id, label: f.upload.user_name ?? f.upload.user_email ?? f.upload.user_id, email: f.upload.user_email, inferred: false };
  const m = machines.get(f.machine_id);
  if (m?.owner_id) return { key: m.owner_id, label: m.owner_name ?? i18n.t('Dono da máquina'), email: null, inferred: true };
  return { key: UNKNOWN_USER, label: i18n.t('Sem registro'), email: null, inferred: false };
}

interface Totals {
  key: string;
  label: string;
  files: number;
  bytes: number;
}

function totalsBy(files: UploadEntry[], key: (f: UploadEntry) => string, label: (f: UploadEntry) => string): Totals[] {
  const map = new Map<string, Totals>();
  for (const f of files) {
    const k = key(f);
    const row = map.get(k) ?? { key: k, label: label(f), files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += f.bytes;
    map.set(k, row);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}

export function UploadsView() {
  const { t, i18n: inst } = useTranslation();
  const language = inst.language;
  const { can } = useAuth();
  const [files, setFiles] = useState<UploadEntry[] | null>(null);
  const [machines, setMachines] = useState<UploadMachineStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [userFilter, setUserFilter] = useState<string>('');
  const [kindFilter, setKindFilter] = useState<Kind | ''>('');
  const [machineFilter, setMachineFilter] = useState<string>('');
  const [deleting, setDeleting] = useState<UploadEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.uploads.list();
      setFiles(r.files);
      setMachines(r.machines);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao listar os arquivos'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const machineName = useMemo(() => new Map(machines.map((m) => [m.id, m.name])), [machines]);
  const machineById = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines]);
  const all = files ?? [];
  const userKey = useCallback((f: UploadEntry) => senderOf(f, machineById).key, [machineById]);
  // `language` re-labels the totals ("Sem registro", the kinds) when the language changes
  const byUser = useMemo(() => totalsBy(all, userKey, (f) => senderOf(f, machineById).label), [all, userKey, machineById, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const byKind = useMemo(
    () => totalsBy(all, kindOf, (f) => i18n.t(KIND_LABEL[kindOf(f)])).sort((a, b) => KIND_ORDER.indexOf(a.key as Kind) - KIND_ORDER.indexOf(b.key as Kind)),
    [all, language], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const totalBytes = all.reduce((n, f) => n + f.bytes, 0);
  const visible = all.filter((f) => (!userFilter || userKey(f) === userFilter) && (!kindFilter || kindOf(f) === kindFilter) && (!machineFilter || f.machine_id === machineFilter));
  const offline = machines.filter((m) => !m.ok);

  const remove = async (f: UploadEntry) => {
    setDeleting(null);
    setBusy(`${f.machine_id}/${f.name}`);
    setNotice(null);
    try {
      const r = await api.uploads.remove(f.machine_id, f.name);
      setFiles((prev) => (prev ?? []).filter((x) => !(x.machine_id === f.machine_id && x.name === f.name)));
      setNotice(
        r.existed
          ? t('{{file}} removido de {{machine}}.', { file: displayName(f.name), machine: machineName.get(f.machine_id) ?? t('máquina') })
          : t('{{file}} já não existia na máquina; registro limpo.', { file: displayName(f.name) }),
      );
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : t('Falha ao remover o arquivo'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{t('Arquivos enviados aos terminais')}</h2>
          <p className="mt-1 text-xs text-fg-muted">
            <Trans
              i18nKey="Tudo que foi colado ou arrastado nos terminais e está em <0>~/.cache/termhub/paste/</0> em cada máquina. A lista é lida das máquinas agora; arquivos com mais de 7 dias são apagados automaticamente a cada novo envio."
              components={[<code key="p" className="rounded bg-bg-3 px-1" />]}
            />
          </p>
        </div>
        <button className="btn-ghost shrink-0" onClick={() => void load()} disabled={loading}>
          {loading ? t('Atualizando…') : t('Atualizar', { context: 'refresh' })}
        </button>
      </div>

      {error && <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      {offline.length > 0 && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          {t('Sem acesso a {{machines}}: os arquivos dessas máquinas aparecem pelo registro e podem já não existir.', {
            machines: offline.map((m) => `${m.name} (${m.error ?? t('erro')})`).join(', '),
          })}
        </p>
      )}
      {notice && <p className="text-xs text-fg-muted">{notice}</p>}

      {files && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-line bg-bg-2 p-3">
              <div className="text-[11px] uppercase tracking-wide text-fg-dim">{t('Total')}</div>
              <div className="mt-1 text-lg font-semibold">{formatBytes(totalBytes)}</div>
              <div className="text-xs text-fg-muted">
                {t('{{files}} em {{machines}}', { files: t('{{count}} arquivos', { count: all.length }), machines: t('{{count}} máquinas', { count: machines.length }) })}
              </div>
            </div>
            <div className="rounded-md border border-line bg-bg-2 p-3">
              <div className="text-[11px] uppercase tracking-wide text-fg-dim">{t('Por usuário')}</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {byUser.length === 0 && <li className="text-fg-dim">—</li>}
                {byUser.map((row) => (
                  <li key={row.key} className="flex justify-between gap-2">
                    <button className={`truncate text-left hover:underline ${userFilter === row.key ? 'text-accent' : ''}`} onClick={() => setUserFilter(userFilter === row.key ? '' : row.key)}>
                      {row.label}
                    </button>
                    <span className="shrink-0 text-fg-muted">
                      {row.files} · {formatBytes(row.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-md border border-line bg-bg-2 p-3">
              <div className="text-[11px] uppercase tracking-wide text-fg-dim">{t('Por tipo')}</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {byKind.length === 0 && <li className="text-fg-dim">—</li>}
                {byKind.map((row) => (
                  <li key={row.key} className="flex justify-between gap-2">
                    <button className={`truncate text-left hover:underline ${kindFilter === row.key ? 'text-accent' : ''}`} onClick={() => setKindFilter(kindFilter === row.key ? '' : (row.key as Kind))}>
                      {row.label}
                    </button>
                    <span className="shrink-0 text-fg-muted">
                      {row.files} · {formatBytes(row.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select className="input w-auto py-1" value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
              <option value="">{t('Todos os usuários')}</option>
              {byUser.map((row) => (
                <option key={row.key} value={row.key}>
                  {row.label}
                </option>
              ))}
            </select>
            <select className="input w-auto py-1" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as Kind | '')}>
              <option value="">{t('Todos os tipos')}</option>
              {byKind.map((row) => (
                <option key={row.key} value={row.key}>
                  {row.label}
                </option>
              ))}
            </select>
            <select className="input w-auto py-1" value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)}>
              <option value="">{t('Todas as máquinas')}</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            {(userFilter || kindFilter || machineFilter) && (
              <button
                className="text-fg-muted hover:text-fg hover:underline"
                onClick={() => {
                  setUserFilter('');
                  setKindFilter('');
                  setMachineFilter('');
                }}
              >
                {t('Limpar filtros')}
              </button>
            )}
            <span className="ml-auto text-fg-dim">
              {t('{{shown}} de {{total}}', { shown: visible.length, total: all.length })}
            </span>
          </div>

          <div className="overflow-hidden rounded-md border border-line">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-fg-dim">
                <tr className="border-b border-line">
                  <th className="px-3 py-2">{t('Arquivo')}</th>
                  <th className="px-3 py-2">{t('Tipo')}</th>
                  <th className="px-3 py-2 text-right">{t('Tamanho')}</th>
                  <th className="px-3 py-2">{t('Usuário')}</th>
                  <th className="px-3 py-2">{t('Máquina')}</th>
                  <th className="px-3 py-2">{t('Enviado em')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-sm text-fg-dim">
                      {all.length === 0 ? t('Nenhum arquivo enviado.') : t('Nada com esses filtros.')}
                    </td>
                  </tr>
                )}
                {visible.map((f) => {
                  const key = `${f.machine_id}/${f.name}`;
                  return (
                    <tr key={key} className="border-b border-line/60 last:border-0">
                      <td className="max-w-[28rem] px-3 py-2">
                        <div className="truncate font-medium" title={f.name}>
                          {displayName(f.name)}
                        </div>
                        {!f.on_disk && <div className="text-[11px] text-warn">{t('máquina inacessível — pode já ter sido apagado')}</div>}
                      </td>
                      <td className="px-3 py-2 text-fg-muted">{t(KIND_LABEL[kindOf(f)])}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{formatBytes(f.bytes)}</td>
                      <td className="px-3 py-2">
                        {(() => {
                          const s = senderOf(f, machineById);
                          if (s.key === UNKNOWN_USER)
                            return (
                              <span className="text-fg-dim" title={t('Enviado antes do registro de uploads e a máquina não tem dono')}>
                                {t('Sem registro')}
                              </span>
                            );
                          return (
                            <span title={s.inferred ? t('Sem registro do envio: atribuído ao dono da máquina, o único que cola nela') : (s.email ?? undefined)}>
                              {s.label}
                              {s.inferred && <span className="ml-1 text-[10px] text-fg-dim">{t('(dono da máquina)')}</span>}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2 text-fg-muted">{machineName.get(f.machine_id) ?? f.machine_id}</td>
                      <td className="px-3 py-2 text-xs text-fg-muted">{formatDate(f.upload?.created_at ?? f.modified_at)}</td>
                      <td className="px-3 py-2 text-right">
                        {can('uploads', 'delete') && (
                          <button className="btn-danger px-2 py-1 text-xs" onClick={() => setDeleting(f)} disabled={busy === key}>
                            {busy === key ? t('Removendo…') : t('Remover')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!files && !error && <p className="text-sm text-fg-dim">{t('Lendo as máquinas…')}</p>}

      <ConfirmDialog
        open={!!deleting}
        title={t('Remover arquivo')}
        message={
          deleting
            ? t('Apagar {{file}} ({{size}}) de {{machine}}? Se um terminal ainda referencia o caminho, ele deixa de existir.', {
                file: displayName(deleting.name),
                size: formatBytes(deleting.bytes),
                machine: machineName.get(deleting.machine_id) ?? t('máquina'),
              })
            : ''
        }
        confirmLabel={t('Remover')}
        danger
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
