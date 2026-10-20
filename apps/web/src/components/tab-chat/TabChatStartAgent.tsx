import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { cliName, startAgentPlan } from '../../lib/tab-chat';
import type { TabAgentChoice, TabAgentOptions } from '../../lib/types';

export interface TabChatStartAgentProps {
  tabId: string;
  /** The agent started in a new tab (this one's pane was busy): show that tab. */
  onOpenOtherTab?: (tabId: string) => void;
}

/**
 * The conversation of a tab that is a plain terminal (TER-1094): no agent runs there, so there is no
 * session to show. Says so and offers "Iniciar sessão" with the account the server picks (the project's,
 * else the machine's default), or the list of accounts when no rule picks one (a machine with Claude and
 * Codex). The conversation shows the session once the agent's hooks report it.
 */
export function TabChatStartAgent({ tabId, onOpenOtherTab }: TabChatStartAgentProps) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<TabAgentOptions | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setOptions(null);
    setStarted(false);
    setError(null);
    api.tabChat
      .agentOptions(tabId)
      .then((o) => live && setOptions(o))
      .catch((e: unknown) => live && setError(e instanceof ApiError ? e.message : t('Não foi possível ler as contas de IA.')));
    return () => {
      live = false;
    };
  }, [tabId, t]);

  const start = useCallback(
    async (choice: TabAgentChoice, suggested: boolean) => {
      setStarting(choice.account_id);
      setError(null);
      try {
        // the suggested account goes unnamed: the server applies its own rule, the same the list came from
        const res = await api.tabChat.startAgent(tabId, suggested ? undefined : choice.account_id);
        if (res.new_tab) onOpenOtherTab?.(res.tab_id);
        else setStarted(true);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('Não foi possível iniciar a sessão. Tente de novo.'));
      } finally {
        setStarting(null);
      }
    },
    [tabId, onOpenOtherTab, t],
  );

  const plan = options ? startAgentPlan(options) : null;
  const choiceButton = (c: TabAgentChoice) => (
    <button key={c.account_id} type="button" className="btn-ghost text-sm" disabled={starting !== null} onClick={() => void start(c, false)} data-testid={`tab-chat-start-agent-${c.account_id}`}>
      {starting === c.account_id ? t('Iniciando…') : t('{{account}} ({{cli}})', { account: c.label, cli: cliName(c.provider) })}
    </button>
  );

  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center" data-testid="tab-chat-no-agent">
      <p className="text-sm font-medium text-fg">{t('Esta aba é um terminal sem agente')}</p>
      <p className="text-sm text-fg-dim">
        {started ? t('Sessão iniciada. A conversa aparece aqui assim que o agente responder.') : t('Inicie uma sessão para conversar por aqui.')}
      </p>
      {!started && plan?.kind === 'suggested' && (
        <>
          <button type="button" className="btn-primary" disabled={starting !== null} onClick={() => void start(plan.choice, true)} data-testid="tab-chat-start-agent">
            {starting === plan.choice.account_id ? t('Iniciando…') : t('Iniciar sessão')}
          </button>
          <p className="text-xs text-fg-dim">{t('Com {{account}} ({{cli}})', { account: plan.choice.label, cli: cliName(plan.choice.provider) })}</p>
          {plan.others.length > 0 &&
            (showOthers ? (
              <div className="flex flex-wrap justify-center gap-2">{plan.others.map(choiceButton)}</div>
            ) : (
              <button type="button" className="text-xs text-fg-muted underline" onClick={() => setShowOthers(true)}>
                {t('Escolher outra conta')}
              </button>
            ))}
        </>
      )}
      {!started && plan?.kind === 'choose' && (
        <>
          <p className="text-xs text-fg-dim">{t('Escolha a conta para iniciar a sessão:')}</p>
          <div className="flex flex-wrap justify-center gap-2">{plan.choices.map(choiceButton)}</div>
        </>
      )}
      {!started && plan?.kind === 'none' && <p className="text-xs text-fg-dim">{t('Nenhuma conta de IA nesta máquina pode iniciar um agente. Cadastre uma em Contas de IA.')}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
