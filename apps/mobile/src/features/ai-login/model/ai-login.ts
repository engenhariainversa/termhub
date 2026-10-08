// "Refazer login" of an AI CLI account (TER-1047, spec 2026-10-08): the pure rules the banner and the
// modal share — which accounts need a login, what to call a provider, and every line they show.
import { t } from '@/i18n';
import type { AiLoginStatusRow } from '@/services/api/contract';

/** The providers whose login the app redoes itself (the agent runs `claude auth login` / `codex login`). */
export const LOGIN_PROVIDERS = ['claude', 'chatgpt'] as const;

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', chatgpt: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity' };

/** "Claude", "Codex"…; a provider a newer server adds shows as it comes. */
export const providerLabel = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;

/** The app can run this provider's login flow (the machine may still refuse it: `supported`). */
export const redoesLogin = (provider: string): boolean => (LOGIN_PROVIDERS as readonly string[]).includes(provider);

/** The accounts whose login expired, in the server's order: the red banner names each. */
export const needsLogin = (rows: readonly AiLoginStatusRow[]): AiLoginStatusRow[] => rows.filter((r) => r.state === 'login_required');

/** The route of an account's "Refazer login" modal (the banner, a tapped push, a history row). */
export const aiLoginRoute = (accountId: string): string => `/ai-login/${encodeURIComponent(accountId)}`;

/** The machine's name, or a stand-in when the server no longer knows it. */
export const machineLabel = (row: Pick<AiLoginStatusRow, 'machine_name'>): string => row.machine_name ?? t('uma máquina');

/** Every line of the feature: getters, read in the language the app shows at that moment. */
export const AI_LOGIN_MSG = {
  get title() { return t('Refazer login'); },
  get network() { return t('Não foi possível falar com o servidor. Tente de novo.'); },
  get notFound() { return t('Conta de IA não encontrada.'); },
  get starting() { return t('Abrindo o login na máquina…'); },
  get openPage() { return t('Abrir página de login'); },
  get claudeHint() { return t('Entre na sua conta na página e copie o código que ela mostrar.'); },
  get codeLabel() { return t('Cole o código aqui'); },
  get sendCode() { return t('Enviar código'); },
  get codexHint() { return t('Na página, digite este código e autorize o acesso:'); },
  get authorized() { return t('Já autorizei'); },
  get verifying() { return t('Conferindo o login…'); },
  get done() { return t('Login refeito'); },
  get notResumed() { return t('Nenhuma aba voltou. Elas podem ter saído sozinhas da tela de login.'); },
  get resume() { return t('Retomar'); },
  get later() { return t('Agora não'); },
  get close() { return t('Fechar'); },
  get finish() { return t('Concluir'); },
  get retry() { return t('Tentar de novo'); },
  get refresh() { return t('Atualizar'); },
  get failed() { return t('O login não terminou. Tente de novo.'); },
  get notConfirmed() { return t('O login não foi confirmado.'); },
  get couldNotOpen() { return t('Não deu para abrir o login na máquina.'); },
  get cliOutput() { return t('Saída da CLI'); },
  get finishedOnMachine() { return t('Já entrei pelo navegador da máquina'); },
  get notSupported() { return t('Este login não pode ser refeito pelo app agora: a máquina precisa estar online, com o agente do termhub atualizado.'); },
};

/** "O login do Claude expirou em jarvis". */
export const expiredLine = (row: AiLoginStatusRow): string =>
  t('O login do {{provider}} expirou em {{machine}}', { provider: providerLabel(row.provider), machine: machineLabel(row) });

/** The modal's subtitle: "Claude Pedro · Claude · jarvis". */
export const accountLine = (row: AiLoginStatusRow): string => `${row.label} · ${providerLabel(row.provider)} · ${machineLabel(row)}`;

/** The manual instruction for a provider the app cannot log in itself (Gemini, Antigravity…). */
export const manualLine = (row: AiLoginStatusRow): string =>
  t('O login do {{provider}} é refeito na própria máquina: abra um terminal em {{machine}} e entre de novo no CLI.', { provider: providerLabel(row.provider), machine: machineLabel(row) });

/** "Retomar 2 abas?": the tabs still stuck on the login error. */
export const resumeQuestion = (count: number): string => t('Retomar {{count}} abas?', { count });

/** "2 abas retomadas." */
export const resumedLine = (count: number): string => t('{{count}} abas retomadas.', { count });
