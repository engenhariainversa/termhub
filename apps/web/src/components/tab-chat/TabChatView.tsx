import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { isNearBottom } from '../../lib/chat-scroll';
import { availabilityText, buildRows, canType, modeLabel, stateLine } from '../../lib/tab-chat';
import { useTabChat } from '../../lib/use-tab-chat';
import { DropdownMenu, type MenuItem } from '../DropdownMenu';
import { Modal } from '../Modal';
import { TabQuestionCard } from '../chat/TabQuestionCard';
import { TabSuggestionCard } from '../chat/TabSuggestionCard';
import { TabChatComposer } from './TabChatComposer';
import { TabChatRowView } from './TabChatRows';
import type { TabSuggestion } from '../../lib/types';

export interface TabChatViewProps {
  tabId: string;
  projectId: string;
  machineId: string | null;
  /** On screen (a cell or the tab shown): only then the session is followed. */
  active: boolean;
  /** "Terminal": back to the terminal in this same tab; absent when the conversation has a tab of its own. */
  onShowTerminal?: () => void;
  /** "Abrir ao lado": the conversation in a pane next to its terminal. */
  onOpenBeside?: () => void;
  /** "Abrir em aba própria": offered while the conversation is shown in its terminal's tab. */
  onOpenTab?: () => void;
}

/** "Ver tela": the raw pane as plain text, for what the transcript does not show (a dialog, the footer). */
function ScreenModal({ tabId, open, onClose }: { tabId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setText((await api.tabChat.screen(tabId)).text);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Não foi possível ler a tela.'));
    }
  }, [tabId, t]);
  useEffect(() => {
    if (open) void load();
    else setText(null);
  }, [open, load]);
  return (
    <Modal title={t('Tela do terminal')} open={open} onClose={onClose} width="max-w-4xl">
      <div className="mb-2 flex justify-end">
        <button type="button" className="btn-ghost text-xs" onClick={() => void load()}>
          {t('Atualizar', { context: 'refresh' })}
        </button>
      </div>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {text === null && !error ? (
        <p className="text-sm text-fg-dim">{t('Carregando…')}</p>
      ) : (
        <pre className="overflow-auto whitespace-pre rounded bg-bg p-3 font-mono text-[12px] leading-snug text-fg">{text}</pre>
      )}
    </Modal>
  );
}

/** The card takes `onSend(text)`/`onDismiss()` with no id: the per-card closures are made once per id. */
function SuggestionRow({ suggestion, busy, error, onSend, onDismiss }: { suggestion: TabSuggestion; busy: boolean; error?: string; onSend: (id: string, text: string) => void; onDismiss: (id: string) => void }) {
  const id = suggestion.id;
  const send = useCallback((text: string) => onSend(id, text), [id, onSend]);
  const dismiss = useCallback(() => onDismiss(id), [id, onDismiss]);
  return <TabSuggestionCard suggestion={suggestion} busy={busy} error={error} onSend={send} onDismiss={dismiss} />;
}

/**
 * A Claude Code tab read as a conversation (TER-1003), next to or in place of its terminal: the messages
 * of the session's transcript in Markdown, tool calls folded, subagents, the tab's open questions and
 * permission dialogs with every option (TER-995), and a box that types into the session as the person
 * (TER-851). Live through the tab's socket; nothing is stored anywhere.
 *
 * Scrolling: the list follows new items only while the reader is at the bottom; reading further up, a
 * live item never moves what is on screen, and an earlier page keeps the reader's place (TER-1001).
 */
