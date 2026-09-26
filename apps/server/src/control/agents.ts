import { isClaudeSessionId, shellQuote } from '@termhub/machine-ops';
import { config } from '../config.js';
import type { AiAccount, AiProvider, Machine, Task } from '../db/repositories/types.js';
import { sendTextToSession } from '../terminal/session-ops.js';
import { ControlError, type ControlContext } from './context.js';
import { openTab } from './terminals.js';

/** Same ceiling as one typed input: the prompt travels as a single command-line argument. */
export const PROMPT_MAX_CHARS = 4000;
const TAB_NAME_MAX = 60;
/** Bytes the shell would read as keystrokes instead of text (tab completion, ^C, ^D, ESC…): only newline is allowed. */
export const CONTROL_CHARS = /[\x00-\x09\x0b-\x1f\x7f]/;

/**
 * The prompt as it will be typed: `\r\n` folded to `\n` (a newline inside the quoted argument only makes the
 * shell show its continuation prompt — the argument stays whole), no other control character, and never a
 * leading `-`, which the CLI would parse as an option — the "no permission-bypass flag, ever" rule must hold
 * for every prompt, not just the ones we build.
 */
export function checkPrompt(prompt: string): string {
  const text = prompt.replace(/\r\n?/g, '\n');
  if (text.length > PROMPT_MAX_CHARS) throw new ControlError('PROMPT_TOO_LONG', `Prompt longo demais: ${text.length} caracteres, máximo ${PROMPT_MAX_CHARS}`);
  if (CONTROL_CHARS.test(text)) throw new ControlError('PROMPT_CONTROL_CHARS', 'O prompt tem caracteres de controle (tab, escape, ^C…) que o terminal leria como teclas; use só texto e quebras de linha');
  if (text.trimStart().startsWith('-')) throw new ControlError('PROMPT_LOOKS_LIKE_FLAG', 'O prompt não pode começar com "-": o CLI leria isso como uma opção. Comece com uma palavra');
  return text;
}

/**
 * How each provider is started (spec §4.4). The prompt goes in as the CLI's own initial-prompt argument,
 * so the session is interactive from the first turn and nothing has to guess when the TUI is "ready".
 * The account is chosen through the CLI's config-dir variable; gemini and antigravity are not wired yet.
 * No permission-bypass flag, ever.
 */
const LAUNCH: Partial<Record<AiProvider, { binary: string; configEnv: string }>> = {
  claude: { binary: 'claude', configEnv: 'CLAUDE_CONFIG_DIR' },
  chatgpt: { binary: 'codex', configEnv: 'CODEX_HOME' },
};

function launcher(provider: AiProvider): { binary: string; configEnv: string } {
  const l = LAUNCH[provider];
  if (!l) throw new ControlError('PROVIDER_UNSUPPORTED', `Iniciar um agente ${provider} ainda não é suportado; por enquanto só claude e chatgpt (Codex)`);
  return l;
}

/**
 * An account's config dir as the machine's shell must read it. A dir of `~` or `~/x` is expanded **there**,
 * never here — the contract the rest of the code already follows (`configDirPrefix`, the hooks' paths), and
 * the form the accounts are stored in. Only the tilde is left outside the quotes; the path itself stays inert.
 * Quoting the tilde as well made the CLI read `~` as a directory name: it started logged out, in its
 * first-run onboarding, and wrote a fresh config into `<project cwd>/~/`.
 */
function configDirArg(dir: string): string {
  if (dir === '~') return '"$HOME"';
  if (dir.startsWith('~/')) return `"$HOME"/${shellQuote(dir.slice(2))}`;
  return shellQuote(dir);
}

/** The exact line typed into the tab; every value goes through `shellQuote`, so nothing in it is interpreted. */
export function launchLine(provider: AiProvider, configDir: string | null, prompt: string): string {
  const { binary, configEnv } = launcher(provider);
  const env = configDir ? `${configEnv}=${configDirArg(configDir)} ` : '';
  return `${env}${binary} ${shellQuote(prompt)}`;
}

/** What the resumed session is told first (spec 2026-09-26 account swap). */
export const RESUME_PROMPT = 'A conta anterior atingiu o limite de uso. Continue a tarefa de onde parou.';

/**
 * The line that resumes a Claude session under another account (spec 2026-09-26 account swap §4.4).
 * The id is a uuid, checked here too: it is the one value of the line that is not quoted.
 */
export function resumeLine(configDir: string | null, sessionId: string, prompt: string): string {
  if (!isClaudeSessionId(sessionId)) throw new ControlError('NO_SESSION', 'A sessão do Claude desta aba não é válida');
  const env = configDir ? `CLAUDE_CONFIG_DIR=${configDirArg(configDir)} ` : '';
  return `${env}claude --resume ${sessionId} ${shellQuote(checkPrompt(prompt))}`;
}

