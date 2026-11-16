import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { AUTONOMY_LABEL } from '../lib/automation';
import { formatDateTime, relativeTime } from '../lib/format';
import type { ProjectRepo, ProjectRepoScan, ProjectRepoScanMachine, ProjectReposView } from '../lib/types';
import { tk, useTranslation } from '../i18n';

/** pt-BR keys, shown with `t(…)`. */
const STATUS_LABEL: Record<ProjectRepo['status'], string> = {
  ok: tk('ok'),
  unsupported: tk('fora do GitHub'),
  no_access: tk('sem acesso pela integração'),
};

const CANNOT_SCAN: Record<Exclude<ProjectRepoScanMachine['can_scan'], 'ok'>, string> = {
  not_agent: tk('sem o agente do termhub'),
  offline: tk('agente desconectado'),
  no_repo_scan: tk('atualize o agente (0.29.0 ou mais nova)'),
};

const SKIP_LABEL: Record<NonNullable<ProjectRepoScan['skipped']>, string> = {
  not_agent: tk('sem o agente do termhub'),
  offline: tk('agente desconectado'),
  no_repo_scan: tk('atualize o agente (0.29.0 ou mais nova)'),
  throttled: tk('buscado há pouco'),
  refused: tk('a pasta do projeto é / ou a pasta pessoal'),
  not_found: tk('a pasta do projeto não existe'),
  failed: tk('falhou'),
};

/**
 * TER-1071 (spec 2026-10-07 multi-repo R3, R5): the repositories termhub found in the project's folder, where
 * each one sits on every linked machine, when each machine was last scanned, and "Procurar agora". Read-only:
 * levels and the per-repository policy are edited elsewhere in the Setup.
 */
export function RepoDiscovery({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<ProjectReposView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [scans, setScans] = useState<ProjectRepoScan[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.setup
      .repos(projectId)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const scan = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.setup.scanRepos(projectId);
      setView(r);
      setScans(r.scans);
      const created = r.scans.reduce((n, s) => n + s.created.length, 0);
      const missing = r.scans.reduce((n, s) => n + s.missing.length, 0);
      const scanned = r.scans.filter((s) => s.scanned).length;
      setNote(
        scanned === 0
          ? t('Nenhuma máquina pôde ser consultada agora.')
          : t('{{scanned}} máquina(s) consultada(s) · {{created}} novo(s) · {{missing}} ausente(s)', { scanned, created, missing }),
      );
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : t('falhou'));
    } finally {
      setBusy(false);
    }
  };

  if (!view) return null;

  return (
    <section className="rounded-lg border border-line bg-bg-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t('Repositórios na pasta')}</h3>
          <p className="text-xs text-fg-dim">
            {t('O termhub procura sozinho os repositórios git na pasta do projeto de cada máquina. Um repositório novo entra no nível “Só código e PR”, sem deploy.')}
          </p>
        </div>
        <button type="button" className="btn-ghost shrink-0 text-xs" disabled={busy} onClick={() => void scan()}>
          {busy ? t('procurando…') : t('Procurar agora')}
        </button>
      </div>
      {note && <p className="mt-2 text-xs text-fg-muted">{note}</p>}

      <ul className="mt-3 space-y-1 text-xs">
        {view.machines.map((m) => (
          <li key={m.machine_id} className="flex flex-wrap gap-x-2 text-fg-muted">
            <span className="font-medium text-fg">{m.machine}</span>
            <span className="font-mono">{m.cwd}</span>
            <span>
              {m.scanned_at ? (
                <span title={formatDateTime(m.scanned_at)}>{t('última busca {{when}}', { when: relativeTime(m.scanned_at) })}</span>
              ) : (
                t('nunca buscado')
              )}
            </span>
            {m.can_scan !== 'ok' ? (
              <span className="text-warn">· {t(CANNOT_SCAN[m.can_scan])}</span>
            ) : (
              (() => {
                const skipped = scans.find((s) => s.machine_id === m.machine_id)?.skipped;
                return skipped ? <span className="text-warn">· {t(SKIP_LABEL[skipped])}</span> : null;
              })()
            )}
          </li>
        ))}
      </ul>

      {view.repos.length === 0 ? (
        <p className="mt-3 text-xs text-fg-dim">{t('Nenhum repositório encontrado ainda.')}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-fg-dim">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('Key')}</th>
                <th className="py-1 pr-3 font-medium">{t('Repositório')}</th>
                <th className="py-1 pr-3 font-medium">{t('Situação')}</th>
                <th className="py-1 pr-3 font-medium">{t('Nível')}</th>
                <th className="py-1 font-medium">{t('Máquinas')}</th>
              </tr>
            </thead>
            <tbody>
              {view.repos.map((r) => (
                <tr key={r.full_name} className="border-t border-line align-top">
                  <td className="py-1 pr-3 font-mono">{r.key ?? '—'}</td>
                  <td className="py-1 pr-3">
                    <span className="font-mono">{r.full_name}</span>
                    {r.description && <span className="block text-fg-dim">{r.description}</span>}
                  </td>
                  <td className={`py-1 pr-3 ${r.status === 'ok' ? 'text-fg-muted' : 'text-warn'}`}>
                    {t(STATUS_LABEL[r.status])}
                    {!r.enabled && <span className="block text-fg-dim">{t('desligado')}</span>}
                  </td>
                  <td className="py-1 pr-3 text-fg-muted">{t(AUTONOMY_LABEL[r.autonomy])}</td>
                  <td className="py-1">
                    {view.machines.map((m) => {
                      const c = r.machines.find((x) => x.machine_id === m.machine_id);
                      return (
                        <span key={m.machine_id} className="block">
                          <span className="text-fg-muted">{m.machine}:</span>{' '}
                          {!c || c.missing ? <span className="text-fg-dim">{t('ausente')}</span> : <span className="font-mono">{c.dir}</span>}
                        </span>
                      );
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