export function TabChatView({ tabId, projectId, machineId, active, onShowTerminal, onOpenBeside, onOpenTab }: TabChatViewProps) {
  const { t } = useTranslation();
  const chat = useTabChat(tabId, active);
  const [screenOpen, setScreenOpen] = useState(false);
  const working = chat.tab?.state === 'working' && !chat.tab.background;
  const rows = useMemo(() => buildRows(chat.items, working), [chat.items, working]);
  const openQuestions = chat.questions.filter((q) => q.status === 'open' || q.id === chat.answeringQuestionId || chat.questionErrors[q.id]);
  const openSuggestions = chat.suggestions.filter((s) => s.status === 'open' || s.id === chat.busySuggestionId);

  // --- Scroll ---------------------------------------------------------------
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** Distance from the bottom kept while an earlier page is prepended; null otherwise. */
  const keepFromBottom = useRef<number | null>(null);
  const [unseen, setUnseen] = useState(false);
  const lastCount = useRef(0);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (rows.length > lastCount.current) {
      setUnseen(true);
    }
    lastCount.current = rows.length;
  }, [rows, openQuestions.length, openSuggestions.length]);

  const loadEarlier = useCallback(() => {
    const el = listRef.current;
    if (!el || chat.before === null || chat.loadingEarlier) return;
    keepFromBottom.current = el.scrollHeight - el.scrollTop;
    void chat.loadEarlier();
  }, [chat]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottom.current = isNearBottom(el);
    if (atBottom.current) setUnseen(false);
    if (el.scrollTop < 80 && chat.before !== null && !chat.loadingEarlier) loadEarlier();
  };

  const toBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnseen(false);
  };

  const send = useCallback(
    async (text: string) => {
      const ok = await chat.send(text);
      // What the person just sent is what they want to see answered.
      if (ok) atBottom.current = true;
      return ok;
    },
    [chat],
  );

  const loadQuestionScreen = useCallback((id: string) => api.tabQuestionScreen(id), []);

  const menu: MenuItem[] = [
    { kind: 'item', label: t('Limpar conversa (/clear)'), onSelect: () => void chat.act('clear') },
    { kind: 'item', label: t('Compactar (/compact)'), onSelect: () => void chat.act('compact') },
    { kind: 'item', label: t('Alternar modo (Shift+Tab)'), onSelect: () => void chat.act('cycle_mode') },
    { kind: 'separator' },
    { kind: 'item', label: t('Ver tela'), onSelect: () => setScreenOpen(true) },
    ...(onOpenBeside ? [{ kind: 'item' as const, label: t('Abrir ao lado do terminal'), onSelect: onOpenBeside }] : []),
    ...(onOpenTab ? [{ kind: 'item' as const, label: t('Abrir em aba própria'), onSelect: onOpenTab }] : []),
  ];

  const reason = availabilityText(chat.availability);
  const mode = modeLabel(chat.mode);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="tab-chat">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-bg-2 px-3 text-xs">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${chat.connected ? 'bg-ok' : 'bg-fg-dim'}`} title={chat.connected ? t('Ao vivo') : t('Reconectando…')} />
        <span className="min-w-0 truncate text-fg-muted">{chat.tab ? stateLine(chat.tab) : t('Carregando…')}</span>
        <button
          type="button"
          className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-bg-3 hover:text-fg"
          onClick={() => void chat.act('cycle_mode')}
          title={t('Alternar o modo da sessão (Shift+Tab)')}
        >
          {t('Modo: {{mode}}', { mode: mode ?? t('padrão ou desconhecido') })}
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onShowTerminal && (
            <button type="button" className="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-bg-3 hover:text-fg" onClick={onShowTerminal} title={t('Mostrar o terminal nesta aba')}>
              {t('Terminal')}
            </button>
          )}
          <DropdownMenu title={t('Ações da sessão')} items={menu} />
        </div>
      </div>

      {reason && (
        <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          <span>{reason}</span>
          <button type="button" className="underline" onClick={() => setScreenOpen(true)}>
            {t('Ver tela')}
          </button>
        </div>
      )}
      {chat.degraded && <div className="border-b border-line px-3 py-1 text-xs text-fg-dim">{t('Não consegui ler parte do histórico. Use Ver tela.')}</div>}
      {chat.error && (
        <div className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger" role="alert">
          <span>{chat.error}</span>
          <button type="button" className="underline" onClick={chat.clearError}>
            {t('fechar')}
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={listRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden px-4 py-3" onScroll={onScroll}>
          {chat.status === 'loading' ? (
            <p className="py-8 text-center text-sm text-fg-dim">{t('Carregando conversa…')}</p>
          ) : (
            <>
              {chat.before !== null && (
                <div className="mb-2 text-center">
                  <button type="button" className="btn-ghost text-xs" onClick={loadEarlier} disabled={chat.loadingEarlier}>
                    {chat.loadingEarlier ? t('Carregando…') : t('Carregar mensagens anteriores')}
                  </button>
                </div>
              )}
              {rows.length === 0 && chat.status === 'ready' && !reason && <p className="py-8 text-center text-sm text-fg-dim">{t('Nada nesta sessão ainda.')}</p>}
              <ol className="flex flex-col gap-3" aria-label={t('Conversa da aba')}>
                {rows.map((row) => (
                  <TabChatRowView key={row.id} row={row} projectId={projectId} />
                ))}
                {working && (
                  <li className="text-xs text-fg-dim" aria-live="polite">
                    {chat.tab?.activity_verb ? `${chat.tab.activity_verb}…` : t('trabalhando…')}
                  </li>
                )}
              </ol>
              {(openQuestions.length > 0 || openSuggestions.length > 0) && (
                <ul className="mt-3 flex flex-col gap-2">
                  {openQuestions.map((q) => (
                    <TabQuestionCard
                      key={q.id}
                      question={q}
                      answering={chat.answeringQuestionId === q.id}
                      error={chat.questionErrors[q.id] ?? null}
                      onAnswer={chat.answerQuestion}
                      loadScreen={loadQuestionScreen}
                      onCancelAutoAnswer={chat.cancelAutoAnswer}
                    />
                  ))}
                  {openSuggestions.map((s) => (
                    <SuggestionRow key={s.id} suggestion={s} busy={chat.busySuggestionId === s.id} error={chat.suggestionErrors[s.id]} onSend={chat.sendSuggestion} onDismiss={chat.dismissSuggestion} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        {unseen && (
          <button type="button" className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-line bg-bg-2 px-3 py-1 text-xs text-fg shadow" onClick={toBottom}>
            {t('Novas mensagens ↓')}
          </button>
        )}
      </div>

      <TabChatComposer
        tabId={tabId}
        projectId={projectId}
        machineId={machineId}
        onSend={send}
        onInterrupt={working ? () => void chat.act('interrupt') : undefined}
        blockedReason={canType(chat.availability) ? null : t('Máquina offline')}
      />
      <ScreenModal tabId={tabId} open={screenOpen} onClose={() => setScreenOpen(false)} />
    </div>
  );
}
