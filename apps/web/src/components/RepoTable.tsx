import { Fragment, useState, type ReactNode } from 'react';
import { AUTONOMY_LABEL } from '../lib/automation';
import { dropOverride, levelsUpTo, setOverride, shownRepo } from '../lib/repo-overrides';
import type { AutomationAutonomy, EffectiveRepo, Integration, RepoDefaults, RepoOverride } from '../lib/types';
import { useTranslation } from '../i18n';
import { ListInput } from './AutomationSetup';
import { STATUS_LABEL } from './RepoDiscovery';

interface Props {
  /** what the server answered (`effective_repos`) */
  effective: EffectiveRepo[];
  overrides: RepoOverride[];
  defaults: RepoDefaults;
  /** the project's level: no repository goes above it */
  ceiling: AutomationAutonomy;
  /** the GitHub integrations the person can pick */
  integrations: Integration[];
  /** the machines linked to the project, in order, with the name to show */
  machines: { id: string; name: string }[];
  onOverrides: (next: RepoOverride[]) => void;
  onDefaults: (next: RepoDefaults) => void;
}

const nullable = (v: string) => (v.trim() ? v : null);

/**
 * TER-1072 (spec 2026-10-07 multi-repo §9): the project's repositories and their policy, one row each, for a
 * project with more than one repository. Each row expands into the per-repository fields; an edit becomes
 * an override in `setup.repos`, saved with the rest of the Setup.
 */