async function accountOnMachine(ctx: ControlContext, accountId: string, machine: Machine): Promise<AiAccount> {
  const { account, machine: home } = await ctx.scoped.aiAccount(accountId);
  if (account.machine_id === machine.id) return account;
  const here = (await ctx.repos.aiAccounts.list(ctx.scope.ownerId)).filter((a) => a.machine_id === machine.id);
  const list = here.length ? here.map((a) => `${a.label} (${a.provider}, ${a.id})`).join(', ') : 'nenhuma';
  throw new ControlError('ACCOUNT_OTHER_MACHINE', `A conta "${account.label}" está na máquina ${home.name}, não em ${machine.name}. Contas em ${machine.name}: ${list}`);
}

export interface StartAgentResult {
  tab_id: string;
  tab_name: string;
  project_id: string;
  tmux_session: string | null;
  tab_url: string;
  /** the binary started (never the prompt) */
  command: string;
  task_id: string | null;
  /** the tab the task was linked to before this call, when there was one (it stays open, unlinked) */
  previous_tab_id: string | null;
  note: string;
}

/**
 * Opens a tab in the project and starts the account's CLI there with the prompt (spec §4.4). Everything
 * that can be checked is checked before the tab exists; once it does, a failure keeps the tab and names it.
 */
export async function startAgent(
  ctx: ControlContext,
  input: { project_id: string; machine_id?: string; account_id: string; prompt: string; task_id?: string; tab_name?: string },
): Promise<StartAgentResult> {
  const prompt = checkPrompt(input.prompt);
  const { project, machine } = await ctx.scoped.projectMachineFor(input.project_id, input.machine_id);
  const account = await accountOnMachine(ctx, input.account_id, machine);
  const { binary } = launcher(account.provider);
  if (!machine.capabilities.includes(binary)) {
    throw new ControlError(
      'TOOL_MISSING',
      `${binary} não foi detectado em ${machine.name} (list_machines mostra o que cada máquina tem). Se está instalado: com agente, atualize o termhub-agent (0.2.3 ou mais novo) e deixe-o reconectar; em máquina local/ssh, abra a lista de máquinas no app para refazer a detecção.`,
    );
  }

  let task: Task | null = null;
  if (input.task_id) {
    if (!(await ctx.can('tasks', 'update'))) throw new ControlError('FORBIDDEN', 'Vincular a tarefa precisa da permissão tasks:update na sua role');
    task = (await ctx.scoped.task(input.task_id)).task;
    if (task.project_id !== project.id) throw new ControlError('TASK_OTHER_PROJECT', `A tarefa "${task.title}" é de outro projeto`);
  }

  const line = launchLine(account.provider, account.config_dir, prompt);
  const name = (input.tab_name?.trim() || task?.title || `${binary} · ${account.label}`).slice(0, TAB_NAME_MAX);
  // openTab does the readiness checks (online, agent version, tab limit) and keeps the tab if the session fails.
  const tab = await openTab(ctx, { project_id: project.id, machine_id: machine.id, name });

  // The line is typed right after `tmux new-session`: the shell may still be starting, but bash and zsh
  // keep typeahead (they never flush the tty on startup), so the text is waiting when the prompt appears.
  const reason = (e: unknown) => (e instanceof Error ? e.message : 'erro desconhecido');
  const keptTab = 'Veja a tela com read_screen ou feche a aba com close_tab.';
  try {
    await sendTextToSession(machine, tab.tmux_session as string, line, true);
  } catch (e) {
    throw new ControlError('LAUNCH_FAILED', `A aba ${tab.tab_id} foi aberta, mas o agente não foi iniciado: ${reason(e)}. ${keptTab}`);
  }
  // which account runs this tab: a later swap must not pick it again (spec 2026-09-26 account swap);
  // best effort, the agent is already running
  await ctx.repos.tabs.setAgentFields(tab.tab_id, { ai_account_id: account.id }).catch(() => undefined);
  if (task) {
    try {
      await ctx.repos.tasks.setTab(task.id, tab.tab_id);
      // a top-level card goes to the project's agent column (else the first doing column) unless it is
      // already in a doing column; a subtask is marked doing
      await ctx.repos.tasks.startWork(task.id);
    } catch (e) {
      throw new ControlError('TASK_LINK_FAILED', `A aba ${tab.tab_id} foi aberta e o agente iniciado, mas a tarefa não foi vinculada: ${reason(e)}. ${keptTab}`);
    }
  }

  return {
    tab_id: tab.tab_id,
    tab_name: tab.name,
    project_id: project.id,
    tmux_session: tab.tmux_session,
    tab_url: `${config.publicUrl}/projects/${project.id}`,
    command: binary,
    task_id: task?.id ?? null,
    previous_tab_id: task?.tab_id ?? null,
    note: 'O agente está subindo com o prompt. Chame wait_for_state para saber quando ele terminar ou perguntar algo, e read_screen para ver a tela.',
  };
}
