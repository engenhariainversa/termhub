import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ChatGrantListItem } from '../lib/types';
import { untilLabel } from './chat/grant-time';
import { endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTabLabel } from './chat/grant-list-text';

const LOAD_FAILED = 'Não foi possível carregar as permissões.';

const title = (g: ChatGrantListItem) => `${grantTabLabel(g)}${g.project_name ? ` · ${g.project_name}` : ''}`;

/**
 * "Abas confiáveis" (spec 2026-09-26 §4.2): what the chat was allowed to type into without asking, in
 * every conversation — the grants in force, with Revogar, and the paged history. Reads on open, after a
 * revoke and on "Carregar mais"; no live updates.
 */
export function ChatGrantsView() {
  const [active, setActive] = useState<ChatGrantListItem[] | null>(null);
  const [history, setHistory] = useState<ChatGrantListItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

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

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setError(null);
    try {
      const h = await api.listChatGrants({ state: 'ended', cursor: next });
      setHistory((prev) => [...(prev ?? []), ...h.grants]);
      setNext(h.next_cursor);
    } catch {
      setError(LOAD_FAILED);
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
        setError(e instanceof ApiError ? e.message : 'Não foi possível revogar a permissão.');
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
        <p className="text-danger">{LOAD_FAILED}</p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          Tentar de novo
        </button>
      </div>
    );
  if (active === null || history === null) return <p className="text-sm text-fg-dim">Carregando…</p>;

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-fg-muted">Abas em que o chat pode digitar sem pedir confirmação. Cada permissão vale para uma conversa, por até 24 horas.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <section aria-labelledby="chat-grants-active" className="space-y-2">
        <h2 id="chat-grants-active" className="text-sm font-semibold text-fg">
          Ativas
        </h2>
        {active.length === 0 ? (
          <p className="text-sm text-fg-dim">Nenhuma aba confiável agora.</p>
        ) : (
          <ul className="space-y-2">
            {active.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-fg">{title(g)}</p>
                  <p className="text-xs text-fg-dim">{`${grantOriginLabel(g)} · ${untilLabel(g.expires_at)}`}</p>
                </div>
                <button type="button" className="btn-ghost shrink-0" disabled={revokingId === g.id} onClick={() => void revoke(g.id)}>
                  Revogar
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="chat-grants-history" className="space-y-2">
        <h2 id="chat-grants-history" className="text-sm font-semibold text-fg">
          Histórico
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-fg-dim">Nada no histórico ainda.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((g) => (
              <li key={g.id} className="rounded-lg border border-line px-3 py-2">
                <p className="truncate text-sm text-fg">{title(g)}</p>
                <p className="text-xs text-fg-dim">{`${grantOriginLabel(g)} · ${GRANT_STATE_LABEL[g.state]}${g.ended_at ? ` em ${endedAtLabel(g.ended_at)}` : ''}`}</p>
              </li>
            ))}
          </ul>
        )}
        {next && (
          <button type="button" className="btn-ghost" disabled={loadingMore} onClick={() => void loadMore()}>
            Carregar mais
          </button>
        )}
      </section>
    </div>
  );
}