export function RepoTable({ effective, overrides, defaults, ceiling, integrations, machines, onOverrides, onDefaults }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  // remounts a row's fields after "Restaurar padrão", so the list inputs show the restored values
  const [resets, setResets] = useState(0);
  const levels = levelsUpTo(ceiling);

  const edit = (e: EffectiveRepo, patch: Partial<RepoOverride>) => onOverrides(setOverride(overrides, e, patch));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('Integração padrão')} hint={t('a que os repositórios encontrados usam')}>
          <select className="input" value={defaults.integration_id ?? ''} onChange={(ev) => onDefaults({ ...defaults, integration_id: ev.target.value || null })}>
            <option value="">{t('— a do repositório do setup —')}</option>
            {integrations.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Profundidade da busca')} hint={t('níveis de pasta abaixo da pasta do projeto')}>
          <select className="input" value={defaults.scan_depth} onChange={(ev) => onDefaults({ ...defaults, scan_depth: Number(ev.target.value) })}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-fg-dim">
            <tr>
              <th className="py-1 pr-3 font-medium">{t('Key')}</th>
              <th className="py-1 pr-3 font-medium">{t('Repositório')}</th>
              <th className="py-1 pr-3 font-medium">{t('Pasta')}</th>
              <th className="py-1 pr-3 font-medium">{t('Situação')}</th>
              <th className="py-1 pr-3 font-medium">{t('Base')}</th>
              <th className="py-1 pr-3 font-medium">{t('Nível')}</th>
              <th className="py-1 pr-3 font-medium">{t('Deploy')}</th>
              <th className="py-1 pr-3 font-medium">{t('Ordem de merge')}</th>
              <th className="py-1 font-medium">{t('Ligado')}</th>
            </tr>
          </thead>
          <tbody>
            {effective.map((e) => {
              const r = shownRepo(e, overrides);
              const o = overrides.find((x) => x.full_name.toLowerCase() === e.full_name.toLowerCase());
              const expanded = open === e.full_name;
              return (
                <Fragment key={e.full_name}>
                  <tr className={`border-t border-line align-top ${r.enabled ? '' : 'text-fg-dim'}`}>
                    <td className="py-1 pr-3 font-mono">{r.key ?? '—'}</td>
                    <td className="py-1 pr-3">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : e.full_name)}
                      >
                        <span className="font-mono">{expanded ? '▾' : '▸'} {r.full_name}</span>
                      </button>
                      {r.description && <span className="block text-fg-dim">{r.description}</span>}
                    </td>
                    <td className="py-1 pr-3">
                      {machines.map((m) => {
                        const c = r.checkouts.find((x) => x.machine_id === m.id);
                        return (
                          <span key={m.id} className="block">
                            {machines.length > 1 && <span className="text-fg-muted">{m.name}: </span>}
                            {!c || c.missing_at ? <span className="text-fg-dim">{t('ausente')}</span> : <span className="font-mono">{c.dir}</span>}
                          </span>
                        );
                      })}
                    </td>
                    <td className={`py-1 pr-3 ${r.status === 'ok' ? 'text-fg-muted' : 'text-warn'}`}>{t(STATUS_LABEL[r.status])}</td>
                    <td className="py-1 pr-3 font-mono">{r.base_branch}</td>
                    <td className="py-1 pr-3 text-fg-muted">{t(AUTONOMY_LABEL[r.autonomy])}</td>
                    <td className="py-1 pr-3 font-mono">{r.deploy_workflow ?? '—'}</td>
                    <td className="py-1 pr-3">{r.merge_order}</td>
                    <td className="py-1">
                      <input
                        type="checkbox"
                        role="switch"
                        className="accent-accent"
                        aria-label={t('Ligar {{repo}} no trabalho automático', { repo: r.full_name })}
                        checked={r.enabled}
                        onChange={(ev) => edit(e, { enabled: ev.target.checked })}
                      />
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-t border-line">
                      <td colSpan={9} className="py-3">
                        <RepoFields
                          key={`${e.full_name}:${resets}`}
                          entry={e}
                          shown={r}
                          override={o}
                          levels={levels}
                          integrations={integrations}
                          onEdit={(patch) => edit(e, patch)}
                          onReset={() => {
                            onOverrides(dropOverride(overrides, e.full_name));
                            setResets((n) => n + 1);
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-fg-dim">{t('Um repositório encontrado começa em “Só código e PR”, sem deploy. O nível de cada um nunca passa o do projeto, em Automação.')}</p>
    </div>
  );
}

function RepoFields({
  entry,
  shown,
  override,
  levels,
  integrations,
  onEdit,
  onReset,
}: {
  entry: EffectiveRepo;
  shown: EffectiveRepo;
  override: RepoOverride | undefined;
  levels: AutomationAutonomy[];
  integrations: Integration[];
  onEdit: (patch: Partial<RepoOverride>) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  // what an empty field falls back to is the server's value for this repository, without the override
  const text = (field: 'base_branch' | 'branch_pattern' | 'description') => (override ? (override[field] ?? '') : '');
  return (
    <div className="space-y-3 rounded-md border border-line p-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label={t('Branch base')} hint={t('vazio = a branch padrão do checkout')}>
          <input className="input font-mono" value={text('base_branch')} placeholder={entry.base_branch} onChange={(ev) => onEdit({ base_branch: nullable(ev.target.value) })} />
        </Field>
        <Field label={t('Padrão da branch')} hint={t('vazio = o do projeto')}>
          <input className="input font-mono" value={text('branch_pattern')} placeholder={entry.branch_pattern} onChange={(ev) => onEdit({ branch_pattern: nullable(ev.target.value) })} />
        </Field>
        <Field label={t('Workflow de deploy')}>
          <input
            className="input font-mono"
            value={shown.deploy_workflow ?? ''}
            /* i18n-ignore */ placeholder="deploy.yml"
            onChange={(ev) => onEdit({ deploy_workflow: nullable(ev.target.value) })}
          />
        </Field>
        <Field label={t('Nível')}>
          <select className="input" aria-label={t('Nível de {{repo}}', { repo: entry.full_name })} value={shown.autonomy} onChange={(ev) => onEdit({ autonomy: ev.target.value as AutomationAutonomy })}>
            {levels.map((l) => (
              <option key={l} value={l}>
                {t(AUTONOMY_LABEL[l])}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Integração')}>
          <select className="input" value={override?.integration_id ?? ''} onChange={(ev) => onEdit({ integration_id: ev.target.value || null })}>
            <option value="">{t('— a padrão —')}</option>
            {integrations.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Ordem de merge')} hint={t('os PRs de um card mesclam do menor para o maior')}>
          <input
            type="number"
            className="input"
            min={0}
            max={999}
            step={1}
            value={shown.merge_order}
            onChange={(ev) => {
              const n = Number(ev.target.value);
              if (ev.target.value !== '' && Number.isInteger(n) && n >= 0 && n <= 999) onEdit({ merge_order: n });
            }}
          />
        </Field>
      </div>
      <Field label={t('Descrição')} hint={t('vazio = a que a busca leu no repositório')}>
        <input className="input" maxLength={200} value={text('description')} placeholder={entry.description ?? ''} onChange={(ev) => onEdit({ description: nullable(ev.target.value) })} />
      </Field>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t('Checks obrigatórios')} hint={t('um por linha')}>
          <ListInput value={shown.required_checks} onChange={(v) => onEdit({ required_checks: v })} /* i18n-ignore */ placeholder="ci.yml" />
        </Field>
        <Field label={t('Workflows de publicação')} hint={t('um por linha')}>
          <ListInput value={shown.release_workflows} onChange={(v) => onEdit({ release_workflows: v })} /* i18n-ignore */ placeholder="publish.yml" />
        </Field>
        <Field label={t('Caminhos que pedem publicação')} hint={t('relativos à raiz do repositório, um por linha')}>
          <ListInput value={shown.release_paths} onChange={(v) => onEdit({ release_paths: v })} /* i18n-ignore */ placeholder="packages/sdk/package.json" />
        </Field>
        <Field label={t('Caminhos de build de loja')} hint={t('nunca mesclados sozinhos; um por linha')}>
          <ListInput value={shown.store_paths} onChange={(v) => onEdit({ store_paths: v })} /* i18n-ignore */ placeholder="app.json" />
        </Field>
      </div>
      {override && (
        <button type="button" className="btn-ghost text-xs" onClick={onReset}>
          {t('Restaurar padrão')}
        </button>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">
        {label}
        {hint && <span className="ml-1 normal-case tracking-normal text-fg-dim">— {hint}</span>}
      </label>
      {children}
    </div>
  );
}
