import { i18n, useTranslation } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { AUTONOMY_LABEL } from '../lib/automation';
import type { MemoryRule } from '../lib/types';

/**
 * "Regras vigentes" (TER-1010) on the Memória do chat screen: the rules the person approved, and the
 * proposals consolidated from their decisions and concierge notes. Opt-in: nothing changes until they
 * approve, and a policy proposal still asks its `set_automation_policy` cards in the chat.
 */
export function MemoryRulesSection() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<MemoryRule[] | null>(null);
  const [proposals, setProposals] = useState<MemoryRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.chat.rules.list();
      if (!mountedRef.current) return;
      setRules(res.rules);
      setProposals(res.proposals);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setRules((r) => r ?? []);
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível carregar as regras'));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const act = async (rule: MemoryRule, run: () => Promise<unknown>, done: string | null) => {
    setBusyId(rule.id);
    setNotice(null);
    try {
      await run();
      if (!mountedRef.current) return;
      setNotice(done);
      await load();
    } catch (e) {
      if (mountedRef.current) setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível salvar a decisão'));
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  };

  const approve = (r: MemoryRule) =>
    act(r, () => api.chat.rules.approve(r.id), r.kind === 'policy' ? i18n.t('Confirme cada projeto no chat para a política mudar.') : null);
  const reject = (r: MemoryRule) => act(r, () => api.chat.rules.reject(r.id), i18n.t('Recusada, ela não volta por 180 dias.'));
  const remove = (r: MemoryRule) => {
    if (!window.confirm(t('Remover a regra «{{text}}»? As decisões e anotações de origem voltam a valer.', { text: r.text }))) return;
    void act(r, () => api.chat.rules.remove(r.id), null);
  };

  const scope = (r: MemoryRule) => r.project?.name ?? t('Todos os projetos');

  const policyLines = (r: MemoryRule): string[] => {
    if (!r.policy) return [];
    const lines: string[] = [];
    if (r.policy.autonomy) lines.push(t('Mudar o nível para «{{level}}»', { level: t(AUTONOMY_LABEL[r.policy.autonomy]) }));
    if (r.policy.max_parallel !== null) lines.push(t('Máximo em paralelo: {{n}}', { n: r.policy.max_parallel }));
    return lines;
  };

  const sources = (r: MemoryRule) => (
    <>
      <button type="button" className="btn-ghost mt-1 text-xs" aria-expanded={openId === r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
        {t('{{count}} origens', { count: r.sources.length })}
      </button>
      {openId === r.id && (
        <ul className="mt-1 space-y-1 border-l border-line pl-3 text-xs text-fg-muted">
          {r.sources.map((s) => (
            <li key={s.ref}>
              <span className="text-fg">{s.statement}</span>
              {` · ${s.project_name ?? t('sem projeto')}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <section className="mt-6" aria-labelledby="memory-rules-title">
      <h3 id="memory-rules-title" className="text-base font-semibold text-fg">
        {t('Regras vigentes')}
      </h3>
      <p className="mt-1 text-sm text-fg-muted">{t('Decisões e anotações que dizem a mesma coisa viram uma regra só. Nada muda até você aprovar.')}</p>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {notice && <p className="mt-3 text-sm text-fg-dim">{notice}</p>}

      {rules === null ? (
        <p className="mt-4 text-sm text-fg-dim">{t('Carregando…')}</p>
      ) : rules.length === 0 && proposals.length === 0 ? (
        <p className="mt-4 text-sm text-fg-dim">{t('Nenhuma regra vigente nem proposta por enquanto.')}</p>
      ) : (
        <>
          {proposals.length > 0 && (
            <>
              <h4 className="mt-4 text-sm font-semibold text-fg">{t('Propostas')}</h4>
              <ul className="mt-2 space-y-2">
                {proposals.map((r) => (
                  <li key={r.id} className="rounded-lg border border-accent/40 bg-bg-2 p-3 text-sm">
                    <p className="whitespace-pre-wrap text-fg">{r.text}</p>
                    {r.kind === 'policy' && (
                      <div className="mt-1 text-fg-muted">
                        {policyLines(r).map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                        <p className="text-xs text-fg-dim">
                          {t('Projetos: {{names}}', { names: r.policy?.projects.map((p) => p.name).join(', ') ?? '' })}
                        </p>
                      </div>
                    )}
                    <p className="mt-1 text-xs text-fg-dim">{r.kind === 'policy' ? t('Política do trabalho automático') : scope(r)}</p>
                    {sources(r)}
                    {r.status === 'awaiting_confirmation' ? (
                      <p className="mt-2 text-xs text-warn">{t('Aguardando a confirmação no chat')}</p>
                    ) : (
                      <>
                        {r.kind === 'policy' && <p className="mt-2 text-xs text-fg-dim">{t('Cada projeto pede a sua confirmação no chat.')}</p>}
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                          <button type="button" className="btn-primary text-xs" disabled={busyId === r.id} onClick={() => void approve(r)}>
                            {t('Aprovar')}
                          </button>
                          <button type="button" className="btn-ghost text-xs" disabled={busyId === r.id} onClick={() => void reject(r)}>
                            {t('Recusar')}
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {rules.length > 0 && (
            <ul className="mt-4 space-y-2">
              {rules.map((r) => (
                <li key={r.id} className="rounded-lg border border-line bg-bg-2 p-3 text-sm">
                  <p className="whitespace-pre-wrap text-fg">{r.text}</p>
                  {r.kind === 'policy' &&
                    policyLines(r).map((line) => (
                      <p key={line} className="mt-1 text-fg-muted">
                        {line}
                      </p>
                    ))}
                  <p className="mt-1 text-xs text-fg-dim">{r.kind === 'policy' ? t('Projetos: {{names}}', { names: r.policy?.projects.filter((p) => p.applied).map((p) => p.name).join(', ') ?? '' }) : scope(r)}</p>
                  {sources(r)}
                  {r.kind === 'rule' && (
                    <button type="button" className="btn-ghost mt-2 text-xs text-danger" disabled={busyId === r.id} onClick={() => remove(r)}>
                      {t('Remover')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
