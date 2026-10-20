import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ChatCommandRule, ChatDefault, ChatFileGrant, ChatGrantListItem } from '../lib/types';
import { commandRuleLabel } from './chat/ChatActionCard';
import { ChatAutoThresholds } from './ChatAutoThresholds';
import { untilLabel } from './chat/grant-time';
import { endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTitleLabel } from './chat/grant-list-text';
import { i18n, useTranslation } from '../i18n';

const loadFailedText = () => i18n.t('Não foi possível carregar as permissões.');

// A tab row also names its project (a tab grant is always inside one); a project row's title already
// names the project, so nothing is appended there.
const title = (g: ChatGrantListItem) => `${grantTitleLabel(g)}${g.kind === 'tab' && g.project_name ? ` · ${g.project_name}` : ''}`;

/**
 * "Permissões do chat" (spec 2026-09-26 §4.2, §6): what the chat was allowed to do without asking, in
 * every conversation — trusted tabs, trusted projects and standing grants ("Liberar sem prazo", which
 * have no expiry and outlive their conversation), the grants in force with Revogar, and the
 * paged history. Also the thresholds of an automatic answer from memory (TER-642, `ChatAutoThresholds`). Reads on open, after a revoke and on "Carregar mais"; no live updates.
 */
export function ChatGrantsView() {
  const { t } = useTranslation();
  const [active, setActive] = useState<ChatGrantListItem[] | null>(null);
  const [history, setHistory] = useState<ChatGrantListItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // Loaded apart from the grants: a failure here hides the section, never the grants below it.
  const [defaults, setDefaults] = useState<ChatDefault[] | null>(null);
  const [savingKind, setSavingKind] = useState<ChatDefault['kind'] | null>(null);
  // "Permitir sempre nesta pasta" (TER-1086), loaded apart too: an older server answers 404 and the section stays hidden.
  const [folders, setFolders] = useState<ChatFileGrant[] | null>(null);
  const loadFolders = useCallback(() => api.listChatFileGrants().then((r) => setFolders(r.grants), () => setFolders(null)), []);

  const load = useCallback(async () => {
    setError(null);
    setLoadFailed(false);
    try {
      const [a, h] = await Promise.all([api.listChatGrants({ state: 'active' }), api.listChatGrants({ state: 'ended' })]);
      setActive(a.grants);
      setHistory(h.grants);
      setNext(h.next_cursor);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    api.listChatDefaults().then((r) => setDefaults(r.defaults), () => setDefaults(null));
  }, []);

  // TER-1081: the run_command rules, loaded apart like the defaults — a failure hides only this section.
  const [rules, setRules] = useState<{ active: ChatCommandRule[]; ended: ChatCommandRule[] } | null>(null);
  const loadRules = useCallback(() => api.listChatCommandRules().then(setRules, () => setRules(null)), []);
  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const revokeRule = async (id: string) => {
    setRevokingId(id);
    setError(null);
    try {
      await api.revokeChatCommandRule(id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) setError(e instanceof ApiError ? e.message : t('Não foi possível revogar a permissão.'));
    }
    setRevokingId(null);
    await loadRules();
  };

  /** Where a rule applies and until when, under its label. */
  const ruleDetails = (r: ChatCommandRule) =>
    [
      r.machine_ids.length ? t('só em {{machines}}', { machines: r.machine_names.length ? r.machine_names.join(', ') : t('máquinas que não existem mais') }) : t('todas as máquinas'),
      r.state === 'revoked' && r.revoked_at
        ? t('revogada em {{date}}', { date: endedAtLabel(r.revoked_at) })
        : r.expires_at
          ? r.state === 'expired'
            ? t('venceu em {{date}}', { date: endedAtLabel(r.expires_at) })
            : t('até {{date}}', { date: endedAtLabel(r.expires_at) })
          : t('sem prazo'),
    ].join(' · ');

  const toggleDefault = async (d: ChatDefault) => {
    setSavingKind(d.kind);
    setError(null);
    try {
      setDefaults((await api.setChatDefault(d.kind, !d.allowed)).defaults);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Não foi possível salvar a alteração.'));
    } finally {
      setSavingKind(null);
    }
  };

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setError(null);
    try {
      const h = await api.listChatGrants({ state: 'ended', cursor: next });
      setHistory((prev) => [...(prev ?? []), ...h.grants]);
      setNext(h.next_cursor);
    } catch {
      setError(loadFailedText());
    } finally {
      setLoadingMore(false);
    }
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    setError(null);
    try {
      await api.revokeChatGrant(id);
    } catch (e) {
      // 409: already revoked (another screen, or a reset) — the list is stale, not wrong.
      if (!(e instanceof ApiError && e.status === 409)) {
        setError(e instanceof ApiError ? e.message : t('Não foi possível revogar a permissão.'));
        setRevokingId(null);
        return;
      }
    }
    setRevokingId(null);
    await load();
  };

  const revokeFolder = async (id: string) => {
    setRevokingId(id);
    setError(null);
    try {
      await api.revokeChatFileGrant(id);
    } catch (e) {
      // 404: already revoked on another screen — the list is stale, not wrong.
      if (!(e instanceof ApiError && e.status === 404)) setError(e instanceof ApiError ? e.message : t('Não foi possível revogar a permissão.'));
    }
    setRevokingId(null);
    await loadFolders();
  };

  if (loadFailed)
    return (
      <div className="space-y-2 text-sm">
        <p className="text-danger">{loadFailedText()}</p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          {t('Tentar de novo')}
        </button>
      </div>
    );
  if (active === null || history === null) return <p className="text-sm text-fg-dim">{t('Carregando…')}</p>;

  return (
    <div className="space-y-6">
      <p className="text-sm text-fg-muted">{t('O que o chat pode fazer sem pedir confirmação. Permissões de conversa valem por até 24 horas; as sem prazo valem até você revogar.')}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {defaults && (
        <section aria-labelledby="chat-defaults" className="space-y-2">
          <h2 id="chat-defaults" className="text-sm font-semibold text-fg">
            {t('Liberadas por padrão')}
          </h2>
          <p className="text-xs text-fg-dim">
            {t('O chat faz estas ações sem pedir confirmação; leituras nunca pedem. Desmarque para voltar a pedir. Sempre pedem confirmação: apagar card, rodar comando fora da lista de leitura e das regras, responder permissões, texto com “!”, as teclas Ctrl+C e Esc, fechar aba trabalhando, integrações e status de ticket.')}
          </p>
          <ul className="space-y-1">
            {defaults.map((d) => (
              <li key={d.kind}>
                <label className="flex items-center gap-2 text-sm text-fg">
                  <input type="checkbox" checked={d.allowed} disabled={savingKind !== null} onChange={() => void toggleDefault(d)} />
                  <span>{d.label.charAt(0).toUpperCase() + d.label.slice(1)}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rules && (
        <section aria-labelledby="chat-command-rules" className="space-y-2">
          <h2 id="chat-command-rules" className="text-sm font-semibold text-fg">
            {t('Comandos liberados')}
          </h2>
          <p className="text-xs text-fg-dim">
            {t('Comandos que o chat roda sem pedir confirmação numa aba de shell. Crie uma regra pelo card de confirmação de um comando ou pedindo ao chat. Sempre pedem confirmação, com ou sem regra: comandos encadeados (;, &&, |), redirecionamentos, substituições, sudo, rm, kill, git push --force, git reset --hard, git clean, “!” e o que tocar segredos.')}
          </p>
          {rules.active.length === 0 ? (
            <p className="text-sm text-fg-dim">{t('Nenhuma regra de comando ativa.')}</p>
          ) : (
            <ul className="space-y-2">
              {rules.active.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-fg">{commandRuleLabel(r)}</p>
                    <p className="text-xs text-fg-dim">{ruleDetails(r)}</p>
                  </div>
                  <button type="button" className="btn-ghost shrink-0" disabled={revokingId === r.id} onClick={() => void revokeRule(r.id)}>
                    {t('Revogar')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {rules.ended.length > 0 && (
            <ul className="space-y-2">
              {rules.ended.map((r) => (
                <li key={r.id} className="rounded-lg border border-line px-3 py-2">
                  <p className="truncate text-sm text-fg-muted">{commandRuleLabel(r)}</p>
                  <p className="text-xs text-fg-dim">{ruleDetails(r)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <ChatAutoThresholds onError={setError} />
      <section aria-labelledby="chat-grants-active" className="space-y-2">
        <h2 id="chat-grants-active" className="text-sm font-semibold text-fg">
          {t('Ativas')}
        </h2>
        {active.length === 0 ? (
          <p className="text-sm text-fg-dim">{t('Nenhuma permissão ativa agora.')}</p>
        ) : (
          <ul className="space-y-2">
            {active.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-fg">{title(g)}</p>
                  <p className="text-xs text-fg-dim">{`${grantOriginLabel(g)} · ${typeof g.expires_at === 'string' ? untilLabel(g.expires_at) : t('sem prazo')}`}</p>
                </div>
                <button type="button" className="btn-ghost shrink-0" disabled={revokingId === g.id} onClick={() => void revoke(g.id)}>
                  {t('Revogar')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {folders && folders.length > 0 && (
        <section aria-labelledby="chat-file-grants" className="space-y-2">
          <h2 id="chat-file-grants" className="text-sm font-semibold text-fg">
            {t('Pastas liberadas para mostrar arquivos')}
          </h2>
          <p className="text-xs text-fg-dim">{t('O chat mostra arquivos destas pastas sem pedir confirmação, até você revogar. Chaves, credenciais e arquivos .env nunca saem da máquina.')}</p>
          <ul className="space-y-2">
            {folders.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-fg" title={g.folder}>
                    {g.folder}
                  </p>
                  <p className="text-xs text-fg-dim">{t('em {{machine}} · sem prazo', { machine: g.machine_name })}</p>
                </div>
                <button type="button" className="btn-ghost shrink-0" disabled={revokingId === g.id} onClick={() => void revokeFolder(g.id)}>
                  {t('Revogar')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="chat-grants-history" className="space-y-2">
        <h2 id="chat-grants-history" className="text-sm font-semibold text-fg">
          {t('Histórico')}
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-fg-dim">{t('Nada no histórico ainda.')}</p>
        ) : (
          <ul className="space-y-2">
            {history.map((g) => (
              <li key={g.id} className="rounded-lg border border-line px-3 py-2">
                <p className="truncate text-sm text-fg">{title(g)}</p>
                <p className="text-xs text-fg-dim">{g.ended_at
                    ? t('{{origin}} · {{state}} em {{date}}', { origin: grantOriginLabel(g), state: GRANT_STATE_LABEL[g.state], date: endedAtLabel(g.ended_at) })
                    : `${grantOriginLabel(g)} · ${GRANT_STATE_LABEL[g.state]}`}</p>
              </li>
            ))}
          </ul>
        )}
        {next && (
          <button type="button" className="btn-ghost" disabled={loadingMore} onClick={() => void loadMore()}>
            {t('Carregar mais')}
          </button>
        )}
      </section>
    </div>
  );
}
