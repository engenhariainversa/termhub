// Why a tab's conversation has no history (TER-1091), in the language the app shows. The history is the
// Claude Code (or Codex, TER-1095) transcript of the tab's current session, found through the session id the machine's termhub
// hooks report: without the hooks, or before Claude reports, there is nothing to read. The reason travels
// as a plain string: one a newer server adds reads as the generic "no messages" line.
import { t, tk } from '@/i18n';

export interface EmptyReasonText {
  title: string;
  hint: string;
  /** The label of the button that installs the hooks on the tab's machine, or null when none helps. */
  install: string | null;
}

const TEXT: Record<string, { title: string; hint: string; install: string | null }> = {
  no_hooks: {
    title: tk('Sem histórico: a máquina não tem os hooks do termhub'),
    hint: tk('O histórico desta aba vem do Claude Code, e são os hooks que dizem ao termhub qual sessão ler. Instale os hooks em {{machine}} e reinicie o Claude nesta aba (claude --continue retoma a conversa): a partir daí ela aparece aqui.'),
    install: tk('Instalar hooks'),
  },
  not_reported: {
    title: tk('O Claude desta aba ainda não informou a sessão'),
    hint: tk('O histórico aparece assim que o Claude Code rodar nesta aba com os hooks do termhub. Se ele já estava aberto antes dos hooks, reinicie-o (claude --continue retoma a conversa); se nada mudar, reinstale os hooks em {{machine}}.'),
    install: tk('Reinstalar hooks'),
  },
  transcript_missing: {
    title: tk('O histórico desta sessão não está mais na máquina'),
    hint: tk('O arquivo da conversa do Claude Code não foi encontrado em {{machine}}. A próxima sessão do Claude nesta aba volta a aparecer aqui.'),
    install: null,
  },
  codex_untrusted: {
    title: tk('O Codex ainda não confia nos hooks do termhub'),
    hint: tk('O histórico desta aba vem do Codex, e são os hooks que dizem ao termhub qual sessão ler, mas o Codex só os roda depois que você confia neles. Abra o Codex nesta aba (Ver tela) e escolha "Trust all" em "Hooks need review", ou use /hooks em {{machine}}: a conversa aparece aqui a partir da próxima mensagem.'),
    install: null,
  },
  new_session: {
    title: tk('Nenhuma mensagem nesta sessão ainda'),
    hint: tk('Aqui aparece a sessão atual do Claude nesta aba: uma aba nova, um /clear ou um reinício do Claude começam do zero. Escreva abaixo para falar com o Claude.'),
    install: null,
  },
  no_agent: {
    title: tk('Esta aba é um terminal sem agente'),
    hint: tk('Inicie uma sessão para conversar por aqui. O agente começa nesta aba com a conta padrão do projeto em {{machine}}.'),
    install: null,
  },
};

/** A Codex tab's own wording where Claude Code's would be wrong (TER-1102): the CLI, its commands and its files. */
const CODEX_TEXT: Record<string, { title: string; hint: string; install: string | null }> = {
  no_hooks: {
    title: tk('Sem histórico: a máquina não tem os hooks do termhub'),
    hint: tk('O histórico desta aba vem do Codex, e são os hooks que dizem ao termhub qual sessão ler. Instale os hooks em {{machine}} e reinicie o Codex nesta aba (codex resume retoma a conversa): a partir daí ela aparece aqui.'),
    install: tk('Instalar hooks'),
  },
  not_reported: {
    title: tk('O Codex desta aba ainda não informou a sessão'),
    hint: tk('O histórico aparece assim que o Codex rodar nesta aba com os hooks do termhub. Se ele já estava aberto antes dos hooks, reinicie-o (codex resume retoma a conversa); se nada mudar, reinstale os hooks em {{machine}}.'),
    install: tk('Reinstalar hooks'),
  },
  transcript_missing: {
    title: tk('O histórico desta sessão não está mais na máquina'),
    hint: tk('O arquivo da sessão do Codex não foi encontrado em {{machine}}. A próxima sessão do Codex nesta aba volta a aparecer aqui.'),
    install: null,
  },
  new_session: {
    title: tk('Nenhuma mensagem nesta sessão ainda'),
    hint: tk('Aqui aparece a sessão atual do Codex nesta aba: uma aba nova, um /new ou um reinício do Codex começam do zero. Escreva abaixo para falar com o Codex.'),
    install: null,
  },
};

/** What the empty conversation says for `reason`; the generic line for null or a reason this build does not know. `agent`
 * is the tab's CLI (`TTabSummary.agent`): a Codex tab gets Codex's wording. */
export function emptyReasonText(reason: string | null, machine: string, agent: string | null = null): EmptyReasonText {
  const codex = agent === 'codex';
  const table = codex && reason !== null && Object.prototype.hasOwnProperty.call(CODEX_TEXT, reason) ? CODEX_TEXT : TEXT;
  const entry = reason !== null && Object.prototype.hasOwnProperty.call(table, reason) ? table[reason]! : null;
  if (!entry) return { title: t('Nenhuma mensagem ainda'), hint: codex ? t('Escreva abaixo para falar com o Codex nesta aba.') : t('Escreva abaixo para falar com o Claude nesta aba.'), install: null };
  return { title: t(entry.title), hint: t(entry.hint, { machine }), install: entry.install ? t(entry.install) : null };
}
