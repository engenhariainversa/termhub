import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { choiceClis, choiceModel, cliName, rememberStartedAgent, startAgentPlan, startedAgentLine, type StartedAgent } from '../../lib/tab-chat';
import type { TabAgentChoice, TabAgentOptions } from '../../lib/types';

export interface TabChatStartAgentProps {
  tabId: string;
  /** The agent started in a new tab (this one's pane was busy): show that tab. */
  onOpenOtherTab?: (tabId: string) => void;
  /** The agent started in this tab, with what (TER-1104): the conversation's header says it. */
  onStarted?: (agent: StartedAgent) => void;
}

/**
 * No rule picks the account (TER-1104): the CLI (when there are several), the account of that CLI (when
 * it has several) and the model it starts with, preselected on the project's CLI; nothing starts until
 * the person presses "Iniciar sessão".
 */
function ChooseAgent({ choices, preselected, starting, onStart }: { choices: TabAgentChoice[]; preselected: TabAgentChoice; starting: string | null; onStart: (c: TabAgentChoice) => void }) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState(preselected.account_id);
  const choice = choices.find((c) => c.account_id === picked) ?? preselected;
  const clis = choiceClis(choices);
  const ofCli = choices.filter((c) => c.provider === choice.provider);
  return (
    <div className="flex flex-col items-center gap-2" data-testid="tab-chat-choose-agent">
      <p className="text-xs text-fg-dim">{t('Escolha com qual agente iniciar a sessão:')}</p>
      {clis.length > 1 && (
        <div className="flex gap-1" role="group" aria-label={t('Agente')}>
          {clis.map((cli) => (
            <button
              key={cli}
              type="button"
              aria-pressed={cli === choice.provider}
              className={cli === choice.provider ? 'btn-primary text-sm' : 'btn-ghost text-sm'}
              disabled={starting !== null}
              onClick={() => setPicked(choices.find((c) => c.provider === cli)!.account_id)}
              data-testid={`tab-chat-cli-${cli}`}
            >
              {cliName(cli)}
            </button>
          ))}
        </div>
      )}
      {ofCli.length > 1 ? (
        <label className="flex items-center gap-2 text-xs text-fg-dim">
          {t('Conta')}
          <select className="input max-w-xs text-sm" value={choice.account_id} disabled={starting !== null} onChange={(e) => setPicked(e.target.value)} data-testid="tab-chat-account">
            {ofCli.map((c) => (
              <option key={c.account_id} value={c.account_id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-xs text-fg-dim">{t('Conta {{account}}', { account: choice.label })}</p>
      )}
      <p className="text-xs text-fg-dim">{t('Modelo: {{model}}', { model: choiceModel(choice) })}</p>
      <button type="button" className="btn-primary" disabled={starting !== null} onClick={() => onStart(choice)} data-testid="tab-chat-start-chosen">
        {starting === choice.account_id ? t('Iniciando…') : t('Iniciar sessão')}
      </button>
    </div>
  );
}

/**
 * The conversation of a tab that is a plain terminal (TER-1094): no agent runs there, so there is no
 * session to show. Says so and offers "Iniciar sessão" with the account the server picks (the project's
 * CLI, never another one: TER-1104), or a picker when no rule picks one (a machine with Claude and Codex).
 * Once started it says with what. The conversation shows the session once the agent's hooks report it.
 */
export function TabChatStartAgent({ tabId, onOpenOtherTab, onStarted }: TabChatStartAgentProps) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<TabAgentOptions | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [started, setStarted] = useState<StartedAgent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setOptions(null);
    setStarted(null);
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
        const agent: StartedAgent = { provider: res.provider, account: res.account.label, model: res.model === undefined ? choice.model : res.model };
        rememberStartedAgent(res.tab_id, agent);
        if (res.new_tab) onOpenOtherTab?.(res.tab_id);
        else {
          setStarted(agent);
          onStarted?.(agent);
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('Não foi possível iniciar a sessão. Tente de novo.'));
      } finally {
        setStarting(null);
      }
    },
    [tabId, onOpenOtherTab, onStarted, t],
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
      {started && (
        <p className="text-xs text-fg-muted" data-testid="tab-chat-started-with">
          {startedAgentLine(started)}
        </p>
      )}
      {!started && plan?.kind === 'suggested' && (
        <>
          <button type="button" className="btn-primary" disabled={starting !== null} onClick={() => void start(plan.choice, true)} data-testid="tab-chat-start-agent">
            {starting === plan.choice.account_id ? t('Iniciando…') : t('Iniciar sessão')}
          </button>
          <p className="text-xs text-fg-dim">{t('Com {{account}} ({{cli}}) · modelo {{model}}', { account: plan.choice.label, cli: cliName(plan.choice.provider), model: choiceModel(plan.choice) })}</p>
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
      {!started && plan?.kind === 'choose' && <ChooseAgent choices={plan.choices} preselected={plan.preselected} starting={starting} onStart={(c) => void start(c, false)} />}
      {!started && plan?.kind === 'none' && <p className="text-xs text-fg-dim">{t('Nenhuma conta de IA nesta máquina pode iniciar um agente. Cadastre uma em Contas de IA.')}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
