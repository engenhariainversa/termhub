import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ChatDefault, ChatGrantListItem } from '../lib/types';
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
 * paged history. Reads on open, after a revoke and on "Carregar mais"; no live updates.
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
    api.listChatDefaults().then((r) => setDefaults(r.defaults), () => setDefaults(null));
  }, []);

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
            {t('O chat faz estas ações sem pedir confirmação; leituras nunca pedem. Desmarque para voltar a pedir. Sempre pedem confirmação: apagar card, rodar comando, responder permissões, texto com “!”, as teclas Ctrl+C e Esc, fechar aba trabalhando, integrações e status de ticket.')}
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
